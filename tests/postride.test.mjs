import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database,fixture,request,squareEnv,testToken} from './helpers/database.mjs';
import {ensureReceipt,receiptLinks,fareState} from '../functions/_lib/postride.js';
import {processCommunications} from '../functions/_lib/communications.js';
import {onRequestGet as receiptGet} from '../functions/api/ride-receipt.js';
import {onRequestPost as tipPost} from '../functions/api/tip-checkout.js';
import {onRequestPost as verifyPayment} from '../functions/api/square-status.js';
import worker,{runCommunicationJob} from '../workers/communications.js';
import {encryptMessage} from '../functions/_lib/communications-crypto.js';

async function setup(channel='email'){
 const DB=database();await fixture(DB);
 const env={...squareEnv(DB),COMMUNICATIONS_ENCRYPTION_KEY:'c'.repeat(64),NOTIFICATION_DELIVERY_MODE:'test',EMAIL_NOTIFICATIONS_ENABLED:'true',RESEND_API_KEY:'test-only',NOTIFICATION_TEST_EMAIL:'test@example.invalid',CUSTOMER_SITE_URL:'https://mvbri-private-upgrades-20261.private-driver-website.pages.dev'};
 if(channel)await DB.prepare(`INSERT INTO booking_contact_preferences VALUES ('RD-TEST000001',?,0,'test','now','now')`).bind(channel).run();
 return {DB,env};
}
async function payment(DB,type,status='paid',mode='sandbox'){
 await DB.prepare(`INSERT INTO square_payments(quote_reference,booking_reference,payment_type,amount_cents,currency,status,square_environment,square_order_id,square_payment_id,created_at,updated_at,paid_at) VALUES ('QT-TEST000001','RD-TEST000001',?,?,'USD',?,?,?,?,'now','now','2099-01-01T13:00:00Z')`).bind(type,type==='deposit'?5001:5000,status,mode,'order-'+type,status==='paid'?'payment-'+type:null).run();
}
async function ready(env){await payment(env.DB,'deposit');await payment(env.DB,'balance');await env.DB.prepare(`UPDATE bookings SET status='completed'`).run();const record=await ensureReceipt(env,'QT-TEST000001');return receiptLinks(env,record,env.CUSTOMER_SITE_URL);}
function credentials(links){const u=new URL(links.receiptUrl);return {reference:u.searchParams.get('ref'),token:u.searchParams.get('token')};}

test('receipt and optional-tip message follows completed ride plus provider-verified full fare exactly once',async t=>{
 const {DB,env}=await setup();const emails=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(String(url)==='https://api.resend.com/emails'){emails.push(JSON.parse(options.body));return Response.json({id:'mail-'+emails.length});}
  if(String(url).endsWith('/orders/order-balance'))return Response.json({order:{id:'order-balance',location_id:'test-location',tenders:[{payment_id:'paid-balance'}]}});
  if(String(url).endsWith('/payments/paid-balance'))return Response.json({payment:{id:'paid-balance',status:'COMPLETED',source_type:'CARD',location_id:'test-location',order_id:'order-balance',amount_money:{amount:5000,currency:'USD'}}});
  throw new Error('Unexpected provider call');
 });
 await payment(DB,'deposit');await payment(DB,'balance','pending');await processCommunications(env);
 assert.equal(emails.length,1);assert.match(emails[0].text,/deposit/);assert.equal(await ensureReceipt(env,'QT-TEST000001'),null);
 await DB.prepare(`UPDATE bookings SET status='completed'`).run();await processCommunications(env);assert.equal(emails.length,1);
 assert.equal((await verifyPayment({env,request:request('/api/square-status',{token:testToken})})).status,200);
 assert.equal(emails.length,2);assert.match(emails[1].text,/receipt.html/);assert.match(emails[1].text,/tip.html/);assert.equal(emails[1].attachments[0].content_id,'mvbri-logo');
 await processCommunications(env);assert.equal(emails.length,2);
 const record=await ensureReceipt(env,'QT-TEST000001'),links=await receiptLinks(env,record,env.CUSTOMER_SITE_URL),auth=credentials(links);
 const result=await receiptGet({env,request:request('/api/ride-receipt?'+new URLSearchParams({ref:auth.reference,token:auth.token}))});assert.equal(result.status,200);const body=await result.json();
 assert.equal(body.fare,100.01);assert.equal(body.deposit,50.01);assert.equal(body.balancePaid,50);for(const key of ['name','email','phone','pickup','destination','owner_notes'])assert.equal(body[key],undefined);
 assert.equal((await receiptGet({env,request:request('/api/ride-receipt?ref='+auth.reference+'&token='+'0'.repeat(64))})).status,404);
 assert.equal(JSON.stringify((await DB.prepare('SELECT * FROM postride_receipts').all()).results).includes(auth.token),false);
});

