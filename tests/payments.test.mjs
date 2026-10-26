import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database,fixture,request,testToken,squareEnv } from './helpers/database.mjs';
import { onRequestPost as checkout } from '../functions/api/square-checkout.js';
import { onRequestPost as webhook } from '../functions/api/square-webhook.js';
import { squareConfig, paymentSummary } from '../functions/_lib/square.js';

test('live methods require explicit activation; Sandbox advertises test cards only',()=>{
 const env=squareEnv(null);
 assert.deepEqual(squareConfig(env).methods,['Credit / debit test card']);
 env.SQUARE_ENVIRONMENT='production';assert.equal(squareConfig(env),null);
 env.SQUARE_LIVE_PAYMENTS_APPROVED='true';assert.equal(squareConfig(env).methods.length,4);
});
test('checkout derives amount, reuses links and safely retries the same provider request',async t=>{
 const DB=database();await fixture(DB);const env=squareEnv(DB);
 let calls=[];let fail=true;
 t.mock.method(globalThis,'fetch',async(url,opts)=>{
  calls.push({url,payload:JSON.parse(opts.body)});
  if(fail){fail=false;throw new Error('simulated timeout');}
  return Response.json({payment_link:{id:'test-link',order_id:'test-order',url:'https://sandbox.square.link/u/test'}});
 });
 const make=()=>checkout({env,request:request('/api/square-checkout',{token:testToken,paymentType:'deposit',amount:1})});
 assert.equal((await make()).status,503);
 assert.equal((await make()).status,200);
 assert.deepEqual(calls[0],calls[1]);assert.equal(calls[0].payload.quick_pay.price_money.amount,5001);
 assert.equal((await make()).status,200);assert.equal(calls.length,2);
 assert.equal((await checkout({env,request:request('/api/square-checkout',{token:testToken,paymentType:'balance'})})).status,409);
});
test('verified matching signed webhook records a payment once; tampering fails',async t=>{
 const DB=database();await fixture(DB);const env=squareEnv(DB);
 await DB.prepare(`INSERT INTO square_payments (quote_reference,booking_reference,payment_type,amount_cents,
  status,square_environment,square_order_id,created_at,updated_at) VALUES ('QT-TEST000001','RD-TEST000001','deposit',5001,
  'pending','sandbox','test-order','now','now')`).run();
 t.mock.method(globalThis,'fetch',async()=>Response.json({payment:{id:'test-payment',status:'COMPLETED',location_id:'test-location',
  order_id:'test-order',amount_money:{amount:5001,currency:'USD'}}}));
 const body=JSON.stringify({event_id:'test-event',type:'payment.updated',data:{object:{payment:{id:'test-payment'}}}});
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode('test-key'),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const sig=Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(env.SQUARE_WEBHOOK_URL+body))).toString('base64');
 const req=(signature)=>new Request(env.SQUARE_WEBHOOK_URL,{method:'POST',body,headers:{'x-square-hmacsha256-signature':signature}});
 assert.equal((await webhook({env,request:req('invalid')})).status,401);
 assert.equal((await webhook({env,request:req(sig)})).status,200);
 assert.equal((await webhook({env,request:req(sig)})).status,200);
 assert.equal((await DB.prepare('SELECT status FROM square_payments').first()).status,'paid');
 await DB.prepare(`UPDATE bookings SET status='completed'`).run();
 const quote=await DB.prepare('SELECT * FROM ride_quotes').first();
 const summary=await paymentSummary(env,quote);
 assert.equal(summary.canPayBalance,true);assert.equal(summary.balance,50);
});

test('private status verification requires provider-confirmed matching payment, not browser claims',async t=>{
 const {onRequestPost:check}=await import('../functions/api/square-status.js');
 const DB=database();await fixture(DB);const env=squareEnv(DB);
 delete env.SQUARE_WEBHOOK_SIGNATURE_KEY;delete env.SQUARE_WEBHOOK_URL;
 await DB.prepare(`INSERT INTO square_payments (quote_reference,booking_reference,payment_type,amount_cents,
  status,square_environment,square_order_id,created_at,updated_at) VALUES ('QT-TEST000001','RD-TEST000001','deposit',5001,
  'pending','sandbox','test-order','now','now')`).run();
 let amount=1;let providerCalls=0;
 t.mock.method(globalThis,'fetch',async(url)=>{
  providerCalls++;
  if(url.endsWith('/orders/test-order'))return Response.json({order:{id:'test-order',location_id:'test-location',tenders:[{payment_id:'test-payment'}]}});
  if(url.endsWith('/payments/test-payment'))return Response.json({payment:{id:'test-payment',status:'COMPLETED',location_id:'test-location',
    order_id:'test-order',amount_money:{amount,currency:'USD'}}});
  throw new Error('Unexpected provider call');
 });
 const make=(token)=>check({env,request:request('/api/square-status',{token,status:'paid'})});
 assert.equal((await make('c'.repeat(64))).status,409);assert.equal(providerCalls,0);
 assert.equal((await (await make(testToken)).json()).payments.depositPaid,false);
 amount=5001;
 assert.equal((await (await make(testToken)).json()).payments.depositPaid,true);
 const calls=providerCalls;
 assert.equal((await make(testToken)).status,200);assert.equal(providerCalls,calls);
 const record=await DB.prepare('SELECT status,square_payment_id FROM square_payments').first();
 assert.equal(record.status,'paid');assert.equal(record.square_payment_id,'test-payment');
});
