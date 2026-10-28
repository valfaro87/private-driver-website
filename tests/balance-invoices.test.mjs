import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database,fixture,request,testToken,squareEnv } from './helpers/database.mjs';
import { onRequestPost as checkout } from '../functions/api/square-checkout.js';
import { onRequestPost as check } from '../functions/api/square-status.js';
import { onRequestGet as ownerGet,onRequestPost as ownerPost } from '../functions/api/owner-balances.js';
import { onRequestPost as webhook } from '../functions/api/square-webhook.js';
import { paymentSummary } from '../functions/_lib/square.js';

async function ready(DB) {
  await fixture(DB);
  await DB.prepare(`UPDATE bookings SET status='completed'`).run();
  await DB.prepare(`INSERT INTO square_payments (quote_reference,booking_reference,payment_type,amount_cents,status,
    square_environment,square_payment_id,created_at,updated_at) VALUES
    ('QT-TEST000001','RD-TEST000001','deposit',5001,'paid','sandbox','deposit-paid','now','now')`).run();
}

function provider(t) {
  const calls=[], saved=new Map();
  let status='UNPAID', paid=0, state='OPEN', payments=[], refund=0;
  let loseOrderResponse=false, orderResponseLost=false;
  const invoice=()=>({id:'inv:0-test',version:1,location_id:'test-location',order_id:'balance-order',
    primary_recipient:{customer_id:'balance-customer'},status,
    public_url:'https://squareupsandbox.com/pay-invoice/inv:0-test',
    payment_requests:[{computed_amount_money:{amount:5000,currency:'USD'},
      total_completed_amount_money:{amount:paid,currency:'USD'}}]});
  t.mock.method(globalThis,'fetch',async(url,options={})=>{
    const path=new URL(url).pathname, body=options.body ? JSON.parse(options.body) : undefined;
    calls.push({path,body});
    if(body?.idempotency_key) {
      const old=saved.get(body.idempotency_key);
      if(old)assert.deepEqual(body,old,'Retries must preserve the exact provider request');
      else saved.set(body.idempotency_key,body);
    }
    if(path==='/v2/customers')return Response.json({customer:{id:'balance-customer'}});
    if(path==='/v2/orders') {
      assert.equal(body.order.line_items[0].base_price_money.amount,5000);
      if(loseOrderResponse && !orderResponseLost){orderResponseLost=true;throw new Error('lost response after Square accepted order');}
      return Response.json({order:{id:'balance-order',location_id:'test-location',state:'OPEN',total_money:{amount:5000,currency:'USD'}}});
    }
    if(path==='/v2/invoices')return Response.json({invoice:{...invoice(),status:'DRAFT',version:0}});
    if(path==='/v2/invoices/inv%3A0-test/publish')return Response.json({invoice:invoice()});
    if(path==='/v2/invoices/inv%3A0-test')return Response.json({invoice:invoice()});
    if(path==='/v2/orders/balance-order')return Response.json({order:{id:'balance-order',location_id:'test-location',state,
      reference_id:'QT-TEST000001-balance',total_money:{amount:5000,currency:'USD'},
      tenders:payments.map(p=>({payment_id:p.id}))}});
    const p=payments.find(p=>path==='/v2/payments/'+p.id);
    if(p)return Response.json({payment:{status:'COMPLETED',source_type:'CARD',location_id:'test-location',
      order_id:'balance-order',amount_money:{amount:p.amount,currency:'USD'},refunded_money:{amount:refund,currency:'USD'},...p}});
    throw new Error('Unexpected provider request '+path);
  });
  return {calls,saved,set(value){({status=status,paid=paid,state=state,payments=payments,refund=refund,
    loseOrderResponse=loseOrderResponse}=value);}};
}

const customer=(env,method='online')=>checkout({env,request:request('/api/square-checkout',{
  token:testToken,paymentType:'balance',collectionMethod:method,amount:1})});
const status=env=>check({env,request:request('/api/square-status',{token:testToken,status:'paid'})});

