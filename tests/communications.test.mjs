import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database,fixture,request,testToken} from './helpers/database.mjs';
import {sha256Hex} from '../functions/_lib/auth.js';
import {encryptMessage,decryptMessage} from '../functions/_lib/communications-crypto.js';
import {BUSINESS_PHONE,notificationStatement,processCommunications,drainMessages,deliveryConfiguration,quoteTokenStatement} from '../functions/_lib/communications.js';
import {onRequestPost as ownerPost,onRequestGet as ownerGet} from '../functions/api/owner-messages.js';
import {onRequestPost as issue} from '../functions/api/quotes/issue.js';
import {onRequestPost as deliveryCallback} from '../functions/api/message-status.js';
import {onRequestPost as inbound} from '../functions/api/inbound-sms.js';
import {onRequestPost as changePreference} from '../functions/api/contact-preference.js';
import {linkToken} from '../functions/_lib/communications-crypto.js';
import {createHmac} from 'node:crypto';

async function setup(channel='email'){
 const DB=database();await fixture(DB);
 const env={DB,COMMUNICATIONS_ENCRYPTION_KEY:'c'.repeat(64),NOTIFICATION_DELIVERY_MODE:'test',
  EMAIL_NOTIFICATIONS_ENABLED:'true',RESEND_API_KEY:'test-only',NOTIFICATION_TEST_EMAIL:'test@example.invalid',
  SMS_NOTIFICATIONS_ENABLED:'true',SMS_REGISTRATION_APPROVED:'true',TWILIO_ACCOUNT_SID:'AC'+'a'.repeat(32),TWILIO_AUTH_TOKEN:'test-only',TWILIO_PHONE_NUMBER:BUSINESS_PHONE,NOTIFICATION_TEST_PHONE:'+15550100000',
  CUSTOMER_SITE_URL:'https://mvbri-private-upgrades-20261.private-driver-website.pages.dev'};
 await DB.prepare(`INSERT INTO booking_contact_preferences VALUES ('RD-TEST000001',?,?, 'mvbri-updates-v1','now','now')`).bind(channel,channel==='sms'?1:0).run();
 await DB.prepare(`INSERT INTO communication_provider_state VALUES ('twilio',?,?,'now')`).bind(await sha256Hex(env.TWILIO_ACCOUNT_SID+':'+BUSINESS_PHONE),BUSINESS_PHONE).run();
 return {DB,env};
}
const custom=(env,body)=>ownerPost({env,request:request('/api/owner-messages',body,true)});

test('selected-channel email sends once, contains the logo, and never leaves private links in plaintext storage',async t=>{
 const {DB,env}=await setup();let calls=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,options});return Response.json({id:'email-accepted'});});
 const secret='d'.repeat(64);
 await DB.prepare(`UPDATE ride_quotes SET status='issued',customer_token_hash=?`).bind(await sha256Hex(secret)).run();
 const stmt=await notificationStatement(env,'RD-TEST000001','quote_issued','quote-test',{
  quoteReference:'QT-TEST000001',amount:100.01,expiresAt:'2099-01-02',token:secret});
 await stmt.run();await processCommunications(env);await processCommunications(env);
 assert.equal(calls.length,1);assert.equal(calls[0].url,'https://api.resend.com/emails');
 const payload=JSON.parse(calls[0].options.body);assert.deepEqual(payload.to,['test@example.invalid']);
 assert.equal(payload.attachments[0].content_id,'mvbri-logo');assert.ok(payload.html.includes('cid:mvbri-logo'));
 assert.ok(payload.text.includes(secret));assert.ok(payload.text.includes(env.CUSTOMER_SITE_URL));
 const event=await DB.prepare('SELECT payload_ciphertext FROM notification_events').first();assert.equal(event.payload_ciphertext.includes(secret),false);
 const row=await DB.prepare('SELECT * FROM customer_messages').first();assert.equal(row.status,'accepted');assert.equal(row.provider_payload_ciphertext,null);
 assert.equal(row.content_ciphertext.includes(secret),false);
});

test('email retry preserves the exact provider payload and idempotency key',async t=>{
 const {DB,env}=await setup();const calls=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push(options);if(calls.length===1)throw new Error('ambiguous timeout');return Response.json({id:'retried-email'});});
 await(await notificationStatement(env,'RD-TEST000001','booking_received','received-test',{})).run();
 await processCommunications(env);await processCommunications(env);
 assert.equal(calls.length,2);assert.equal(calls[0].body,calls[1].body);
 assert.equal(calls[0].headers['Idempotency-Key'],calls[1].headers['Idempotency-Key']);
 assert.equal((await DB.prepare('SELECT status FROM customer_messages').first()).status,'accepted');
});

