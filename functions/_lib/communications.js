import {sha256Hex} from './auth.js';
import {hasCommunicationsKey,encryptMessage,decryptMessage,linkToken} from './communications-crypto.js';
import {queuePaymentNotices,fareState} from './postride.js';
import {logoBase64} from './brand-logo.js';

export const BUSINESS_PHONE='+13465575796';
export const CONSENT_VERSION='mvbri-updates-v1';
const now=()=>new Date().toISOString();
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function normalizePhone(value){const n=String(value||'').replace(/[^\d+]/g,'');const phone=/^\d{10}$/.test(n)?'+1'+n:/^1\d{10}$/.test(n)?'+'+n:n;return /^\+1[2-9]\d{9}$/.test(phone)?phone:null;}
export function customerOrigin(env){
 const u=new URL(env.CUSTOMER_SITE_URL || 'https://www.mvbri.com');
 if(u.protocol!=='https:'||u.username||u.password||u.port||!['www.mvbri.com','mvbri.com','private-driver-website.pages.dev','mvbri-private-upgrades-20261.private-driver-website.pages.dev'].includes(u.hostname)||u.pathname!=='/'||u.search||u.hash)throw new Error('Customer website address is not configured correctly.');
 return u.origin;
}
export async function deliveryConfiguration(env){
 const mode=['test','live'].includes(env.NOTIFICATION_DELIVERY_MODE)?env.NOTIFICATION_DELIVERY_MODE:'off';
 const active=mode!=='off'&&hasCommunicationsKey(env);
 const email=active&&!!env.RESEND_API_KEY&&env.EMAIL_NOTIFICATIONS_ENABLED==='true'&&(mode!=='test'||!!env.NOTIFICATION_TEST_EMAIL);
 let sms=false;
 if(active&&env.SMS_NOTIFICATIONS_ENABLED==='true'&&env.SMS_REGISTRATION_APPROVED==='true'&&
   /^AC[a-f0-9]{32}$/i.test(env.TWILIO_ACCOUNT_SID||'')&&env.TWILIO_AUTH_TOKEN&&env.TWILIO_PHONE_NUMBER===BUSINESS_PHONE&&
   (mode!=='test'||normalizePhone(env.NOTIFICATION_TEST_PHONE))){
  const proof=await env.DB.prepare(`SELECT account_fingerprint,sender FROM communication_provider_state WHERE provider='twilio'`).first();
  sms=proof?.account_fingerprint===await sha256Hex(env.TWILIO_ACCOUNT_SID+':'+BUSINESS_PHONE)&&proof.sender===BUSINESS_PHONE;
 }
 return {mode,emailAvailable:!!email,smsAvailable:!!sms};
}
export async function validatePreference(env,body){
 const channel=body.contactPreference??'none';
 if(!['none','email','sms'].includes(channel))throw Object.assign(new Error('Choose how you want to receive ride updates.'),{status:400});
 if(channel==='none')return {channel,smsConsent:false};
 const config=await deliveryConfiguration(env);
 if(channel==='email'&&!config.emailAvailable)throw Object.assign(new Error('Email updates are not available yet. Choose no automatic updates or contact MVBRI.'),{status:503});
 if(channel==='sms'&&(!config.smsAvailable||!normalizePhone(body.phone)||body.smsConsent!==true))throw Object.assign(new Error('Text updates require an available text service, a US phone number and your consent. You can choose email instead.'),{status:400});
 return {channel,smsConsent:channel==='sms'};
}
export function preferenceStatement(env,reference,pref){const time=now();return env.DB.prepare(`INSERT INTO booking_contact_preferences(booking_reference,channel,sms_consent,consent_version,consented_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(reference,pref.channel,pref.smsConsent?1:0,CONSENT_VERSION,time,time);}
export async function notificationStatement(env,reference,kind,eventKey,details={},options={}){
 const pref=options.preference || await env.DB.prepare(`SELECT channel FROM booking_contact_preferences WHERE booking_reference=?`).bind(reference).first();
 if(!pref || pref.channel==='none')return null;
 let guard='',values=[];
 if(options.quoteGuard){const g=options.quoteGuard;guard=` WHERE EXISTS(SELECT 1 FROM ride_quotes WHERE reference=? AND status=? AND customer_token_hash=?${g.respondedAt?' AND responded_at=?':''})`;values=[g.reference,g.status,g.tokenHash,...(g.respondedAt?[g.respondedAt]:[])];}
 if(options.bookingGuard){const g=options.bookingGuard;guard=' WHERE EXISTS(SELECT 1 FROM bookings WHERE reference=? AND status=? AND updated_at=?)';values=[reference,g.status,g.updatedAt];}
 return env.DB.prepare(`INSERT OR IGNORE INTO notification_events(id,event_key,booking_reference,kind,payload_ciphertext,created_at) SELECT ?,?,?,?,?,?${guard}`)
  .bind(crypto.randomUUID(),eventKey,reference,kind,await encryptMessage(env,details),now(),...values);
}
export async function saveQuoteToken(env,reference,token){
 if(!hasCommunicationsKey(env))return;
 const hash=await sha256Hex(token);
 const old=await env.DB.prepare(`SELECT token_hash FROM customer_quote_links WHERE quote_reference=?`).bind(reference).first();
 if(old?.token_hash===hash)return;
 await (await quoteTokenStatement(env,reference,token)).run();
}
export async function quoteTokenStatement(env,reference,token){
 if(!hasCommunicationsKey(env))return null;
 const hash=await sha256Hex(token);
 return env.DB.prepare(`INSERT INTO customer_quote_links(quote_reference,token_hash,encrypted_token,updated_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM ride_quotes WHERE reference=? AND customer_token_hash=?) ON CONFLICT(quote_reference) DO UPDATE SET token_hash=excluded.token_hash,encrypted_token=excluded.encrypted_token,updated_at=excluded.updated_at`)
  .bind(reference,hash,await encryptMessage(env,{token}),now(),reference,hash);
}
export async function quoteLink(env,reference){
 const row=await env.DB.prepare(`SELECT l.encrypted_token,l.token_hash,q.customer_token_hash FROM customer_quote_links l JOIN ride_quotes q ON q.reference=l.quote_reference WHERE q.reference=?`).bind(reference).first();
 if(!row || row.token_hash!==row.customer_token_hash)return null;
 const {token}=await decryptMessage(env,row.encrypted_token);
 return customerOrigin(env)+'/quote?token='+encodeURIComponent(token);
}
function messageContent(kind,d,b){
 const ref=b.reference,date=[b.pickup_date,b.pickup_time].filter(Boolean).join(' '),links=[];
 let subject='MVBRI ride update',text='';
 if(kind==='booking_received')text=`MVBRI: We received ride request ${ref} for ${date}. Your ride is not confirmed yet. We will follow up about availability and your quote.`;
 else if(kind==='booking_status'){subject='Your MVBRI ride: '+d.status;text=`MVBRI: Your ride ${ref} is ${d.status}. Pickup: ${date}.`;if(d.status==='completed')text+=' After your fare payment is verified, we will send your receipt and optional tip link.';if(d.quoteUrl)links.push({label:'View your ride and balance',url:d.quoteUrl});}
 else if(kind==='quote_issued'){subject='Your MVBRI quote '+d.quoteReference;text=`MVBRI: Your ride quote is ready. Fare: $${Number(d.amount).toFixed(2)}. Accept by ${d.expiresAt}. A 50% deposit is required after acceptance.`;if(d.url)links.push({label:'Review your quote',url:d.url});}
 else if(kind==='quote_replaced'){subject='Your updated MVBRI quote link';text=`MVBRI: Your accepted quote ${d.quoteReference} has a new secure link. Your accepted fare is unchanged. Use the new link to review your ride and payment status.`;if(d.url)links.push({label:'View your accepted quote',url:d.url});}
 else if(kind==='quote_response'){text=`MVBRI: Your quote ${d.quoteReference} was ${d.action}.`;if(d.action==='accepted')text+=' Please pay the required 50% deposit.';if(d.url)links.push({label:'View your quote',url:d.url});}
 else if(kind==='quote_expired')text=`MVBRI: Quote ${d.quoteReference} expired before acceptance. Please contact us if you still need a ride.`;
 else if(kind==='deposit_paid')text=`MVBRI: Your 50% deposit of $${Number(d.amount).toFixed(2)} is verified for ride ${ref}. The remaining balance is due after your trip.`;
 else if(kind==='receipt'){subject='Your MVBRI receipt';text=`MVBRI: Thank you for riding with us. Your fare payment of $${Number(d.total).toFixed(2)} is verified. Your receipt is ready. Gratuities are optional.`;links.push({label:'View your receipt',url:d.receiptUrl},{label:'Leave an optional tip',url:d.tipUrl});}
 else throw new Error('Unknown customer update.');
 return {subject,text,links};
}
export async function stageNotifications(env,limit=20){
 if(!env.DB||!hasCommunicationsKey(env))return;
 const rows=(await env.DB.prepare(`SELECT e.*,b.name,b.phone,b.email,b.pickup_date,b.pickup_time,p.channel,p.sms_consent FROM notification_events e JOIN bookings b ON b.reference=e.booking_reference LEFT JOIN booking_contact_preferences p ON p.booking_reference=e.booking_reference WHERE e.queued_at IS NULL ORDER BY e.created_at LIMIT ?`).bind(limit).all()).results||[];
 for(const row of rows){
  if(!row.channel||row.channel==='none'){await env.DB.prepare(`UPDATE notification_events SET queued_at=? WHERE id=?`).bind(now(),row.id).run();continue;}
  const details=await decryptMessage(env,row.payload_ciphertext);
  if(['quote_issued','quote_replaced','quote_response'].includes(row.kind)){
   const q=await env.DB.prepare('SELECT status,customer_token_hash,expires_at FROM ride_quotes WHERE reference=?').bind(details.quoteReference).first();
   if(!q||details.token&&q.customer_token_hash!==await sha256Hex(details.token)||row.kind==='quote_issued'&&(q.status!=='issued'||Date.parse(q.expires_at)<=Date.now())){await env.DB.prepare('UPDATE notification_events SET queued_at=? WHERE id=?').bind(now(),row.id).run();continue;}
  }
  if(details.token)details.url=customerOrigin(env)+'/quote?token='+encodeURIComponent(details.token);
  if(row.kind==='booking_status'){
   const latest=await env.DB.prepare(`SELECT reference FROM ride_quotes WHERE booking_reference=? AND status='accepted' ORDER BY created_at DESC LIMIT 1`).bind(row.booking_reference).first();
   if(latest)details.quoteUrl=await quoteLink(env,latest.reference);
  }
  const content=messageContent(row.kind,details,{...row,reference:row.booking_reference});
  const destination=row.channel==='sms'?normalizePhone(row.phone):String(row.email).trim();
  if(!destination || (row.channel==='sms'&&!row.sms_consent))continue;
  const id=crypto.randomUUID(),time=now();
  await env.DB.batch([
   env.DB.prepare(`INSERT OR IGNORE INTO customer_messages(id,event_key,booking_reference,channel,destination,sender,content_ciphertext,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'pending',?,?)`).bind(id,row.event_key,row.booking_reference,row.channel,destination,row.channel==='sms'?BUSINESS_PHONE:(env.MVBRI_EMAIL_FROM||'MVBRI <quotes@mvbri.com>'),await encryptMessage(env,content),time,time),
   env.DB.prepare(`UPDATE notification_events SET queued_at=? WHERE id=?`).bind(time,row.id)
  ]);
 }
}
async function maySend(env,row,config){
 const b=await env.DB.prepare(`SELECT b.phone,b.email,p.channel,p.sms_consent FROM bookings b LEFT JOIN booking_contact_preferences p ON p.booking_reference=b.reference WHERE b.reference=?`).bind(row.booking_reference).first();
 if(row.event_key.startsWith('receipt:')&&!(await fareState(env,row.event_key.slice(8)))?.fullyPaid)return 'suppressed';
 if(!b||b.channel!==row.channel||(row.channel==='sms'&&(!b.sms_consent||normalizePhone(b.phone)!==row.destination))||(row.channel==='email'&&String(b.email).trim()!==row.destination))return 'suppressed';
 if(row.channel==='sms'&&await env.DB.prepare(`SELECT phone_e164 FROM sms_suppressions WHERE phone_e164=?`).bind(row.destination).first())return 'suppressed';
 if(!(row.channel==='sms'?config.smsAvailable:config.emailAvailable))return 'held';
 if(config.mode==='test'&&row.destination!==(row.channel==='sms'?normalizePhone(env.NOTIFICATION_TEST_PHONE):env.NOTIFICATION_TEST_EMAIL))return 'held';
 return null;
}
export async function drainMessages(env,limit=3){
 if(!env.DB||!hasCommunicationsKey(env))return;
 const config=await deliveryConfiguration(env);
 const rows=(await env.DB.prepare(`SELECT * FROM customer_messages WHERE status IN ('pending','held') ORDER BY created_at LIMIT ?`).bind(limit).all()).results||[];
 for(const row of rows){
  const blocked=await maySend(env,row,config);
  if(blocked){await env.DB.prepare(`UPDATE customer_messages SET status=?,updated_at=? WHERE id=? AND status IN ('pending','held')`).bind(blocked,now(),row.id).run();continue;}
  const time=now();
  const claimed=await env.DB.prepare(`UPDATE customer_messages SET status='sending',attempts=attempts+1,first_attempt_at=COALESCE(first_attempt_at,?),updated_at=? WHERE id=? AND status IN ('pending','held')`).bind(time,time,row.id).run();
  if(claimed.meta?.changes!==1)continue;
  try {
   const content=await decryptMessage(env,row.content_ciphertext);
   const optout=customerOrigin(env)+'/updates.html?ref='+encodeURIComponent(row.booking_reference)+'&token='+await linkToken(env,'updates',row.booking_reference);
   let payload=row.provider_payload_ciphertext?await decryptMessage(env,row.provider_payload_ciphertext):null;
   if(!payload){
    const text=content.text+(content.links||[]).map(l=>'\n'+l.label+': '+l.url).join('');
    payload=row.channel==='sms'?{To:row.destination,From:BUSINESS_PHONE,Body:text+'\nReply STOP to opt out.',StatusCallback:customerOrigin(env)+'/api/message-status?mid='+encodeURIComponent(row.id)}:{
     from:row.sender,to:[row.destination],reply_to:'mvbriofficial@gmail.com',subject:content.subject,
     text:text+'\nManage ride updates: '+optout,
     html:'<div style="max-width:600px;margin:auto;font-family:Arial,sans-serif"><div style="background:#101010;padding:20px;text-align:center"><img src="cid:mvbri-logo" alt="MVBRI" width="192"></div><h1 style="font-size:24px">'+escape(content.subject)+'</h1><p>'+escape(content.text).replace(/\n/g,'<br>')+'</p>'+(content.links||[]).map(l=>'<p><a href="'+escape(l.url)+'">'+escape(l.label)+'</a></p>').join('')+'<p style="font-size:12px">MVBRI · Houston, Texas · (346) 557-5796<br><a href="'+escape(optout)+'">Manage ride updates</a></p></div>',
     attachments:[{content:logoBase64,filename:'mvbri-logo.png',content_type:'image/png',content_id:'mvbri-logo'}]
     ,tags:[{name:'mvbri_message_id',value:row.id}]
    };
    await env.DB.prepare(`UPDATE customer_messages SET provider_payload_ciphertext=? WHERE id=?`).bind(await encryptMessage(env,payload),row.id).run();
   }
   const elapsed=Date.now()-Date.parse(row.first_attempt_at||time);
   if(row.channel==='email'&&elapsed>23*60*60*1000)throw Object.assign(new Error('Retry needs review.'),{uncertain:true});
   const response=await fetch(row.channel==='sms'?'https://api.twilio.com/2010-04-01/Accounts/'+env.TWILIO_ACCOUNT_SID+'/Messages.json':'https://api.resend.com/emails',{
    method:'POST',headers:row.channel==='sms'?{Authorization:'Basic '+btoa(env.TWILIO_ACCOUNT_SID+':'+env.TWILIO_AUTH_TOKEN),'Content-Type':'application/x-www-form-urlencoded'}:{Authorization:'Bearer '+env.RESEND_API_KEY,'Content-Type':'application/json','Idempotency-Key':'mvbri-'+row.id},
    body:row.channel==='sms'?new URLSearchParams(payload):JSON.stringify(payload),signal:AbortSignal.timeout(10000)
   });
   const result=await response.json();const providerId=row.channel==='sms'?result.sid:result.id;
   if(!response.ok||!providerId)throw Object.assign(new Error('Provider did not accept the message.'),{definite:response.status>=400&&response.status<500,code:'HTTP_'+response.status,retry:response.status===429});
   await env.DB.prepare(`UPDATE customer_messages SET status=CASE WHEN status IN ('delivered','failed','suppressed') THEN status ELSE 'accepted' END,provider_id=COALESCE(provider_id,?),provider_payload_ciphertext=NULL,delivery_status=COALESCE(delivery_status,'accepted'),error_code=NULL,updated_at=? WHERE id=?`).bind(providerId,now(),row.id).run();
  } catch(error){
   const retry=(row.channel==='email'&&!error.definite&&!error.uncertain||error.retry)&&row.attempts<2;
   const status=retry?'pending':error.definite?'failed':'uncertain';
   await env.DB.prepare(`UPDATE customer_messages SET status=?,error_code=?,updated_at=? WHERE id=? AND status='sending'`).bind(status,error.code||'REVIEW_REQUIRED',now(),row.id).run();
  }
 }
}
export async function processCommunications(env){if((await deliveryConfiguration(env)).mode==='off')return;await queuePaymentNotices(env,notificationStatement,customerOrigin(env));await stageNotifications(env);await drainMessages(env);}
export function wakeCommunications(context){
 if(!context.env.DB||!hasCommunicationsKey(context.env))return;
 const task=processCommunications(context.env).catch(()=>console.error('Customer message processing needs review.'));
 if(typeof context.waitUntil==='function'){context.waitUntil(task);return;}
 return task;
}