test('online and reader use one balance invoice for fare minus verified deposit, with no automatic messages or charges',async t=>{
  const DB=database();await ready(DB);const env=squareEnv(DB), p=provider(t);
  const online=await customer(env);assert.equal(online.status,200);
  const first=await online.json();assert.equal(first.amount,50);assert.equal(first.inPerson,false);
  const reader=await ownerPost({env,request:request('/api/owner-balances',{reference:'QT-TEST000001',action:'prepare',amount:1},true)});
  assert.equal(reader.status,200);
  const second=await reader.json();assert.equal(second.checkoutUrl,first.checkoutUrl);assert.equal(second.inPerson,true);
  assert.equal(p.calls.filter(c=>c.path==='/v2/orders').length,1);
  const create=p.calls.find(c=>c.path==='/v2/invoices').body.invoice;
  assert.equal(create.delivery_method,'SHARE_MANUALLY');assert.equal(create.payment_requests[0].automatic_payment_source,'NONE');
  assert.equal(create.payment_requests[0].tipping_enabled,false);
  assert.equal(JSON.stringify(p.calls).includes('Test pickup address'),false);
  assert.equal(JSON.stringify(p.calls).includes('PRIVATE NOTE'),false);
  const summary=await paymentSummary(env,await DB.prepare('SELECT * FROM ride_quotes').first());
  assert.equal(summary.balanceMethod,'reader');assert.equal(summary.canPayInPerson,true);
  assert.equal((await customer(env)).status,200);assert.equal(p.calls.filter(c=>c.path==='/v2/invoices').length,1);
});

test('owner authentication, origin, verified deposit and completed ride gate every reader charge preparation',async t=>{
  const DB=database();await fixture(DB);const env=squareEnv(DB);let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('No provider call permitted');});
  assert.equal((await ownerGet({env,request:request('/api/owner-balances')})).status,401);
  assert.equal((await ownerPost({env,request:request('/api/owner-balances',{reference:'QT-TEST000001',action:'prepare'})})).status,401);
  const cross=request('/api/owner-balances',{reference:'QT-TEST000001',action:'prepare'},true);
  cross.headers.set('Origin','https://other.invalid');assert.equal((await ownerPost({env,request:cross})).status,403);
  assert.equal((await customer(env,'reader')).status,409);
  await DB.prepare(`UPDATE bookings SET status='completed'`).run();
  assert.equal((await customer(env,'reader')).status,409);assert.equal(calls,0);
});

