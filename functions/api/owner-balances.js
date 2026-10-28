import { json, ownerSession, sameOrigin } from '../_lib/auth.js';
import { paymentSummary, squareConfig } from '../_lib/square.js';
import { isInvoiceBalance, prepareBalanceInvoice, reconcileBalanceInvoice } from '../_lib/square-balance.js';

async function authorized(request,env) {
  if (!env.DB || !squareConfig(env)) return json({error:'Balance payments are not configured.'},503);
  if (!await ownerSession(request,env)) return json({error:'Please sign in as the owner.'},401);
}

export async function onRequestGet({request,env}) {
  const rejected = await authorized(request,env); if(rejected)return rejected;
  try {
    const quotes = (await env.DB.prepare(`SELECT q.reference,q.booking_reference,q.status,q.final_fare_cents,
      b.name,b.status AS booking_status FROM ride_quotes q JOIN bookings b ON b.reference=q.booking_reference
      WHERE q.status='accepted' ORDER BY q.created_at DESC LIMIT 500`).all()).results || [];
    const balances = [];
    for(const quote of quotes) {
      const payments = await paymentSummary(env,quote);
      if(!payments.enabled)continue;
      balances.push({reference:quote.reference,bookingReference:quote.booking_reference,name:quote.name,
        tripCompleted:quote.booking_status==='completed',invoiceNumber:quote.reference+'-BAL',payments});
    }
    return json({balances});
  } catch {return json({error:'Unable to load remaining balances.'},503);}
}

export async function onRequestPost({request,env}) {
  if(!sameOrigin(request))return json({error:'Request rejected.'},403);
  const rejected = await authorized(request,env); if(rejected)return rejected;
  if(!(request.headers.get('content-type')||'').includes('application/json'))return json({error:'JSON required.'},415);
  let body;
  try {
    const raw=await request.text();
    if(new TextEncoder().encode(raw).length>2048)return json({error:'Request too large.'},413);
    body=JSON.parse(raw);
  } catch{return json({error:'Invalid request.'},400);}
  if(!['prepare','check'].includes(body?.action) || typeof body.reference!=='string' ||
      !/^QT-[A-Z0-9]{8,32}$/.test(body.reference))return json({error:'Choose a valid quote and action.'},400);
  try {
    const quote=await env.DB.prepare(`SELECT q.reference,q.booking_reference,q.status,q.final_fare_cents,
      b.status AS booking_status,b.name AS customer_name,b.email AS customer_email FROM ride_quotes q
      JOIN bookings b ON b.reference=q.booking_reference WHERE q.reference=?`).bind(body.reference).first();
    if(!quote || quote.status!=='accepted' || ['cancelled','declined'].includes(quote.booking_status)) {
      return json({error:'An active accepted quote is required.'},409);
    }
    if(body.action==='prepare')return json(await prepareBalanceInvoice(env,quote,'reader'));
    const record=await env.DB.prepare(`SELECT * FROM square_payments WHERE quote_reference=? AND payment_type='balance'`)
      .bind(quote.reference).first();
    if(record && isInvoiceBalance(record))await reconcileBalanceInvoice(env,record);
    return json({ok:true,payments:await paymentSummary(env,quote)});
  } catch(error) {
    return json({error:error.status ? error.message : 'Unable to prepare or verify the remaining balance.'},error.status || 503);
  }
}
