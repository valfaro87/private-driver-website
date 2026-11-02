import {json,ownerSession,sameOrigin,sha256Hex} from '../_lib/auth.js';
import {BUSINESS_PHONE,deliveryConfiguration,normalizePhone,wakeCommunications} from '../_lib/communications.js';
import {encryptMessage,decryptMessage} from '../_lib/communications-crypto.js';

async function authorize(request,env){if(!env.DB)return json({error:'Customer messaging is unavailable.'},503);if(!await ownerSession(request,env))return json({error:'Please sign in as the owner.'},401);}
async function customer(env,reference){return env.DB.prepare(`SELECT b.reference,b.name,b.phone,p.channel,p.sms_consent FROM bookings b LEFT JOIN booking_contact_preferences p ON p.booking_reference=b.reference WHERE b.reference=?`).bind(reference).first();}
function eligible(b){return !!b&&b.channel==='sms'&&b.sms_consent===1&&!!normalizePhone(b.phone);}

export async function onRequestGet({request,env}){
 const rejected=await authorize(request,env);if(rejected)return rejected;
 try{
  const config=await deliveryConfiguration(env);
  const bookings=(await env.DB.prepare(`SELECT b.reference,b.name,b.phone,p.channel,p.sms_consent FROM bookings b LEFT JOIN booking_contact_preferences p ON p.booking_reference=b.reference ORDER BY b.created_at DESC LIMIT 500`).all()).results||[];
  const rows=(await env.DB.prepare(`SELECT id,booking_reference,channel,destination,status,delivery_status,error_code,created_at FROM customer_messages ORDER BY created_at DESC LIMIT 50`).all()).results||[];
  return json({businessNumber:BUSINESS_PHONE,smsAvailable:config.smsAvailable,emailAvailable:config.emailAvailable,mode:config.mode,
   customers:bookings.map(b=>({reference:b.reference,name:b.name,phone:normalizePhone(b.phone),textConsent:eligible(b)})),messages:rows});
 }catch{return json({error:'Unable to load customer messaging.'},503);}
}
export async function onRequestPost(context){
 const {request,env}=context;
 if(!sameOrigin(request))return json({error:'Request rejected.'},403);
 const rejected=await authorize(request,env);if(rejected)return rejected;
 if(!(request.headers.get('content-type')||'').includes('application/json'))return json({error:'JSON required.'},415);
 let body;try{const raw=await request.text();if(new TextEncoder().encode(raw).length>4096)return json({error:'Message request is too large.'},413);body=JSON.parse(raw);}catch{return json({error:'Invalid message request.'},400);}
 try{
  if(body.action==='check_sender'){
   if(!/^AC[a-f0-9]{32}$/i.test(env.TWILIO_ACCOUNT_SID||'')||!env.TWILIO_AUTH_TOKEN||env.TWILIO_PHONE_NUMBER!==BUSINESS_PHONE)return json({error:'Connect the MVBRI business number to your SMS service first.'},503);
   const response=await fetch('https://api.twilio.com/2010-04-01/Accounts/'+env.TWILIO_ACCOUNT_SID+'/IncomingPhoneNumbers.json?PhoneNumber='+encodeURIComponent(BUSINESS_PHONE)+'&PageSize=5',{
    headers:{Authorization:'Basic '+btoa(env.TWILIO_ACCOUNT_SID+':'+env.TWILIO_AUTH_TOKEN)},signal:AbortSignal.timeout(10000)});
   const data=await response.json();
   const found=(data.incoming_phone_numbers||[]).some(p=>p.phone_number===BUSINESS_PHONE&&p.account_sid===env.TWILIO_ACCOUNT_SID&&p.capabilities?.sms===true);
   if(!response.ok||!found)return json({error:'The connected SMS account does not show this business number as able to send texts.'},409);
   const time=new Date().toISOString();
   await env.DB.prepare(`INSERT INTO communication_provider_state(provider,account_fingerprint,sender,verified_at) VALUES ('twilio',?,?,?) ON CONFLICT(provider) DO UPDATE SET account_fingerprint=excluded.account_fingerprint,sender=excluded.sender,verified_at=excluded.verified_at`)
    .bind(await sha256Hex(env.TWILIO_ACCOUNT_SID+':'+BUSINESS_PHONE),BUSINESS_PHONE,time).run();
   return json({ok:true,senderVerified:true,smsAvailable:(await deliveryConfiguration(env)).smsAvailable});
  }
  if(body.action==='preview'){
   const message=typeof body.message==='string'?body.message.trim():'';
   if(!/^RD-[A-Z0-9]{8,32}$/.test(body.reference||'')||!message||message.length>480||/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(message))return json({error:'Choose a customer and enter a text of 1–480 characters.'},400);
   const b=await customer(env,body.reference);
   if(!eligible(b))return json({error:'This customer has not opted in to text updates. Their selected contact preference must be respected.'},409);
   const to=normalizePhone(b.phone);
   if(await env.DB.prepare('SELECT phone_e164 FROM sms_suppressions WHERE phone_e164=?').bind(to).first())return json({error:'This phone number has opted out of texts.'},409);
   const id=crypto.randomUUID(),time=new Date().toISOString(),expiresAt=new Date(Date.now()+15*60*1000).toISOString();
   const text='MVBRI: '+message;
   await env.DB.prepare(`INSERT INTO customer_messages(id,event_key,booking_reference,channel,destination,sender,content_ciphertext,status,draft_expires_at,created_at,updated_at) VALUES (?,?,?,'sms',?,?,?,'draft',?,?,?)`)
    .bind(id,'custom:'+id,b.reference,to,BUSINESS_PHONE,await encryptMessage(env,{subject:'MVBRI custom ride text',text,links:[]}),expiresAt,time,time).run();
   return json({previewId:id,customerName:b.name,to,from:BUSINESS_PHONE,text:text+'\nReply STOP to opt out.',expiresAt,canSend:(await deliveryConfiguration(env)).smsAvailable});
  }
  if(body.action==='send'){
   if(!/^[a-f0-9-]{36}$/i.test(body.previewId||''))return json({error:'Preview the customer and message first.'},400);
   const row=await env.DB.prepare(`SELECT * FROM customer_messages WHERE id=? AND event_key LIKE 'custom:%'`).bind(body.previewId).first();
   if(!row)return json({error:'Message preview was not found.'},404);
   if(row.status!=='draft')return json({ok:true,id:row.id,status:row.status},202);
   if(Date.parse(row.draft_expires_at)<=Date.now())return json({error:'This preview expired. Preview the text again before sending.'},409);
   const b=await customer(env,row.booking_reference);
   if(!eligible(b)||normalizePhone(b.phone)!==row.destination)return json({error:'The customer contact preference changed. Preview again.'},409);
   if(!(await deliveryConfiguration(env)).smsAvailable)return json({error:'Business texting is not active yet.'},503);
   await decryptMessage(env,row.content_ciphertext);
   const result=await env.DB.prepare(`UPDATE customer_messages SET status='pending',updated_at=? WHERE id=? AND status='draft' AND draft_expires_at>?`).bind(new Date().toISOString(),row.id,new Date().toISOString()).run();
   if(result.meta?.changes!==1)return json({error:'This preview changed. Refresh before sending.'},409);
   await wakeCommunications(context);
   const latest=await env.DB.prepare('SELECT status FROM customer_messages WHERE id=?').bind(row.id).first();
   return json({ok:true,id:row.id,status:latest.status},202);
  }
  return json({error:'Choose a valid customer messaging action.'},400);
 }catch{return json({error:'Customer messaging is not ready. Check the connection and encryption settings.'},503);}
}
