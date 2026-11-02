import {json} from '../_lib/auth.js';
import {normalizePhone} from '../_lib/communications.js';
import {verifyTwilio,verifyResend,BUSINESS_PHONE} from '../_lib/message-webhooks.js';
async function prepareCallback(env,key){
 await env.DB.prepare('INSERT OR IGNORE INTO message_callback_events(event_key,received_at) VALUES (?,?)').bind(key,new Date().toISOString()).run();
 const row=await env.DB.prepare('SELECT processed_at FROM message_callback_events WHERE event_key=?').bind(key).first();return row?.processed_at==null;
}
function finishCallback(env,key){return env.DB.prepare('UPDATE message_callback_events SET processed_at=? WHERE event_key=? AND processed_at IS NULL').bind(new Date().toISOString(),key);}
export async function onRequestPost({request,env}){
 if(!env.DB)return json({error:'Unavailable.'},503);
 try{
  const raw=await request.text();if(new TextEncoder().encode(raw).length>100000)return json({error:'Payload too large.'},413);
  if(request.headers.has('x-twilio-signature')){
   const fields=await verifyTwilio(request,env,raw);if(!fields)return json({error:'Invalid signature.'},401);
   const mid=new URL(request.url).searchParams.get('mid'),sid=fields.get('MessageSid'),state=fields.get('MessageStatus');
   if(!/^[a-f0-9-]{36}$/i.test(mid||'')||!/^SM[a-f0-9]{32}$/i.test(sid||'')||!['queued','sending','sent','delivered','undelivered','failed'].includes(state))return json({error:'Invalid callback.'},400);
   const row=await env.DB.prepare(`SELECT * FROM customer_messages WHERE id=? AND channel='sms'`).bind(mid).first();
   if(!row||normalizePhone(fields.get('From'))!==BUSINESS_PHONE||normalizePhone(fields.get('To'))!==row.destination||(row.provider_id&&row.provider_id!==sid))return json({error:'Message does not match.'},409);
   const eventKey='twilio:'+sid+':'+state;if(!await prepareCallback(env,eventKey))return json({ok:true});
   const status=state==='delivered'?'delivered':['failed','undelivered'].includes(state)?'failed':'accepted';
   await env.DB.batch([env.DB.prepare(`UPDATE customer_messages SET status=CASE WHEN status='delivered' OR (status='failed' AND ?='accepted') THEN status ELSE ? END,delivery_status=CASE WHEN status='delivered' OR (status='failed' AND ?='accepted') THEN delivery_status ELSE ? END,provider_id=COALESCE(provider_id,?),error_code=?,updated_at=? WHERE id=? AND status NOT IN ('draft','suppressed') AND EXISTS(SELECT 1 FROM message_callback_events WHERE event_key=? AND processed_at IS NULL)`)
    .bind(status,status,status,state,sid,fields.get('ErrorCode')||null,new Date().toISOString(),mid,eventKey),finishCallback(env,eventKey)]);
   return json({ok:true});
  }
  const verified=await verifyResend(request,env,raw);if(!verified)return json({error:'Invalid signature.'},401);
  const {event,id}=verified;
  const states={'email.sent':'accepted','email.delivered':'delivered','email.bounced':'failed','email.failed':'failed','email.complained':'failed'};
  if(!states[event.type])return json({ok:true});
  const providerId=event.data?.email_id;if(typeof providerId!=='string')return json({error:'Invalid callback.'},400);
  const tag=Array.isArray(event.data?.tags)?event.data.tags.find(t=>t.name==='mvbri_message_id')?.value:event.data?.tags?.mvbri_message_id;
  const row=await env.DB.prepare(`SELECT id,status,provider_id FROM customer_messages WHERE channel='email' AND (provider_id=? OR (id=? AND provider_id IS NULL)) LIMIT 1`).bind(providerId,typeof tag==='string'?tag:'').first();
  if(!row||(row.provider_id&&row.provider_id!==providerId))return json({ok:true});
  const eventKey='resend:'+id;if(!await prepareCallback(env,eventKey))return json({ok:true});
  const state=states[event.type];
  await env.DB.batch([env.DB.prepare(`UPDATE customer_messages SET status=CASE WHEN status='delivered' OR (status='failed' AND ?='accepted') THEN status ELSE ? END,delivery_status=CASE WHEN status='delivered' OR (status='failed' AND ?='accepted') THEN delivery_status ELSE ? END,provider_id=COALESCE(provider_id,?),provider_payload_ciphertext=NULL,updated_at=? WHERE id=? AND status NOT IN ('draft','suppressed') AND EXISTS(SELECT 1 FROM message_callback_events WHERE event_key=? AND processed_at IS NULL)`)
   .bind(state,state,state,event.type,providerId,new Date().toISOString(),row.id,eventKey),finishCallback(env,eventKey)]);
  return json({ok:true});
 }catch{return json({error:'Callback could not be processed.'},400);}
}
