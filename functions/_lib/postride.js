import {squareConfig} from './square.js';
import {hasCommunicationsKey,linkToken,equalText} from './communications-crypto.js';

export async function fareState(env,reference){
 const config=squareConfig(env);if(!config)return null;
 const q=await env.DB.prepare(`SELECT q.reference,q.booking_reference,q.status,q.final_fare_cents,b.status AS booking_status,b.pickup_date FROM ride_quotes q JOIN bookings b ON b.reference=q.booking_reference WHERE q.reference=?`).bind(reference).first();
 if(!q||q.status!=='accepted'||!Number.isSafeInteger(q.final_fare_cents)||q.final_fare_cents<2)return null;
 const rows=(await env.DB.prepare(`SELECT p.*,i.verified_amount_cents,i.review_required FROM square_payments p LEFT JOIN square_balance_invoices i ON i.payment_id=p.id WHERE p.quote_reference=?`).bind(reference).all()).results||[];
 const deposit=Math.round(q.final_fare_cents/2),balance=q.final_fare_cents-deposit;
 const verified=(type,amount)=>rows.find(r=>r.payment_type===type&&r.status==='paid'&&r.currency==='USD'&&r.square_environment===config.mode&&r.amount_cents===amount&&!!r.square_payment_id&&(!r.checkout_key?.startsWith('mvbri-invoice-balance-')||(!r.review_required&&r.verified_amount_cents===amount)));
 const dp=verified('deposit',deposit),bp=verified('balance',balance);
 return {...q,depositCents:deposit,balanceCents:balance,depositPaid:!!dp,fullyPaid:!!dp&&!!bp&&q.booking_status==='completed',paidAt:bp?.paid_at,environment:config.mode};
}
export async function ensureReceipt(env,reference){
 if(!hasCommunicationsKey(env))return null;
 const fare=await fareState(env,reference);if(!fare?.fullyPaid)return null;
 await env.DB.prepare(`INSERT OR IGNORE INTO postride_receipts(quote_reference,booking_reference,nonce,created_at) VALUES (?,?,?,?)`).bind(reference,fare.booking_reference,crypto.randomUUID(),new Date().toISOString()).run();
 return env.DB.prepare('SELECT * FROM postride_receipts WHERE quote_reference=?').bind(reference).first();
}
export async function receiptLinks(env,record,origin){
 const token=await linkToken(env,'postride',record.quote_reference+':'+record.nonce);
 const suffix='?ref='+encodeURIComponent(record.quote_reference)+'&token='+token;
 return {receiptUrl:origin+'/receipt.html'+suffix,tipUrl:origin+'/tip.html'+suffix};
}
export async function authorizedReceipt(env,reference,token){
 if(!hasCommunicationsKey(env)||!/^QT-[A-Z0-9]{8,32}$/.test(reference||'')||!/^[a-f0-9]{64}$/i.test(token||''))return null;
 const record=await env.DB.prepare('SELECT * FROM postride_receipts WHERE quote_reference=?').bind(reference).first();
 if(!record||!equalText(token,await linkToken(env,'postride',record.quote_reference+':'+record.nonce)))return null;
 const fare=await fareState(env,reference);if(!fare?.fullyPaid)return null;
 return {record,fare};
}
// Only bookings with an explicit selected channel enter this scan. No historical opt-in.
export async function queuePaymentNotices(env,notificationStatement,origin,limit=20){
 if(!hasCommunicationsKey(env)||!squareConfig(env))return;
 const mode=squareConfig(env).mode;
 const rows=(await env.DB.prepare(`SELECT q.reference FROM ride_quotes q JOIN bookings b ON b.reference=q.booking_reference JOIN booking_contact_preferences p ON p.booking_reference=q.booking_reference JOIN square_payments d ON d.quote_reference=q.reference AND d.payment_type='deposit' LEFT JOIN square_payments s ON s.quote_reference=q.reference AND s.payment_type='balance' LEFT JOIN square_balance_invoices i ON i.payment_id=s.id WHERE q.status='accepted' AND b.status NOT IN ('cancelled','declined') AND p.channel<>'none' AND d.status='paid' AND d.currency='USD' AND d.square_environment=? AND d.amount_cents=CAST((q.final_fare_cents+1)/2 AS INTEGER) AND d.square_payment_id IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM notification_events e WHERE e.event_key='deposit:'||q.reference) OR b.status='completed' AND s.status='paid' AND s.currency='USD' AND s.square_environment=? AND s.amount_cents=q.final_fare_cents-d.amount_cents AND s.square_payment_id IS NOT NULL AND (s.checkout_key IS NULL OR s.checkout_key NOT LIKE 'mvbri-invoice-balance-%' OR i.review_required=0 AND i.verified_amount_cents=s.amount_cents) AND NOT EXISTS(SELECT 1 FROM notification_events e WHERE e.event_key='receipt:'||q.reference)) ORDER BY q.created_at LIMIT ?`).bind(mode,mode,limit).all()).results||[];
 for(const q of rows){
  const fare=await fareState(env,q.reference);if(!fare||['declined','cancelled'].includes(fare.booking_status))continue;
  if(fare.depositPaid){const notice=await notificationStatement(env,fare.booking_reference,'deposit_paid','deposit:'+q.reference,{amount:fare.depositCents/100});if(notice)await notice.run();}
  if(fare.fullyPaid){const record=await ensureReceipt(env,q.reference),links=await receiptLinks(env,record,origin);const notice=await notificationStatement(env,fare.booking_reference,'receipt','receipt:'+q.reference,{total:fare.final_fare_cents/100,...links});if(notice)await notice.run();}
 }
}
