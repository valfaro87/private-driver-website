import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database,fixture,request } from './helpers/database.mjs';
import { onRequestPost } from '../functions/api/route-mileage.js';
test('route mileage is owner-only, includes ordered stops and a round-trip return, and respects the daily cap',async t=>{
 const DB=database();await fixture(DB);
 const env={DB,GOOGLE_MAPS_API_KEY:'test-only'};
 const make=(owner)=>onRequestPost({env,request:request('/api/route-mileage',{reference:'RD-TEST000001'},owner)});
 assert.equal((await make(false)).status,401);
 await DB.prepare(`UPDATE bookings SET additional_stops='["Test stop one","Test stop two"]',trip_type='Round trip'`).run();
 let calls=0;
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  calls++;assert.equal(url,'https://routes.googleapis.com/directions/v2:computeRoutes');
  const payload=JSON.parse(options.body);
  assert.equal(payload.destination.address,'Test pickup address');
  assert.deepEqual(payload.intermediates.map(x=>x.address),['Test stop one','Test stop two','Test destination address']);
  return Response.json({routes:[{distanceMeters:16093.44}]});
 });
 const result=await (await make(true)).json();assert.equal(result.miles,10);assert.equal(result.roundTrip,true);
 await DB.prepare('UPDATE mileage_usage SET request_count=20').run();
 assert.equal((await make(true)).status,429);assert.equal(calls,1);
});
