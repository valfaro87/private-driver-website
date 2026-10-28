import { json, sameOrigin, sha256Hex } from '../_lib/auth.js';
import { squareConfig, validCheckoutUrl } from '../_lib/square.js';
import { isInvoiceBalance, prepareBalanceInvoice } from '../_lib/square-balance.js';

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ error: 'Request rejected.' }, 403);
  const config = squareConfig(env);
  if (!env.DB || !config) return json({ error: 'Secure payment collection is not configured.' }, 503);
  if (!(request.headers.get('content-type') || '').includes('application/json')) {
    return json({ error: 'JSON required.' }, 415);
  }
  let body;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > 2048) return json({error:'Request too large.'},413);
    body = JSON.parse(raw);
  } catch { return json({ error: 'Invalid request.' }, 400); }
  const type = body?.paymentType;
  if (!['deposit', 'balance'].includes(type) || typeof body?.token !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(body.token)) return json({ error: 'Invalid payment request.' }, 400);
  try {
    const hash = await sha256Hex(body.token.toLowerCase());
    const quote = await env.DB.prepare(`SELECT q.reference, q.booking_reference, q.status,
      q.final_fare_cents, b.status AS booking_status, b.name AS customer_name,
      b.email AS customer_email FROM ride_quotes q
      JOIN bookings b ON b.reference = q.booking_reference WHERE q.customer_token_hash = ? LIMIT 1`)
      .bind(hash).first();
    if (!quote || quote.status !== 'accepted' || ['cancelled','declined'].includes(quote.booking_status)) {
      return json({ error: 'An active accepted quote is required.' }, 409);
    }
    const total = quote.final_fare_cents;
    if (!Number.isSafeInteger(total) || total < 2) return json({ error: 'Invalid quote amount.' }, 400);
    const deposit = Math.round(total / 2);
    if (type === 'balance') {
      const paid = await env.DB.prepare(`SELECT status, amount_cents, square_environment
        FROM square_payments WHERE quote_reference = ? AND payment_type = 'deposit'`).bind(quote.reference).first();
      if (quote.booking_status !== 'completed' || paid?.status !== 'paid' ||
          paid.amount_cents !== deposit || paid.square_environment !== config.mode) {
        return json({error:'The verified deposit and completed ride are required before balance payment.'},409);
      }
      const method = body.collectionMethod ?? 'online';
      if (!['online','reader'].includes(method)) return json({error:'Invalid balance payment method.'},400);
      const existing = await env.DB.prepare(`SELECT * FROM square_payments
        WHERE quote_reference=? AND payment_type='balance'`).bind(quote.reference).first();
      if (!existing || isInvoiceBalance(existing)) {
        try { return json(await prepareBalanceInvoice(env,quote,method)); }
        catch (error) { return json({error:error.status ? error.message :
          'Unable to prepare the balance invoice. Please retry safely.'},error.status || 503); }
      }
      if (method === 'reader') return json({error:'This ride already has an online balance checkout. Use that existing checkout; do not create a separate reader charge.'},409);
    }
    const amount = type === 'deposit' ? deposit : total - deposit;
    const now = new Date().toISOString();
    const checkoutKey = `mvbri-v2-${type}-${quote.reference}`;
    const payload = JSON.stringify({
      idempotency_key: checkoutKey,
      quick_pay: { name: type === 'deposit' ? 'MVBRI Ride Deposit' : 'MVBRI Ride Balance',
        price_money: {amount, currency:'USD'}, location_id: env.SQUARE_LOCATION_ID },
      checkout_options: { allow_tipping: false, ask_for_shipping_address: false,
        accepted_payment_methods: {apple_pay:config.mode === 'production',
          google_pay:config.mode === 'production', cash_app_pay:config.mode === 'production', afterpay_clearpay:false} }
    });
    await env.DB.prepare(`INSERT OR IGNORE INTO square_payments
      (quote_reference,booking_reference,payment_type,amount_cents,currency,status,square_environment,
       created_at,updated_at,checkout_key,checkout_request) VALUES (?,?,?,?,'USD','pending',?,?,?,?,?)`)
      .bind(quote.reference,quote.booking_reference,type,amount,config.mode,now,now,checkoutKey,payload).run();
    const load = () => env.DB.prepare(`SELECT * FROM square_payments WHERE quote_reference = ? AND payment_type = ?`)
      .bind(quote.reference,type).first();
    const record = await load();
    if (!record || record.amount_cents !== amount || record.currency !== 'USD' || record.square_environment !== config.mode) {
      return json({error:'Payment record does not match this quote. Please contact MVBRI.'},409);
    }
    if (record.status !== 'pending') return json({error:record.status === 'paid' ? 'This payment is already verified.' : 'This payment requires owner review.'},409);
    if (record.checkout_url) {
      if (!record.square_order_id || !record.square_payment_link_id || !validCheckoutUrl(record.checkout_url,config.mode)) {
        return json({error:'Checkout requires owner review.'},409);
      }
      return json({checkoutUrl:record.checkout_url,environment:config.mode});
    }
    if (!record.checkout_key || !record.checkout_request || record.square_order_id || record.square_payment_link_id) {
      return json({error:'An earlier checkout needs owner verification before retrying.'},409);
    }
    const savedRequest = JSON.parse(record.checkout_request);
    if (savedRequest.idempotency_key !== record.checkout_key ||
        savedRequest.quick_pay?.location_id !== env.SQUARE_LOCATION_ID ||
        savedRequest.quick_pay?.price_money?.amount !== amount ||
        savedRequest.quick_pay?.price_money?.currency !== 'USD') {
      return json({error:'Saved checkout configuration requires owner review.'},409);
    }
    // Retry the exact saved request and key. Square deduplicates ambiguous failures
    // and concurrent clicks; a browser can never choose the amount or location.
    const response = await fetch(config.origin + '/v2/online-checkout/payment-links', {
      method:'POST', headers:{Authorization:`Bearer ${env.SQUARE_ACCESS_TOKEN}`,
        'Content-Type':'application/json','Square-Version':'2026-09-16'},
      body:record.checkout_request, signal:AbortSignal.timeout(15000)
    });
    const data = await response.json();
    const link = data.payment_link;
    if (!response.ok || !link?.id || !link.order_id || !validCheckoutUrl(link.url,config.mode)) {
      console.error('Square checkout failed', response.status, data.errors?.[0]?.code || 'INVALID_RESPONSE');
      return json({error:'Checkout is temporarily unavailable. Retry safely or contact MVBRI.'},502);
    }
    const saved = await env.DB.prepare(`UPDATE square_payments SET square_payment_link_id = ?,
      square_order_id = ?, checkout_url = ?, updated_at = ? WHERE id = ? AND status = 'pending'
      AND square_order_id IS NULL AND square_payment_link_id IS NULL AND checkout_url IS NULL`)
      .bind(link.id,link.order_id,link.url,new Date().toISOString(),record.id).run();
    if (saved.meta?.changes !== 1) {
      const latest = await load();
      if (latest?.status !== 'pending' || latest.square_order_id !== link.order_id || latest.checkout_url !== link.url) {
        return json({error:'Checkout status changed. Refresh your quote before paying.'},409);
      }
    }
    return json({checkoutUrl:link.url,environment:config.mode});
  } catch {
    return json({error:'Unable to prepare checkout. You may retry safely.'},503);
  }
}
