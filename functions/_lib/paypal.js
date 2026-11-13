import { fareEnvironment, isPayPalPayment, paypalConfig } from './paypal-config.js';
import { squareConfig } from './square.js';

const problem = (message, status = 409) => Object.assign(new Error(message), { status });
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const paymentRow = (env, reference, type) => env.DB.prepare(`
  SELECT p.*, c.method, c.order_id, c.capture_id, c.capture_started_at
  FROM square_payments p JOIN paypal_checkouts c ON c.payment_id = p.id
  WHERE p.quote_reference = ? AND p.payment_type = ? AND p.checkout_key LIKE 'mvbri-paypal-%'
`).bind(reference, type).first();

async function paypalApi(env, config) {
  const response = await fetch(config.origin + '/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(config.clientId + ':' + env.PAYPAL_CLIENT_SECRET),
      'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(10000)
  });
  const auth = await response.json();
  if (!response.ok || !auth.access_token) throw problem('PayPal is temporarily unavailable.', 503);
  return async (path, body, requestId) => {
    const response = await fetch(config.origin + '/v2/checkout/orders' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + auth.access_token, 'Content-Type': 'application/json',
        Prefer: 'return=representation', ...(requestId ? { 'PayPal-Request-Id': requestId } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) throw problem('PayPal could not confirm the payment. Check payment status before trying again.', 502);
    return response.json();
  };
}

function amountFor(quote, type) {
  if (!quote || quote.status !== 'accepted' || ['cancelled', 'declined'].includes(quote.booking_status) ||
      !Number.isSafeInteger(quote.final_fare_cents) || quote.final_fare_cents < 2 ||
      (type === 'balance' && quote.booking_status !== 'completed')) {
    throw problem('An active accepted quote is required. The balance is payable after the ride.');
  }
  const deposit = Math.round(quote.final_fare_cents / 2);
  return type === 'deposit' ? deposit : quote.final_fare_cents - deposit;
}

function money(cents) {
  return { currency_code: 'USD', value: (cents / 100).toFixed(2) };
}

export async function createPayPalOrder(env, quote, type, method) {
  const config = paypalConfig(env, quote.reference);
  if (!config || fareEnvironment(env, quote.reference, squareConfig(env)) !== config.mode) {
    throw problem('PayPal and Venmo are unavailable for this quote.', 503);
  }
  const amount = amountFor(quote, type);
  const key = 'mvbri-paypal-' + crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`
      INSERT OR IGNORE INTO square_payments
        (quote_reference, booking_reference, payment_type, amount_cents, currency, status, square_environment,
         checkout_key, created_at, updated_at)
      SELECT q.reference, b.reference, ?, ?, 'USD', 'pending', ?, ?, ?, ?
      FROM ride_quotes q JOIN bookings b ON b.reference = q.booking_reference
      WHERE q.reference = ? AND q.status = 'accepted' AND q.final_fare_cents = ?
        AND b.status NOT IN ('cancelled', 'declined')
        AND (? = 'deposit' OR (b.status = 'completed' AND EXISTS (
          SELECT 1 FROM square_payments d LEFT JOIN paypal_checkouts c ON c.payment_id = d.id
          WHERE d.quote_reference = q.reference AND d.payment_type = 'deposit'
            AND d.status = 'paid' AND d.amount_cents = ? AND d.currency = 'USD' AND d.square_environment = ?
            AND (d.square_payment_id IS NOT NULL OR c.capture_id IS NOT NULL)
        )))
    `).bind(type, amount, config.mode, key, now, now, quote.reference,
      quote.final_fare_cents, type, Math.round(quote.final_fare_cents / 2), config.mode),
    env.DB.prepare(`
      INSERT INTO paypal_checkouts (payment_id, method)
      SELECT id, ? FROM square_payments WHERE quote_reference = ? AND payment_type = ? AND checkout_key = ?
    `).bind(method, quote.reference, type, key)
  ]);
  const row = await paymentRow(env, quote.reference, type);
  if (!row || row.status !== 'pending' || row.square_environment !== config.mode || row.amount_cents !== amount ||
      row.method !== method || row.capture_started_at) {
    throw problem('Use the existing checkout or check payment status before paying again.');
  }
  if (row.order_id) return { orderId: row.order_id, checkoutKey: row.checkout_key };
  // A lost creation response can only be replayed within PayPal's Orders idempotency window.
  if (Date.now() - Date.parse(row.created_at) >= 5 * 60 * 60 * 1000) {
    throw problem('This checkout has expired. Cancel it before starting a new one.');
  }
  const api = await paypalApi(env, config);
  const order = await api('', {
    intent: 'CAPTURE',
    purchase_units: [{
      custom_id: row.checkout_key,
      description: type === 'deposit' ? 'MVBRI Ride Deposit' : 'MVBRI Ride Balance',
      amount: money(amount)
    }],
    application_context: { shipping_preference: 'NO_SHIPPING' }
  }, row.checkout_key.slice('mvbri-paypal-'.length));
  if (!validId(order.id)) throw problem('PayPal could not prepare this checkout.', 502);
  await env.DB.prepare(`UPDATE paypal_checkouts SET order_id = ?
    WHERE payment_id = ? AND order_id IS NULL`).bind(order.id, row.id).run();
  const saved = await paymentRow(env, quote.reference, type);
  if (saved?.id !== row.id || saved.order_id !== order.id || saved.status !== 'pending') {
    throw problem('The checkout changed. Reload your quote.');
  }
  return { orderId: order.id, checkoutKey: row.checkout_key };
}

