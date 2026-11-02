import {processCommunications,deliveryConfiguration,notificationStatement} from '../functions/_lib/communications.js';
import {verifyQuotePayments} from '../functions/_lib/square-reconcile.js';
import {reconcileTip} from '../functions/_lib/square-tip.js';

export async function runCommunicationJob(env){
 if(!env.DB||(await deliveryConfiguration(env)).mode==='off')return;
 const time=new Date().toISOString(),stale=new Date(Date.now()-5*60*1000).toISOString();
 // An interrupted SMS request is uncertain. Retrying it could text twice.
 await env.DB.prepare(`UPDATE customer_messages SET status=CASE WHEN channel='sms' THEN 'uncertain' WHEN first_attempt_at>? THEN 'pending' ELSE 'uncertain' END,error_code='INTERRUPTED_SEND',updated_at=? WHERE status='sending' AND updated_at<?`).bind(new Date(Date.now()-23*60*60*1000).toISOString(),time,stale).run();
 await env.DB.prepare(`UPDATE ride_quotes SET status='expired',updated_at=? WHERE status='issued' AND expires_at<=?`).bind(time,time).run();
 const expired=(await env.DB.prepare(`SELECT q.reference,q.booking_reference FROM ride_quotes q JOIN booking_contact_preferences p ON p.booking_reference=q.booking_reference WHERE q.status='expired' AND p.channel<>'none' AND NOT EXISTS(SELECT 1 FROM notification_events e WHERE e.event_key='expired:'||q.reference) LIMIT 10`).all()).results||[];
 for(const q of expired){const stmt=await notificationStatement(env,q.booking_reference,'quote_expired','expired:'+q.reference,{quoteReference:q.reference});if(stmt)await stmt.run();}
 // Provider checks run even if the customer never returns from checkout. Access stays intact.
 const quotes=(await env.DB.prepare(`SELECT DISTINCT q.reference,q.final_fare_cents FROM ride_quotes q JOIN square_payments s ON s.quote_reference=q.reference JOIN booking_contact_preferences p ON p.booking_reference=q.booking_reference JOIN bookings b ON b.reference=q.booking_reference WHERE q.status='accepted' AND p.channel<>'none' AND b.status NOT IN ('declined','cancelled') AND s.status='pending' AND s.square_order_id IS NOT NULL ORDER BY s.updated_at LIMIT 1`).all()).results||[];
 for(const q of quotes){try{await verifyQuotePayments(env,q);}catch{console.error('Scheduled fare verification needs review.');}await env.DB.prepare(`UPDATE square_payments SET updated_at=? WHERE quote_reference=? AND status='pending'`).bind(time,q.reference).run();}
 const tips=(await env.DB.prepare(`SELECT * FROM square_tip_checkouts WHERE status='pending' AND square_order_id IS NOT NULL ORDER BY updated_at LIMIT 1`).all()).results||[];
 for(const tip of tips){try{await reconcileTip(env,tip);}catch{console.error('Scheduled optional-tip verification needs review.');}await env.DB.prepare(`UPDATE square_tip_checkouts SET updated_at=? WHERE quote_reference=? AND status='pending'`).bind(time,tip.quote_reference).run();}
 await processCommunications(env);
}
export default {
 scheduled(event,env,context){context.waitUntil(runCommunicationJob(env));},
 fetch(){return new Response('Not found',{status:404});}
};
