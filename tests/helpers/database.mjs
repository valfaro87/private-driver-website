import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { sha256Hex } from '../../functions/_lib/auth.js';
export function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of ['0001_create_bookings.sql','migrations/0002_pricing_and_quotes.sql','0003_additional_stops.sql',
    '0004_mileage_usage.sql','0005_verified_reviews.sql','0006_square_payments.sql','0007_checkout_retries.sql',
    '0008_balance_invoices.sql']) {
    sqlite.exec(readFileSync(new URL('../../migrations/'+file,import.meta.url),'utf8'));
  }
  const wrap = (sql, values=[]) => ({
    bind(...args) { return wrap(sql,args); },
    async first() { return sqlite.prepare(sql).get(...values) || null; },
    async all() { return {results:sqlite.prepare(sql).all(...values)}; },
    async run() { const r=sqlite.prepare(sql).run(...values); return {meta:{changes:r.changes,last_row_id:r.lastInsertRowid}}; }
  });
  return { sqlite, prepare:sql=>wrap(sql), async batch(statements) {
    sqlite.exec('BEGIN');
    try {const r=[];for (const s of statements) r.push(await s.run());sqlite.exec('COMMIT');return r;}
    catch(e){sqlite.exec('ROLLBACK');throw e;}
  }};
}
export const testToken = 'a'.repeat(64);
export const testSession = 'b'.repeat(64);
export async function fixture(DB, status='accepted') {
  await DB.prepare(`INSERT INTO bookings (reference,name,phone,email,pickup,destination,pickup_date,pickup_time,
    passengers,trip_type,status,created_at) VALUES ('RD-TEST000001','Test Customer','5550100000','test@example.invalid',
    'Test pickup address','Test destination address','2099-01-01','12:00','1','One-way','new',?)`).bind(new Date().toISOString()).run();
  await DB.prepare(`INSERT INTO ride_quotes (reference,booking_reference,status,final_fare_cents,customer_token_hash,
    created_at,updated_at,expires_at,owner_notes) VALUES ('QT-TEST000001','RD-TEST000001',?,10001,?,?,?,?,'PRIVATE NOTE')`)
    .bind(status,await sha256Hex(testToken),new Date().toISOString(),new Date().toISOString(),new Date(Date.now()+86400000).toISOString()).run();
  await DB.prepare(`INSERT INTO owner_sessions VALUES (?,?,?)`)
    .bind(await sha256Hex(testSession),new Date(Date.now()+86400000).toISOString(),new Date().toISOString()).run();
}
export function request(path, body, owner=false) {
  const method=body===undefined?'GET':'POST';
  return new Request('https://test.invalid'+path,{method, headers:{'Content-Type':'application/json',Origin:'https://test.invalid',
    ...(owner?{Cookie:'__Host-driver_owner='+testSession}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
}
export function squareEnv(DB) {
 return {DB,SQUARE_ENVIRONMENT:'sandbox',SQUARE_ACCESS_TOKEN:'test-only',SQUARE_LOCATION_ID:'test-location',
   SQUARE_WEBHOOK_SIGNATURE_KEY:'test-key',SQUARE_WEBHOOK_URL:'https://test.invalid/api/square-webhook'};
}
