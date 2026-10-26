import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteState } from '../assets/quote-state.js';

test('only an issued, unexpired quote permits a customer response', () => {
  const now = Date.now();
  for (const status of ['accepted', 'declined', 'expired', 'cancelled', 'superseded', 'draft', '', 'unknown']) {
    const state = quoteState({ status, expiresAt: new Date(now + 60000).toISOString() }, now);
    assert.equal(state.canRespond, false, status);
    assert.equal(state.canPay, status === 'accepted', status);
  }
  assert.equal(quoteState({status:'issued', expiresAt:new Date(now + 1).toISOString()}, now).canRespond, true);
  for (const expiresAt of [null, '', 'invalid', new Date(now).toISOString(), new Date(now - 1).toISOString()]) {
    assert.equal(quoteState({status:'issued', expiresAt}, now).canRespond, false);
  }
});