test('no historical consent, wrong payment environment/amount, pending ride or reviewed invoice can trigger receipt delivery',async t=>{
 const {DB,env}=await setup(null);let sends=0;t.mock.method(globalThis,'fetch',async()=>{sends++;return Response.json({id:'mail'});});
 await ready(env);await processCommunications(env);assert.equal(sends,0);
 await DB.prepare(`UPDATE square_payments SET square_environment='production' WHERE payment_type='deposit'`).run();assert.equal(await ensureReceipt(env,'QT-TEST000001'),null);
 await DB.prepare(`UPDATE square_payments SET square_environment='sandbox',amount_cents=1 WHERE payment_type='deposit'`).run();assert.equal((await fareState(env,'QT-TEST000001')).fullyPaid,false);
 await DB.prepare(`UPDATE square_payments SET amount_cents=5001 WHERE payment_type='deposit'`).run();
 const balance=await DB.prepare(`SELECT id FROM square_payments WHERE payment_type='balance'`).first();await DB.prepare(`UPDATE square_payments SET checkout_key='mvbri-invoice-balance-test' WHERE id=?`).bind(balance.id).run();
 await DB.prepare(`INSERT INTO square_balance_invoices(payment_id,verified_amount_cents,review_required,created_at,updated_at) VALUES (?,5000,1,'now','now')`).bind(balance.id).run();assert.equal((await fareState(env,'QT-TEST000001')).fullyPaid,false);
});

test('optional-tip checkout is privately gated, retries the saved amount/key, and never changes the fare balance',async t=>{
 const {DB,env}=await setup(),auth=credentials(await ready(env));const calls=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push(options.body);if(calls.length===1)throw new Error('ambiguous timeout');return Response.json({payment_link:{id:'tip-link',order_id:'tip-order',url:'https://sandbox.square.link/u/test-tip'}});});
 const post=body=>tipPost({env,request:request('/api/tip-checkout',{...auth,action:'checkout',amount:10,...body})});
 assert.equal((await post({token:'0'.repeat(64)})).status,409);assert.equal((await post({amount:1.001})).status,400);
 const cross=request('/api/tip-checkout',{...auth,action:'checkout',amount:10});cross.headers.set('Origin','https://other.invalid');assert.equal((await tipPost({env,request:cross})).status,403);
 assert.equal((await post({})).status,503);assert.equal((await post({amount:20})).status,409);assert.equal(calls.length,1);
 assert.equal((await post({})).status,200);assert.equal(calls[0],calls[1]);assert.equal((await post({})).status,200);assert.equal(calls.length,2);
 assert.equal((await DB.prepare(`SELECT SUM(amount_cents) AS amount FROM square_payments WHERE status='paid'`).first()).amount,10001);
 await DB.prepare(`UPDATE bookings SET status='cancelled'`).run();assert.equal((await post({})).status,409);
});

test('optional tip is verified from its matching Square payment, remains separate, and cannot be paid twice',async t=>{
 const {DB,env}=await setup(),auth=credentials(await ready(env));let paymentAmount=999,paymentStatus='COMPLETED',refunded=0;
 t.mock.method(globalThis,'fetch',async(url)=>{
  if(String(url).endsWith('/payment-links'))return Response.json({payment_link:{id:'tip-link',order_id:'tip-order',url:'https://sandbox.square.link/u/test-tip'}});
  if(String(url).endsWith('/orders/tip-order'))return Response.json({order:{id:'tip-order',location_id:'test-location',tenders:[{payment_id:'tip-payment'}]}});
  return Response.json({payment:{id:'tip-payment',status:paymentStatus,source_type:'CARD',order_id:'tip-order',location_id:'test-location',amount_money:{amount:paymentAmount,currency:'USD'},refunded_money:{amount:refunded,currency:'USD'}}});
 });
 const post=action=>tipPost({env,request:request('/api/tip-checkout',{...auth,action,amount:10})});
 await post('checkout');assert.equal((await(await post('check')).json()).status,'pending');paymentAmount=1000;paymentStatus='APPROVED';assert.equal((await(await post('check')).json()).status,'pending');
 paymentStatus='COMPLETED';assert.equal((await(await post('check')).json()).status,'paid');assert.equal((await post('checkout')).status,409);
 assert.equal((await fareState(env,auth.reference)).fullyPaid,true);assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM square_tip_checkouts').first()).n,1);
 refunded=1000;assert.equal((await(await post('check')).json()).status,'refunded');
});