test('an ambiguous provider timeout resumes the same invoice workflow instead of creating another balance',async t=>{
  const DB=database();await ready(DB);const env=squareEnv(DB),p=provider(t);
  p.set({loseOrderResponse:true});assert.equal((await customer(env,'reader')).status,503);
  await DB.prepare(`UPDATE bookings SET name='Changed name',email='changed@example.invalid'`).run();
  assert.equal((await customer(env)).status,200);
  const orders=p.calls.filter(c=>c.path==='/v2/orders');assert.equal(orders.length,2);assert.deepEqual(orders[0].body,orders[1].body);
  assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM square_payments WHERE payment_type='balance'`).first()).n,1);
});

test('partial reader payments remain outstanding; verified final online payment settles the same balance once',async t=>{
  const DB=database();await ready(DB);const env=squareEnv(DB),p=provider(t);
  assert.equal((await customer(env,'reader')).status,200);
  p.set({status:'PARTIALLY_PAID',paid:2000,payments:[{id:'reader-part',amount:2000}]});
  const partial=(await (await status(env)).json()).payments;
  assert.equal(partial.balancePaid,false);assert.equal(partial.balance,30);
  assert.equal((await (await customer(env)).json()).amount,30);
  p.set({status:'PAID',paid:5000,state:'COMPLETED',payments:[{id:'reader-part',amount:2000},{id:'web-part',amount:3000}]});
  const verified=await (await status(env)).json();assert.equal(verified.verified,1);
  assert.equal(verified.payments.balancePaid,true);assert.equal(verified.payments.canPayBalance,false);
  assert.equal(verified.payments.canPayInPerson,false);
  assert.equal((await (await status(env)).json()).verified,0);
  assert.equal((await customer(env)).status,409);
  const entry=await DB.prepare('SELECT verified_payment_ids FROM square_balance_invoices').first();
  assert.deepEqual(JSON.parse(entry.verified_payment_ids),['reader-part','web-part']);
});

test('manually marking an invoice paid is not proof of a processed card payment; overpayments and refunds need review',async t=>{
  const DB=database();await ready(DB);const env=squareEnv(DB),p=provider(t);
  assert.equal((await customer(env)).status,200);
  p.set({status:'PAID',paid:5000,state:'COMPLETED',payments:[{id:'manual',amount:5000,source_type:'EXTERNAL'}]});
  let summary=(await (await status(env)).json()).payments;
  assert.equal(summary.balancePaid,false);assert.equal(summary.balanceNeedsReview,true);assert.equal(summary.canPayBalance,false);
  p.set({payments:[{id:'over',amount:5001}]});summary=(await (await status(env)).json()).payments;
  assert.equal(summary.balancePaid,false);assert.equal(summary.balanceNeedsReview,true);
  p.set({status:'REFUNDED',paid:5000,payments:[{id:'refunded-card',amount:5000}],refund:5000});
  summary=(await (await status(env)).json()).payments;assert.equal(summary.balancePaid,false);
  assert.equal(summary.canPayBalance,false);assert.equal(summary.canPayInPerson,false);
});

test('legacy online balance links retain their existing checkout and cannot create a separate reader sale',async t=>{
  const DB=database();await ready(DB);const env=squareEnv(DB);
  await DB.prepare(`INSERT INTO square_payments (quote_reference,booking_reference,payment_type,amount_cents,status,
    square_environment,square_order_id,square_payment_link_id,checkout_url,created_at,updated_at) VALUES
    ('QT-TEST000001','RD-TEST000001','balance',5000,'pending','sandbox','old-order','old-link','https://sandbox.square.link/u/old','now','now')`).run();
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('Existing checkout must be retained');});
  assert.equal((await customer(env,'reader')).status,409);
  assert.equal((await (await customer(env)).json()).checkoutUrl,'https://sandbox.square.link/u/old');
  assert.equal((await paymentSummary(env,await DB.prepare('SELECT * FROM ride_quotes').first())).canPayInPerson,false);
});

test('wrong-location, wrong-order, uncompleted or wrong-currency payments cannot settle a balance',async t=>{
  const DB=database();await ready(DB);const env=squareEnv(DB),p=provider(t);
  assert.equal((await customer(env)).status,200);
  for(const bad of [{location_id:'another-location'},{order_id:'another-order'},{status:'APPROVED'},
    {amount_money:{amount:5000,currency:'CAD'}}]) {
    p.set({status:'PAID',paid:5000,state:'COMPLETED',payments:[{id:'candidate',amount:5000,...bad}]});
    const response=await ownerPost({env,request:request('/api/owner-balances',{reference:'QT-TEST000001',action:'check'},true)});
    assert.equal((await response.json()).payments.balancePaid,false);
  }
  p.set({payments:[{id:'valid-reader-card',amount:5000}]});
  const result=await ownerPost({env,request:request('/api/owner-balances',{reference:'QT-TEST000001',action:'check'},true)});
  assert.equal((await result.json()).payments.balancePaid,true);
});

test('a signed reader-payment webhook verifies the invoice and clears both online and reader payment choices',async t=>{
  const DB=database();await ready(DB);const env=squareEnv(DB),p=provider(t);
  assert.equal((await customer(env,'reader')).status,200);
  p.set({status:'PAID',paid:5000,state:'COMPLETED',payments:[{id:'reader-completed',amount:5000}]});
  const body=JSON.stringify({event_id:'reader-event',type:'payment.updated',data:{object:{payment:{id:'reader-completed'}}}});
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.SQUARE_WEBHOOK_SIGNATURE_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(env.SQUARE_WEBHOOK_URL+body))).toString('base64');
  const make=()=>webhook({env,request:new Request(env.SQUARE_WEBHOOK_URL,{method:'POST',body,
    headers:{'x-square-hmacsha256-signature':signature}})});
  assert.equal((await make()).status,200);assert.equal((await make()).status,200);
  const summary=await paymentSummary(env,await DB.prepare('SELECT * FROM ride_quotes').first());
  assert.equal(summary.balancePaid,true);assert.equal(summary.balance,0);
  assert.equal(summary.canPayBalance,false);assert.equal(summary.canPayInPerson,false);
});