test('custom texts require owner access and opted-in recipient; preview freezes the sender, recipient and text',async t=>{
 const {DB,env}=await setup('sms');let calls=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push(new URLSearchParams(options.body));return Response.json({sid:'SM'+'b'.repeat(32)});});
 assert.equal((await ownerGet({env,request:request('/api/owner-messages')})).status,401);
 assert.equal((await ownerPost({env,request:request('/api/owner-messages',{action:'preview'})})).status,401);
 const cross=request('/api/owner-messages',{action:'preview'},true);cross.headers.set('Origin','https://other.invalid');assert.equal((await ownerPost({env,request:cross})).status,403);
 const preview=await(await custom(env,{action:'preview',reference:'RD-TEST000001',message:'I am at the pickup point.'})).json();
 assert.equal(preview.to,'+15550100000');assert.equal(preview.from,BUSINESS_PHONE);assert.equal(calls.length,0);
 const send=()=>custom(env,{action:'send',previewId:preview.previewId,to:'+19999999999',message:'unreviewed replacement'});
 assert.equal((await send()).status,202);assert.equal((await send()).status,202);assert.equal(calls.length,1);
 assert.equal(calls[0].get('To'),preview.to);assert.equal(calls[0].get('From'),BUSINESS_PHONE);
 assert.equal(calls[0].get('Body'),preview.text);
 await DB.prepare(`UPDATE booking_contact_preferences SET channel='email',sms_consent=0`).run();
 assert.equal((await custom(env,{action:'preview',reference:'RD-TEST000001',message:'Test'})).status,409);
});

test('uncertain SMS is not retried; STOP and test-recipient restrictions block sending',async t=>{
 const {DB,env}=await setup('sms');let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('timeout after provider may have accepted');});
 let preview=await(await custom(env,{action:'preview',reference:'RD-TEST000001',message:'First text'})).json();
 await custom(env,{action:'send',previewId:preview.previewId});await drainMessages(env);
 assert.equal(calls,1);assert.equal((await DB.prepare('SELECT status FROM customer_messages WHERE id=?').bind(preview.previewId).first()).status,'uncertain');
 preview=await(await custom(env,{action:'preview',reference:'RD-TEST000001',message:'Second text'})).json();
 await DB.prepare(`INSERT INTO sms_suppressions VALUES ('+15550100000','STOP','now')`).run();
 await custom(env,{action:'send',previewId:preview.previewId});assert.equal(calls,1);
 assert.equal((await DB.prepare('SELECT status FROM customer_messages WHERE id=?').bind(preview.previewId).first()).status,'suppressed');
 await DB.prepare('DELETE FROM sms_suppressions').run();
 env.NOTIFICATION_TEST_PHONE='+15550100001';
 preview=await(await custom(env,{action:'preview',reference:'RD-TEST000001',message:'Third text'})).json();
 await custom(env,{action:'send',previewId:preview.previewId});assert.equal(calls,1);
 assert.equal((await DB.prepare('SELECT status FROM customer_messages WHERE id=?').bind(preview.previewId).first()).status,'held');
});

test('disabled or unverified SMS configuration cannot send from the business number',async()=>{
 const {DB,env}=await setup('sms');
 assert.equal((await deliveryConfiguration(env)).smsAvailable,true);
 env.NOTIFICATION_DELIVERY_MODE='off';assert.equal((await deliveryConfiguration(env)).smsAvailable,false);
 env.NOTIFICATION_DELIVERY_MODE='test';env.TWILIO_PHONE_NUMBER='+15550100001';assert.equal((await deliveryConfiguration(env)).smsAvailable,false);
 env.TWILIO_PHONE_NUMBER=BUSINESS_PHONE;await DB.prepare('DELETE FROM communication_provider_state').run();assert.equal((await deliveryConfiguration(env)).smsAvailable,false);
});

test('quote issue queues the chosen-channel update atomically and a losing token cannot replace the valid link',async t=>{
 const {DB,env}=await setup();t.mock.method(globalThis,'fetch',async()=>Response.json({id:'issued-email'}));
 await DB.prepare(`UPDATE ride_quotes SET status='draft'`).run();
 const result=await issue({env,request:request('/api/quotes/issue',{reference:'QT-TEST000001'},true)});
 assert.equal(result.status,200);const data=await result.json();assert.equal(data.notificationQueued,true);
 const token=new URL(data.quote.customerUrl).searchParams.get('token');
 const winner=await DB.prepare('SELECT token_hash FROM customer_quote_links').first();assert.equal(winner.token_hash,await sha256Hex(token));
 await(await quoteTokenStatement(env,'QT-TEST000001',testToken)).run();
 assert.equal((await DB.prepare('SELECT token_hash FROM customer_quote_links').first()).token_hash,winner.token_hash);
 assert.equal((await issue({env,request:request('/api/quotes/issue',{reference:'QT-TEST000001'},true)})).status,409);
 assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM notification_events').first()).n,1);
});