test('scheduled job verifies payment without a customer return, sends receipt, expires quotes, and never exposes an HTTP job endpoint',async t=>{
 const {DB,env}=await setup();await payment(DB,'deposit');await payment(DB,'balance','pending');await DB.prepare(`UPDATE bookings SET status='completed'`).run();let messages=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(String(url)==='https://api.resend.com/emails'){messages.push(JSON.parse(options.body));return Response.json({id:'job-email-'+messages.length});}
  if(String(url).endsWith('/orders/order-balance'))return Response.json({order:{id:'order-balance',location_id:'test-location',tenders:[{payment_id:'job-balance'}]}});
  return Response.json({payment:{id:'job-balance',status:'COMPLETED',source_type:'CARD',location_id:'test-location',order_id:'order-balance',amount_money:{amount:5000,currency:'USD'}}});
 });
 await runCommunicationJob(env);await runCommunicationJob(env);assert.equal(messages.filter(x=>x.subject==='Your MVBRI receipt').length,1);assert.equal((await worker.fetch()).status,404);
 await DB.prepare(`UPDATE ride_quotes SET status='issued',expires_at='2020-01-01'`).run();await runCommunicationJob(env);assert.equal((await DB.prepare('SELECT status FROM ride_quotes').first()).status,'expired');assert.equal(messages.filter(x=>x.text.includes('expired before acceptance')).length,1);
 const encrypted=await encryptMessage(env,{subject:'Test',text:'Test',links:[]});
 await DB.prepare(`INSERT INTO customer_messages(id,event_key,booking_reference,channel,destination,sender,content_ciphertext,status,first_attempt_at,created_at,updated_at) VALUES ('stale-sms','custom:stale','RD-TEST000001','sms','+15550100000','+13465575796',?,'sending','2020-01-01','2020-01-01','2020-01-01')`).bind(encrypted).run();
 await runCommunicationJob(env);assert.equal((await DB.prepare(`SELECT status FROM customer_messages WHERE id='stale-sms'`).first()).status,'uncertain');
});

test('signed Square webhook records the separate optional tip without changing the fare ledger',async t=>{
 const {onRequestPost:callback}=await import('../functions/api/square-webhook.js');
 const {createHmac}=await import('node:crypto');const {DB,env}=await setup(),auth=credentials(await ready(env));
 t.mock.method(globalThis,'fetch',async(url)=>String(url).endsWith('/payment-links')?Response.json({payment_link:{id:'tip-link',order_id:'tip-order',url:'https://sandbox.square.link/u/test-tip'}}):Response.json({payment:{id:'tip-webhook-payment',status:'COMPLETED',source_type:'CARD',location_id:'test-location',order_id:'tip-order',amount_money:{amount:1200,currency:'USD'}}}));
 await tipPost({env,request:request('/api/tip-checkout',{...auth,action:'checkout',amount:12})});
 const body=JSON.stringify({event_id:'tip-webhook',type:'payment.updated',data:{object:{payment:{id:'tip-webhook-payment'}}}}),signature=createHmac('sha256',env.SQUARE_WEBHOOK_SIGNATURE_KEY).update(env.SQUARE_WEBHOOK_URL+body).digest('base64');
 const req=()=>new Request(env.SQUARE_WEBHOOK_URL,{method:'POST',headers:{'x-square-hmacsha256-signature':signature},body});
 assert.equal((await callback({env,request:req()})).status,200);assert.equal((await callback({env,request:req()})).status,200);
 assert.equal((await DB.prepare('SELECT status FROM square_tip_checkouts').first()).status,'paid');assert.equal((await DB.prepare('SELECT SUM(amount_cents) AS amount FROM square_payments').first()).amount,10001);
});
