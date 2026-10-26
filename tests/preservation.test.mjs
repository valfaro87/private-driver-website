import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database,fixture,request,testToken } from './helpers/database.mjs';
import { onRequestGet as getQuote,onRequestPost as respond } from '../functions/api/quotes/customer.js';
import { onRequestGet as bookings } from '../functions/api/bookings.js';
import { onRequestPost as tip } from '../functions/api/tips.js';
import { onRequestGet as pricing } from '../functions/api/pricing.js';

test('quote response is one-time; expired quotes fail; owner notes remain private',async()=>{
 const DB=database();await fixture(DB,'issued');const env={DB};
 const get=()=>getQuote({env,request:request('/api/quotes/customer?token='+testToken)});
 assert.equal(JSON.stringify(await (await get()).json()).includes('PRIVATE NOTE'),false);
 const accept=()=>respond({env,request:request('/api/quotes/customer',{token:testToken,action:'accept'})});
 assert.equal((await accept()).status,200);assert.equal((await accept()).status,409);
 await DB.prepare(`UPDATE ride_quotes SET status='issued',expires_at=?`).bind(new Date(Date.now()-1000).toISOString()).run();
 assert.equal((await accept()).status,409);
 assert.equal((await (await get()).json()).quote.status,'expired');
});
test('booking dashboard and pricing remain owner-only; tips still require completed rides',async()=>{
 const DB=database();await fixture(DB);const env={DB};
 assert.equal((await bookings({env,request:request('/api/bookings')})).status,401);
 assert.equal((await bookings({env,request:request('/api/bookings',undefined,true)})).status,200);
 const settings=await (await pricing({env,request:request('/api/pricing',undefined,true)})).json();
 assert.equal(settings.minimumFare,50);assert.equal(settings.pricePerMile,2.5);assert.equal(settings.expirationHours,24);
 const make=()=>tip({env,request:request('/api/tips',{bookingReference:'RD-TEST000001',amount:10},true)});
 assert.equal((await make()).status,409);
 await DB.prepare(`UPDATE bookings SET status='completed'`).run();
 const result=await make();assert.equal(result.status,201);
 assert.equal((await DB.prepare('SELECT amount_cents FROM trip_tips').first()).amount_cents,1000);
});

test('booking form still validates protection before storing a new request',async t=>{
 const {onRequestPost}=await import('../functions/api/bookings.js');
 const DB=database();const env={DB,TURNSTILE_SECRET_KEY:'test-only',BOOKING_RATE_LIMITER:{
  idFromName:x=>x,get:()=>({fetch:async()=>Response.json({allowed:true})})}};
 t.mock.method(globalThis,'fetch',async()=>Response.json({success:true,hostname:'private-driver-website.pages.dev'}));
 const body={name:'QA Customer',phone:'5550100000',email:'test@example.invalid',pickup:'QA pickup',destination:'QA destination',
  date:'2099-01-01',time:'12:00',passengers:'1',trip:'One-way',additionalStops:['QA stop'],turnstileToken:'test-only'};
 const make=b=>onRequestPost({env,request:new Request('https://test.invalid/api/bookings',{method:'POST',headers:{
  Origin:'https://test.invalid','Content-Type':'application/json','CF-Connecting-IP':'192.0.2.1'},body:JSON.stringify(b)})});
 assert.equal((await make({...body,turnstileToken:''})).status,403);
 assert.equal((await DB.prepare('SELECT COUNT(*) AS total FROM bookings').first()).total,0);
 const response=await make(body);assert.equal(response.status,201);
 const saved=await DB.prepare('SELECT status,additional_stops FROM bookings').first();
 assert.equal(saved.status,'new');assert.equal(saved.additional_stops,'["QA stop"]');
 env.TURNSTILE_ALLOWED_HOSTNAMES='preview.private-driver-website.pages.dev';
 assert.equal((await make(body)).status,403);
 t.mock.method(globalThis,'fetch',async()=>Response.json({success:true,hostname:'preview.private-driver-website.pages.dev'}));
 assert.equal((await make(body)).status,201);
});
