import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database, fixture, request, squareEnv, testToken } from './helpers/database.mjs';
import { onRequestPost as paypalCheckout } from '../functions/api/paypal-checkout.js';
import { onRequestPost as squareCheckout } from '../functions/api/square-checkout.js';
import { onRequestPost as checkPayment } from '../functions/api/square-status.js';
import { paymentSummary } from '../functions/_lib/square.js';
import { fareState, ensureReceipt } from '../functions/_lib/postride.js';
import { prepareTipCheckout } from '../functions/_lib/square-tip.js';

async function setup(t, sandbox = true) {
  const DB = database();
  await fixture(DB);
  const reference = 'QT-TEST000001';
  const env = { ...squareEnv(DB), SQUARE_ENVIRONMENT: 'production', SQUARE_LIVE_PAYMENTS_APPROVED: 'true',
    PAYPAL_CLIENT_ID: 'client', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_ENVIRONMENT: sandbox ? 'sandbox' : 'production',
    PAYPAL_SANDBOX_TEST_QUOTE: sandbox ? reference : '', PAYPAL_LIVE_PAYMENTS_APPROVED: 'true',
    COMMUNICATIONS_ENCRYPTION_KEY: 'a'.repeat(64) };
  const origin = sandbox ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
  const orders = new Map();
  const idempotency = new Map();
  let captures = 0;
  let failAfterCapture = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(new URL(url).origin, origin);
    if (url.endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'mock-token' });
    const header = options.headers['PayPal-Request-Id'];
    const [, orderId, action] = url.split('/checkout/orders')[1].split('/');
    if (options.method === 'POST' && !orderId) {
      assert.ok(header);
      const body = JSON.parse(options.body);
      assert.equal(body.application_context.shipping_preference, 'NO_SHIPPING');
      assert.equal(body.purchase_units[0].amount.currency_code, 'USD');
      assert.equal(JSON.stringify(body).includes('RD-TEST'), false);
      if (idempotency.has(header)) return Response.json(orders.get(idempotency.get(header)));
      const id = 'ORDER-' + (orders.size + 1);
      const order = { ...body, id, status: 'CREATED' };
      orders.set(id, order);
      idempotency.set(header, id);
      return Response.json(order);
    }
    const order = orders.get(orderId);
    assert.ok(order);
    if (action === 'capture') {
      assert.equal(header, 'capture-' + orderId);
      if (order.status !== 'COMPLETED') {
        captures++;
        order.status = 'COMPLETED';
        const unit = order.purchase_units[0];
        unit.payments = { captures: [{ id: 'CAP-' + orderId, status: 'COMPLETED', amount: unit.amount }] };
      }
      if (failAfterCapture) throw new Error('Provider response lost.');
    }
    return Response.json(order);
  });
  const post = (handler, body) => handler({ env, request: request('/api/test', { token: testToken, ...body }) });
  const paypal = body => post(paypalCheckout, { paymentType: 'deposit', ...body });
  const quote = () => DB.prepare('SELECT * FROM ride_quotes WHERE reference = ?').bind(reference).first();
  return { DB, env, reference, post, paypal, quote, orders, captures: () => captures,
    failAfterCapture: () => { failAfterCapture = true; } };
}

