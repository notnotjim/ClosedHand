const { test } = require('node:test');
const assert = require('node:assert/strict');
const access = require('../webapp/browser-access');
const request = headers => ({ method: 'POST', headers: { host: 'james.closedhand.ai', ...headers } });
test('a sibling dashboard cannot perform a browser write, even though it is same-site', () => {
  assert.equal(access.allowBrowserWrite(request({ origin: 'https://other.closedhand.ai', 'sec-fetch-site': 'same-site' })), false);
  assert.equal(access.allowBrowserWrite(request({ 'sec-fetch-site': 'same-site' })), false);
  assert.equal(access.allowBrowserWrite(request({ origin: 'null' })), false);
  assert.equal(access.allowBrowserWrite(request({ origin: 'https://james.closedhand.ai.evil.example' })), false);
  assert.equal(access.allowBrowserWrite(request({ origin: 'https://james.closedhand.ai' })), true);
});
test('public sessions use host-only HTTPS cookies; local HTTP setup still works', () => {
  assert.equal(access.sessionName(request({})), '__Host-ch_admin');
  assert.match(access.sessionAttributes(request({})), /; Secure$/);
  assert.doesNotMatch(access.sessionAttributes(request({})), /Domain=/i);
  const local = { method: 'POST', headers: { host: 'localhost:3000', origin: 'http://localhost:3000' } };
  assert.equal(access.sessionName(local), 'ch_admin');
  assert.equal(access.allowBrowserWrite(local), true);
});
test('read-only navigation, provider webhooks and non-browser clients retain access checks downstream', () => {
  assert.equal(access.allowBrowserWrite({ ...request({ origin: 'https://elsewhere.example' }), method: 'GET' }), true);
  assert.equal(access.allowBrowserWrite(request({})), true);
  assert.equal(access.allowBrowserWrite(request({ 'sec-fetch-site': 'cross-site' })), false);
});
