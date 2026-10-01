const { test } = require('node:test');
const assert = require('node:assert/strict');
const { wantsMail } = require('../lib/search-route');
test('a source that is not mail is never answered from mail', () => {
  assert.equal(wantsMail({ source: 'whatsapp' }), false);
  assert.equal(wantsMail({ source: 'slack' }), false);
  assert.equal(wantsMail({ source: 'gmail_hi' }), true);
  assert.equal(wantsMail({ source: 'outlook' }), true);
  assert.equal(wantsMail({}), true);
  assert.equal(wantsMail({ type: 'email', source: 'whatsapp' }), true, 'an explicit type wins');
  assert.equal(wantsMail({ type: 'message' }), false);
});