export async function cancelPayPalOrder(env, quote, type, checkoutKey) {
  const row = await paymentRow(env, quote.reference, type);
  if (!row) return;
  if (row.checkout_key !== checkoutKey) throw problem('The checkout changed. Reload your quote.');
  const deleted = await env.DB.prepare(`
    DELETE FROM square_payments WHERE id = ? AND status = 'pending'
      AND EXISTS (SELECT 1 FROM paypal_checkouts WHERE payment_id = ? AND capture_started_at IS NULL)
  `).bind(row.id, row.id).run();
  if (!deleted.meta?.changes) throw problem('A payment is being checked. Check payment status before trying again.');
}

function verifiedOrder(order, row) {
  const unit = order.purchase_units?.[0];
  const expected = money(row.amount_cents);
  if (order.id !== row.order_id || order.intent !== 'CAPTURE' || order.purchase_units?.length !== 1 ||
      unit?.custom_id !== row.checkout_key || unit.amount?.currency_code !== expected.currency_code ||
      unit.amount?.value !== expected.value) {
    throw problem('The PayPal order does not match this ride. Contact MVBRI.');
  }
  return unit;
}

async function recordCapture(env, order, row) {
  const unit = verifiedOrder(order, row);
  const captures = unit.payments?.captures || [];
  if (!captures.length) return false;
  const [capture] = captures;
  const expected = money(row.amount_cents);
  if (captures.length !== 1 || !validId(capture.id) || capture.amount?.value !== expected.value ||
      capture.amount?.currency_code !== expected.currency_code || (row.capture_id && row.capture_id !== capture.id)) {
    throw problem('The PayPal payment needs owner review before another payment.');
  }
  if (capture.status === 'PENDING') return false;
  const status = ['REFUNDED', 'PARTIALLY_REFUNDED'].includes(capture.status) ? 'refunded' :
    order.status === 'COMPLETED' && capture.status === 'COMPLETED' ? 'paid' :
    ['DECLINED', 'FAILED'].includes(capture.status) ? 'failed' : null;
  if (!status) throw problem('The PayPal payment needs owner review before another payment.');
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE paypal_checkouts SET capture_id = ?
      WHERE payment_id = ? AND order_id = ? AND (capture_id IS NULL OR capture_id = ?)`)
      .bind(capture.id, row.id, row.order_id, capture.id),
    env.DB.prepare(`UPDATE square_payments SET status = ?, paid_at = CASE WHEN ? = 'paid' THEN COALESCE(paid_at, ?) ELSE paid_at END,
      updated_at = ? WHERE id = ? AND status IN ('pending', 'paid')
      AND EXISTS (SELECT 1 FROM paypal_checkouts WHERE payment_id = ? AND capture_id = ?)`)
      .bind(status, status, now, now, row.id, row.id, capture.id)
  ]);
  return status === 'paid';
}

export async function capturePayPalOrder(env, quote, type, orderId) {
  const config = paypalConfig(env, quote.reference);
  if (!config || fareEnvironment(env, quote.reference, squareConfig(env)) !== config.mode) {
    throw problem('PayPal and Venmo are unavailable for this quote.', 503);
  }
  const amount = amountFor(quote, type);
  const row = await paymentRow(env, quote.reference, type);
  if (!validId(orderId) || row?.order_id !== orderId || row.amount_cents !== amount ||
      row.square_environment !== config.mode || !['pending', 'paid'].includes(row.status)) {
    throw problem('This order does not match the active checkout.');
  }
  const api = await paypalApi(env, config);
  let order = await api('/' + orderId);
  const unit = verifiedOrder(order, row);
  if (unit.payments?.captures?.length) return recordCapture(env, order, row);
  if (row.status !== 'pending' || order.status !== 'APPROVED') return false;
  if (order.payment_source && !order.payment_source[row.method]) {
    throw problem('The approved payment method does not match this checkout.');
  }
  const claim = await env.DB.prepare(`
    UPDATE paypal_checkouts SET capture_started_at = COALESCE(capture_started_at, ?)
    WHERE payment_id = ? AND order_id = ? AND EXISTS (
      SELECT 1 FROM square_payments p JOIN ride_quotes q ON q.reference = p.quote_reference
      JOIN bookings b ON b.reference = q.booking_reference
      WHERE p.id = ? AND p.status IN ('pending','paid') AND q.status = 'accepted' AND q.final_fare_cents = ?
        AND b.status NOT IN ('cancelled','declined')
        AND (p.payment_type = 'deposit' OR (b.status = 'completed' AND EXISTS (
          SELECT 1 FROM square_payments d LEFT JOIN paypal_checkouts c ON c.payment_id = d.id
          WHERE d.quote_reference = q.reference AND d.payment_type = 'deposit'
            AND d.status = 'paid' AND d.amount_cents = ? AND d.currency = 'USD' AND d.square_environment = ?
            AND (d.square_payment_id IS NOT NULL OR c.capture_id IS NOT NULL)
        )))
    )
  `).bind(new Date().toISOString(), row.id, orderId, row.id, quote.final_fare_cents,
    Math.round(quote.final_fare_cents / 2), config.mode).run();
  if (!claim.meta?.changes) throw problem('The ride or checkout changed. Reload the quote before paying.');
  try {
    await api('/' + orderId + '/capture', {}, 'capture-' + orderId);
  } catch (error) {
    order = await api('/' + orderId);
    if (!order.purchase_units?.[0]?.payments?.captures?.length) throw error;
    return recordCapture(env, order, row);
  }
  order = await api('/' + orderId);
  return recordCapture(env, order, row);
}

export async function verifyPayPalPayments(env, quote, type) {
  const config = paypalConfig(env, quote.reference);
  if (!config || fareEnvironment(env, quote.reference, squareConfig(env)) !== config.mode) return 0;
  const rows = (await env.DB.prepare(`
    SELECT p.*, c.order_id, c.capture_id
    FROM square_payments p JOIN paypal_checkouts c ON c.payment_id = p.id
    WHERE p.quote_reference = ? AND p.square_environment = ? AND p.status IN ('pending', 'paid')
      AND c.order_id IS NOT NULL AND c.capture_started_at IS NOT NULL AND (? IS NULL OR p.payment_type = ?)
  `).bind(quote.reference, config.mode, type ?? null, type ?? null).all()).results;
  if (!rows.length) return 0;
  const api = await paypalApi(env, config);
  let verified = 0;
  for (const row of rows) {
    if (isPayPalPayment(row) && validId(row.order_id) &&
        (row.payment_type !== 'balance' || quote.booking_status === 'completed') &&
        row.amount_cents === amountFor(quote, row.payment_type)) {
      const order = await api('/' + row.order_id);
      if (row.status === 'pending' && order.status === 'APPROVED' && !order.purchase_units?.[0]?.payments?.captures?.length) {
        if (await capturePayPalOrder(env, quote, row.payment_type, row.order_id)) verified++;
      } else if (await recordCapture(env, order, row)) verified++;
    }
  }
  return verified;
}
