import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database, fixture, request, squareEnv, testToken } from './helpers/database.mjs';
import { onRequestGet as listQuotes, onRequestPatch as updateArchive } from '../functions/api/owner-quotes.js';
import { onRequestGet as getBookings } from '../functions/api/bookings.js';
import { onRequestGet as getBalances } from '../functions/api/owner-balances.js';
import { onRequestGet as getCustomerQuote } from '../functions/api/quotes/customer.js';

test('owner quote archives move quotes between views while preserving the ride and payment records', async () => {
  const DB = database();
  await fixture(DB);
  const env = squareEnv(DB);
  const reference = 'QT-TEST000001';
  const ownerQuotes = (view, owner = true) =>
    listQuotes({ env, request: request('/api/owner-quotes?view=' + view, undefined, owner) });
  const setArchive = (archived, owner = true, origin = 'https://test.invalid') => {
    const original = request('/api/owner-quotes', { reference, archived }, owner);
    original.headers.set('Origin', origin);
    return updateArchive({ env, request: new Request(original, { method: 'PATCH' }) });
  };
  const bookings = async () =>
    (await getBookings({ env, request: request('/api/bookings', undefined, true) })).json();
  const balances = async () =>
    (await getBalances({ env, request: request('/api/owner-balances', undefined, true) })).json();
  const customer = async () =>
    (await getCustomerQuote({ env, request: request('/api/quotes/customer?token=' + testToken) })).json();

  assert.equal((await ownerQuotes('current', false)).status, 401);
  assert.equal((await setArchive(true, false)).status, 401);
  assert.equal((await setArchive(true, true, 'https://unrelated.invalid')).status, 403);
  assert.deepEqual(await (await ownerQuotes('archived')).json(), { quotes: [] });

  await DB.prepare(`
    INSERT INTO square_payments (quote_reference, booking_reference, payment_type, amount_cents,
      status, square_environment, square_payment_id, created_at, updated_at)
    VALUES (?, 'RD-TEST000001', 'deposit', 5001, 'paid', 'sandbox', 'deposit-paid', 'now', 'now')
  `).bind(reference).run();
  const originalQuote = (await customer()).quote;
  const normal = await (await ownerQuotes('current')).json();
  assert.equal(normal.quotes[0].reference, reference);
  assert.equal(normal.quotes[0].final_fare_cents, 10001);
  assert.equal('customer_token_hash' in normal.quotes[0], false);
  assert.equal((await balances()).balances[0].reference, reference);

  assert.equal((await setArchive(true)).status, 200);
  const archived = await (await ownerQuotes('archived')).json();
  assert.equal(archived.quotes[0].reference, reference);
  assert.equal(archived.quotes[0].status, 'accepted');
  assert.ok(archived.quotes[0].archived_at);
  assert.equal((await setArchive(true)).status, 200);
  assert.deepEqual(await (await ownerQuotes('archived')).json(), archived);
  assert.deepEqual(await (await ownerQuotes('current')).json(), { quotes: [] });
  assert.deepEqual(await balances(), { balances: [] });
  const activeBooking = (await bookings()).bookings[0];
  assert.equal(activeBooking.reference, 'RD-TEST000001');
  assert.equal(activeBooking.accepted_quote_reference, null);
  assert.deepEqual((await customer()).quote, originalQuote);
  assert.equal((await DB.prepare('SELECT status FROM square_payments').first()).status, 'paid');

  assert.equal((await setArchive(false)).status, 200);
  assert.equal((await setArchive(false)).status, 200);
  assert.deepEqual(await (await ownerQuotes('archived')).json(), { quotes: [] });
  assert.deepEqual(await (await ownerQuotes('current')).json(), normal);
  assert.equal((await balances()).balances[0].reference, reference);
  assert.equal((await bookings()).bookings[0].accepted_quote_reference, reference);
});