test('PayPal and Venmo sandbox use accepted server amounts and produce a verified paid-ride receipt', async t => {
  const s = await setup(t);
  assert.equal((await paymentSummary(s.env, await s.quote())).squareAvailable, false);
  assert.equal((await s.post(squareCheckout, { paymentType: 'deposit' })).status, 409);
  assert.equal((await s.paypal({ action: 'create', paymentType: 'balance', method: 'venmo' })).status, 409);
  const create = () => s.paypal({ action: 'create', method: 'paypal', amount: 1 });
  const responses = await Promise.all([create(), create()]);
  assert.deepEqual(responses.map(r => r.status), [200, 200]);
  const [{ orderId }, repeated] = await Promise.all(responses.map(r => r.json()));
  assert.equal(repeated.orderId, orderId);
  assert.equal(s.orders.size, 1);
  const deposit = s.orders.get(orderId);
  assert.equal(deposit.purchase_units[0].amount.value, '50.01');
  assert.equal((await s.paypal({ action: 'capture', orderId: 'OTHER' })).status, 409);
  assert.equal((await (await s.paypal({ action: 'capture', orderId })).json()).paid, false);
  assert.equal(s.captures(), 0);
  deposit.status = 'APPROVED';
  deposit.payment_source = { paypal: {} };
  s.failAfterCapture();
  assert.equal((await (await s.paypal({ action: 'capture', orderId })).json()).paid, true);
  assert.equal((await (await s.paypal({ action: 'capture', orderId })).json()).paid, true);
  assert.equal(s.captures(), 1);
  assert.equal(await ensureReceipt(s.env, s.reference), null);
  await s.DB.prepare("UPDATE bookings SET status = 'completed'").run();
  const balanceResponse = await s.paypal({ action: 'create', paymentType: 'balance', method: 'venmo' });
  assert.equal(balanceResponse.status, 200);
  const balanceId = (await balanceResponse.json()).orderId;
  const balance = s.orders.get(balanceId);
  assert.equal(balance.purchase_units[0].amount.value, '50.00');
  balance.status = 'APPROVED';
  balance.payment_source = { venmo: {} };
  assert.equal((await (await s.paypal({ action: 'capture', paymentType: 'balance', orderId: balanceId })).json()).paid, true);
  assert.equal((await fareState(s.env, s.reference)).fullyPaid, true);
  assert.ok(await ensureReceipt(s.env, s.reference));
  assert.equal((await paymentSummary(s.env, await s.quote())).balance, 0);
  await assert.rejects(prepareTipCheckout(s.env, s.reference, 2), /sandbox test ride/);
  balance.purchase_units[0].payments.captures[0].status = 'REFUNDED';
  assert.equal((await s.post(checkPayment, {})).status, 200);
  assert.equal((await fareState(s.env, s.reference)).fullyPaid, false);
});

test('PayPal sandbox is enabled only on the designated quote and blocks mismatched captures', async t => {
  const s = await setup(t);
  const { orderId, checkoutKey } = await (await s.paypal({ action: 'create', method: 'venmo' })).json();
  const order = s.orders.get(orderId);
  order.status = 'APPROVED';
  order.payment_source = { paypal: {} };
  assert.equal((await s.paypal({ action: 'capture', orderId })).status, 409);
  order.payment_source = { venmo: {} };
  order.purchase_units[0].amount.value = '0.01';
  assert.equal((await s.paypal({ action: 'capture', orderId })).status, 409);
  assert.equal(s.captures(), 0);
  assert.equal((await s.paypal({ action: 'cancel', checkoutKey: 'different-checkout' })).status, 409);
  assert.equal((await s.paypal({ action: 'cancel', checkoutKey })).status, 200);
  assert.equal((await s.paypal({ action: 'capture', orderId })).status, 409);
  s.env.PAYPAL_SANDBOX_TEST_QUOTE = 'QT-OTHER0000';
  assert.equal((await s.paypal({ action: 'create', method: 'paypal' })).status, 404);
});

test('an existing Square checkout and a reserved PayPal checkout exclude the competing provider', async t => {
  const s = await setup(t, false);
  s.env.PAYPAL_LIVE_PAYMENTS_APPROVED = 'false';
  assert.equal((await s.paypal({ action: 'create', method: 'paypal' })).status, 404);
  s.env.PAYPAL_LIVE_PAYMENTS_APPROVED = 'true';
  await s.DB.prepare(`INSERT INTO square_payments (quote_reference,booking_reference,payment_type,amount_cents,
    status,square_environment,checkout_key,created_at,updated_at)
    VALUES (?,'RD-TEST000001','deposit',5001,'pending','production','square-key','now','now')`).bind(s.reference).run();
  assert.equal((await s.paypal({ action: 'create', method: 'paypal' })).status, 409);
  assert.equal(s.orders.size, 0);
  await s.DB.prepare('DELETE FROM square_payments').run();
  assert.equal((await s.paypal({ action: 'create', method: 'paypal' })).status, 200);
  assert.equal((await s.post(squareCheckout, { paymentType: 'deposit' })).status, 409);
  assert.equal((await paymentSummary(s.env, await s.quote())).canPayDeposit, false);
});
