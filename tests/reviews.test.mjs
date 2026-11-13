import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database,fixture,request } from './helpers/database.mjs';
import { onRequestPost as invite } from '../functions/api/review-invitations.js';
import { onRequestPost as submit } from '../functions/api/review-submit.js';
import { onRequestPost as moderate,onRequestGet as ownerReviews } from '../functions/api/owner-reviews.js';
import { onRequestGet as publicReviews } from '../functions/api/reviews.js';
test('completed rides may submit once; consent plus owner approval controls public display',async()=>{
 const DB=database();await fixture(DB);const env={DB};
 assert.equal((await invite({env,request:request('/api/review-invitations',{booking_reference:'RD-TEST000001'},true)})).status,400);
 await DB.prepare(`UPDATE bookings SET status='completed'`).run();
 const i=await (await invite({env,request:request('/api/review-invitations',{booking_reference:'RD-TEST000001'},true)})).json();
 const token=new URL(i.review_url).searchParams.get('token');
 const body={token,customer_name:'Test C.',rating:5,feedback:'Test feedback',permission_to_publish:false};
 assert.equal((await submit({env,request:request('/api/review-submit',body)})).status,201);
 assert.notEqual((await submit({env,request:request('/api/review-submit',body)})).status,201);
 const readReviews = async () => (await publicReviews({env,request:request('/api/reviews')})).json();
 assert.equal((await readReviews()).total,0);
 assert.equal((await ownerReviews({env,request:request('/api/owner-reviews')})).status,401);
 const moderation={review_id:1,action:'publish'};
 assert.equal((await moderate({env,request:request('/api/owner-reviews',moderation,true)})).status,403);
 await DB.prepare('UPDATE customer_reviews SET permission_to_publish=1').run();
 assert.equal((await moderate({env,request:request('/api/owner-reviews',moderation,true)})).status,200);
 const review=(await readReviews()).reviews[0];
 assert.deepEqual(Object.keys(review).sort(),['id','customer_name','rating','feedback','owner_response','created_at','published_at','owner_response_at'].sort());
 assert.equal(JSON.stringify(review).includes('RD-TEST'),false);
 assert.match(review.published_at,/^\d{4}-\d{2}-\d{2} /);
 assert.equal(review.owner_response_at,null);
 await DB.prepare("UPDATE customer_reviews SET published_at='2026-10-15 12:00:00'").run();
 assert.equal((await moderate({env,request:request('/api/owner-reviews',{review_id:1,action:'reply',owner_response:'Thank you'},true)})).status,200);
 const withReply=(await readReviews()).reviews[0];
 assert.equal(withReply.published_at,'2026-10-15 12:00:00');
 assert.equal(withReply.owner_response,'Thank you');
 assert.match(withReply.owner_response_at,/^\d{4}-\d{2}-\d{2} /);
 assert.equal((await moderate({env,request:request('/api/owner-reviews',{review_id:1,action:'hide'},true)})).status,200);
 assert.equal((await readReviews()).total,0);
 assert.equal((await moderate({env,request:request('/api/owner-reviews',moderation,true)})).status,200);
 assert.equal((await readReviews()).reviews[0].published_at,'2026-10-15 12:00:00');
 assert.equal((await moderate({env,request:request('/api/owner-reviews',{review_id:1,action:'reply',owner_response:''},true)})).status,200);
 assert.equal((await readReviews()).reviews[0].owner_response_at,null);
 const cross=new Request('https://test.invalid/api/owner-reviews',{method:'POST',headers:{Origin:'https://other.invalid'}});
 assert.equal((await moderate({env,request:cross})).status,403);
});

test('review sort and rating totals span all consented, published reviews', async () => {
  const DB = database();
  const env = { DB };
  const addBooking = DB.sqlite.prepare(`
    INSERT INTO bookings (reference,name,phone,email,pickup,destination,pickup_date,pickup_time,
      passengers,trip_type,status,created_at)
    VALUES (?,'Sample','5550100000','sample@example.invalid','Pickup','Destination','2026-10-01',
      '12:00','1','One-way','completed','2026-10-01')
  `);
  const addReview = DB.sqlite.prepare(`
    INSERT INTO customer_reviews (booking_reference,customer_name,rating,feedback,permission_to_publish,
      moderation_status,created_at,published_at)
    VALUES (?,'Sample',?,'Test review',?,?,?,?)
  `);
  function add(id, rating, created, published, status = 'published', permission = 1) {
    const reference = 'RD-SAMPLE' + id;
    addBooking.run(reference);
    addReview.run(reference, rating, permission, status, created, published);
  }
  add(1, 5, '2026-10-01 14:00:00', null);
  add(2, 1, '2026-10-02 14:00:00', '2026-10-18 14:00:00');
  add(3, 3, '2026-10-03 14:00:00', '2026-10-17 14:00:00');
  for (let id = 4; id <= 101; id++) {
    add(id, 4, '2026-10-04 14:00:00', '2026-10-05 14:00:00');
  }
  add(102, 5, '2026-10-19 14:00:00', null, 'pending');
  add(103, 5, '2026-10-19 14:00:00', null, 'hidden');
  add(104, 5, '2026-10-19 14:00:00', null, 'published', 0);

  const get = query => publicReviews({ env, request: request('/api/reviews' + query) });
  const read = async query => (await get(query)).json();
  const current = await read('');
  assert.equal(current.reviews.length, 100);
  assert.equal(current.total, 101);
  assert.deepEqual(current.ratingCounts, { 1: 1, 2: 0, 3: 1, 4: 98, 5: 1 });
  assert.deepEqual(current.reviews.slice(0, 3).map(r => r.id), [2, 3, 101]);
  assert.deepEqual((await read('?page=2')).reviews.map(r => r.id), [1]);
  assert.deepEqual((await read('?sort=oldest')).reviews.slice(0, 2).map(r => r.id), [1, 4]);
  assert.deepEqual((await read('?sort=highest')).reviews.slice(0, 2).map(r => r.id), [1, 101]);
  assert.deepEqual((await read('?sort=lowest')).reviews.slice(0, 2).map(r => r.id), [2, 3]);
  assert.deepEqual((await read('?sort=invalid')).reviews, current.reviews);
  assert.equal((await get('?page=-1')).status, 400);
  assert.equal((await get('?page=1.25')).status, 400);
});
