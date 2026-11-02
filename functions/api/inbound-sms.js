import {json} from '../_lib/auth.js';
import {normalizePhone} from '../_lib/communications.js';
import {verifyTwilio,BUSINESS_PHONE} from '../_lib/message-webhooks.js';
export async function onRequestPost({request,env}){
 try{
  if(!env.DB)return json({error:'Unavailable.'},503);
  const raw=await request.text();if(new TextEncoder().encode(raw).length>20000)return json({error:'Payload too large.'},413);
  const fields=await verifyTwilio(request,env,raw);if(!fields)return json({error:'Invalid signature.'},401);
  const from=normalizePhone(fields.get('From')),sid=fields.get('MessageSid');
  if(!from||normalizePhone(fields.get('To'))!==BUSINESS_PHONE||!/^SM[a-f0-9]{32}$/i.test(sid||''))return json({error:'Invalid incoming message.'},400);
  const eventKey='twilio-inbound:'+sid,time=new Date().toISOString();
  await env.DB.prepare(`INSERT OR IGNORE INTO message_callback_events(event_key,received_at) VALUES (?,?)`).bind(eventKey,time).run();
  const event=await env.DB.prepare(`SELECT processed_at FROM message_callback_events WHERE event_key=?`).bind(eventKey).first();
  if(!event.processed_at){
   const word=(fields.get('OptOutType')||fields.get('Body')||'').trim().toUpperCase();
   const guard=`EXISTS(SELECT 1 FROM message_callback_events WHERE event_key=? AND processed_at IS NULL)`;
   const statements=[];
   if(['STOP','STOPALL','UNSUBSCRIBE','CANCEL','END','QUIT','REVOKE','OPTOUT'].includes(word)){
    statements.push(
     env.DB.prepare(`INSERT INTO sms_suppressions(phone_e164,reason,updated_at) SELECT ?,'STOP',? WHERE ${guard} ON CONFLICT(phone_e164) DO UPDATE SET reason='STOP',updated_at=excluded.updated_at`).bind(from,time,eventKey),
     env.DB.prepare(`UPDATE customer_messages SET status='suppressed',updated_at=? WHERE channel='sms' AND destination=? AND status IN ('pending','held','draft') AND ${guard}`).bind(time,from,eventKey)
    );
   }else if(['START','UNSTOP'].includes(word))statements.push(env.DB.prepare(`DELETE FROM sms_suppressions WHERE phone_e164=? AND ${guard}`).bind(from,eventKey));
   statements.push(env.DB.prepare(`UPDATE message_callback_events SET processed_at=? WHERE event_key=? AND processed_at IS NULL`).bind(time,eventKey));
   await env.DB.batch(statements);
  }
  return new Response('<Response/>',{headers:{'Content-Type':'text/xml','Cache-Control':'no-store'}});
 }catch{return json({error:'Incoming message could not be processed.'},400);}
}
