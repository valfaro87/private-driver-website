import { json, sameOrigin, sha256Hex } from '../_lib/auth.js';
import { squareConfig, paymentSummary } from '../_lib/square.js';
import {verifyQuotePayments} from '../_lib/square-reconcile.js';
import {wakeCommunications} from '../_lib/communications.js';

// Customer-initiated verification works behind Cloudflare Access without making
// a webhook URL public. A redirect or client-supplied status is never proof of payment.
export async function onRequestPost(context) {
  const {request,env}=context;
  if (!sameOrigin(request)) return json({error:'Request rejected.'},403);
  const config=squareConfig(env);
  if (!env.DB || !config) return json({error:'Payment verification is not configured.'},503);
  if (!(request.headers.get('content-type') || '').includes('application/json')) return json({error:'JSON required.'},415);
  let body;
  try {
    const raw=await request.text();
    if(new TextEncoder().encode(raw).length>2048)return json({error:'Request too large.'},413);
    body=JSON.parse(raw);
  } catch {return json({error:'Invalid request.'},400);}
  if(typeof body?.token!=='string' || !/^[a-f0-9]{64}$/i.test(body.token))return json({error:'Invalid quote link.'},400);
  try {
    const quote=await env.DB.prepare(`SELECT q.reference,q.booking_reference,q.status,q.final_fare_cents,
      b.status AS booking_status FROM ride_quotes q JOIN bookings b ON b.reference=q.booking_reference
      WHERE q.customer_token_hash=? LIMIT 1`).bind(await sha256Hex(body.token.toLowerCase())).first();
    if(!quote || quote.status!=='accepted' || ['cancelled','declined'].includes(quote.booking_status)) {
      return json({error:'An active accepted quote is required.'},409);
    }
    if(!Number.isSafeInteger(quote.final_fare_cents) || quote.final_fare_cents<2)return json({error:'Invalid quote amount.'},409);
    const verified=await verifyQuotePayments(env,quote);
    await wakeCommunications(context);
    return json({ok:true,verified,payments:await paymentSummary(env,quote)});
  } catch {return json({error:'Unable to verify payment right now. Please try again later.'},502);}
}
