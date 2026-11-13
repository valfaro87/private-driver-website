import { json, sameOrigin, sha256Hex } from '../_lib/auth.js';
import { wakeCommunications } from '../_lib/communications.js';
import { paypalConfig } from '../_lib/paypal-config.js';
import { cancelPayPalOrder, capturePayPalOrder, createPayPalOrder } from '../_lib/paypal.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!sameOrigin(request)) return json({ error: 'Request rejected.' }, 403);
  if (!env.DB) return json({ error: 'Checkout unavailable.' }, 503);
  if (!(request.headers.get('content-type') || '').includes('application/json')) {
    return json({ error: 'JSON required.' }, 415);
  }
  let body;
  try {
    const raw = await request.text();
    if (raw.length > 2048) return json({ error: 'Request too large.' }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'Invalid checkout request.' }, 400);
  }
  const { token, action, paymentType, method, orderId, checkoutKey } = body || {};
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token) ||
      !['create', 'capture', 'cancel'].includes(action) || !['deposit', 'balance'].includes(paymentType) ||
      (action === 'create' && !['paypal', 'venmo'].includes(method))) {
    return json({ error: 'Invalid checkout request.' }, 400);
  }
  try {
    const quote = await env.DB.prepare(`
      SELECT q.reference, q.status, q.final_fare_cents, b.status AS booking_status
      FROM ride_quotes q JOIN bookings b ON b.reference = q.booking_reference
      WHERE q.customer_token_hash = ?
    `).bind(await sha256Hex(token.toLowerCase())).first();
    if (!quote || !paypalConfig(env, quote.reference)) return json({ error: 'Checkout unavailable.' }, 404);
    if (action === 'create') return json(await createPayPalOrder(env, quote, paymentType, method));
    if (action === 'cancel') {
      await cancelPayPalOrder(env, quote, paymentType, checkoutKey);
      return json({ ok: true });
    }
    const paid = await capturePayPalOrder(env, quote, paymentType, orderId);
    if (paid) await wakeCommunications(context);
    return json({ paid });
  } catch (error) {
    return json({ error: error.status ? error.message : 'PayPal checkout is unavailable. Check payment status before trying again.' },
      error.status || 503);
  }
}