function twilioRequest(env,path,fields){
 const url=env.CUSTOMER_SITE_URL+path,body=new URLSearchParams({AccountSid:env.TWILIO_ACCOUNT_SID,...fields});
 let signed=url;for(const key of [...body.keys()].sort())signed+=key+body.get(key);
 return new Request(url,{method:'POST',body,headers:{'Content-Type':'application/x-www-form-urlencoded','x-twilio-signature':createHmac('sha1',env.TWILIO_AUTH_TOKEN).update(signed).digest('base64')}});
}
test('signed STOP suppresses future texts, START is one-time, and replayed callbacks cannot undo the latest opt-out',async()=>{
 const {DB,env}=await setup('sms');
 const call=(word,suffix)=>inbound({env,request:twilioRequest(env,'/api/inbound-sms',{From:'+15550100000',To:BUSINESS_PHONE,Body:word,MessageSid:'SM'+suffix.repeat(32)})});
 assert.equal((await inbound({env,request:request('/api/inbound-sms',{})})).status,401);
 assert.equal((await call('STOP','a')).status,200);
 assert.ok(await DB.prepare('SELECT * FROM sms_suppressions').first());
 await call('START','b');assert.equal(await DB.prepare('SELECT * FROM sms_suppressions').first(),null);
 await call('STOP','c');await call('START','b');
 assert.ok(await DB.prepare('SELECT * FROM sms_suppressions').first());
});

test('only a matching signed delivery callback confirms SMS delivery; late sent callbacks do not downgrade it',async t=>{
 const {DB,env}=await setup('sms'),sid='SM'+'d'.repeat(32);
 t.mock.method(globalThis,'fetch',async()=>Response.json({sid}));
 const preview=await(await custom(env,{action:'preview',reference:'RD-TEST000001',message:'Pickup confirmation'})).json();
 await custom(env,{action:'send',previewId:preview.previewId});
 const path='/api/message-status?mid='+preview.previewId;
 const fields={From:BUSINESS_PHONE,To:preview.to,MessageSid:sid,MessageStatus:'delivered'};
 assert.equal((await deliveryCallback({env,request:request(path,{})})).status,401);
 assert.equal((await deliveryCallback({env,request:twilioRequest(env,path,{...fields,To:'+15550100001'})})).status,409);
 assert.equal((await deliveryCallback({env,request:twilioRequest(env,path,fields)})).status,200);
 await deliveryCallback({env,request:twilioRequest(env,path,{...fields,MessageStatus:'sent'})});
 assert.equal((await DB.prepare('SELECT status FROM customer_messages WHERE id=?').bind(preview.previewId).first()).status,'delivered');
});

test('preference changes require the private link and suppress queued messages after opting out',async t=>{
 const {DB,env}=await setup();let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({id:'unused'});});
 const reference='RD-TEST000001',token=await linkToken(env,'updates',reference);
 const make=body=>changePreference({env,request:request('/api/contact-preference',body)});
 assert.equal((await make({reference,token:'a'.repeat(64),contactPreference:'none'})).status,404);
 await(await notificationStatement(env,reference,'booking_received','received-optout',{})).run();
 await (await import('../functions/_lib/communications.js')).stageNotifications(env);
 assert.equal((await make({reference,token,contactPreference:'none'})).status,200);
 await drainMessages(env);assert.equal(calls,0);
 assert.equal((await DB.prepare('SELECT status FROM customer_messages').first()).status,'suppressed');
});

test('business sender verification reads the official IncomingPhoneNumbers response and never provisions a number',async t=>{
 const {DB,env}=await setup('sms');await DB.prepare('DELETE FROM communication_provider_state').run();
 let calls=[];t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,options});return Response.json({incoming_phone_numbers:[{account_sid:env.TWILIO_ACCOUNT_SID,phone_number:BUSINESS_PHONE,capabilities:{sms:true}}]});});
 const response=await custom(env,{action:'check_sender'});assert.equal(response.status,200);assert.equal((await response.json()).senderVerified,true);
 assert.equal(calls.length,1);assert.equal(calls[0].options.method,undefined);assert.ok(calls[0].url.includes('/IncomingPhoneNumbers.json?'));
 assert.equal((await deliveryConfiguration(env)).smsAvailable,true);
});

test('delivery callback can safely retry after a database failure before its atomic status update',async t=>{
 const {DB,env}=await setup('sms'),sid='SM'+'e'.repeat(32);t.mock.method(globalThis,'fetch',async()=>Response.json({sid}));
 const preview=await(await custom(env,{action:'preview',reference:'RD-TEST000001',message:'Test pickup update'})).json();await custom(env,{action:'send',previewId:preview.previewId});
 const path='/api/message-status?mid='+preview.previewId,fields={From:BUSINESS_PHONE,To:preview.to,MessageSid:sid,MessageStatus:'delivered'},batch=DB.batch.bind(DB);let fail=true;
 t.mock.method(DB,'batch',async statements=>{if(fail){fail=false;throw new Error('Transient database failure');}return batch(statements);});
 assert.equal((await deliveryCallback({env,request:twilioRequest(env,path,fields)})).status,400);
 assert.equal((await deliveryCallback({env,request:twilioRequest(env,path,fields)})).status,200);
 assert.equal((await DB.prepare('SELECT status FROM customer_messages WHERE id=?').bind(preview.previewId).first()).status,'delivered');
});
