const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function guard() {
  const context = { module: { exports: {} }, URL, console, require: () => ({}) };
  vm.runInNewContext(fs.readFileSync(require.resolve('../lib/spend-guard'), 'utf8'), context);
  return context.module.exports;
}
test('payment lookup submissions are not purchases, but explicit pay actions still are', () => {
  const g = guard();
  for (const url of ['https://example.com/payment-lookup/', 'https://example.com/payments/search']) {
    g.notePage('u', url, 'Payment Lookup Page');
    assert.equal(g.spendIntent('sandbox_browse', { _userId: 'u', action: 'batch', steps: [{ action: 'fill', selector: '#reference', text: 'example' }, { action: 'click', selector: 'button[type=submit]' }] }), null);
    assert.equal(g.spendIntent('sandbox_browse', { _userId: 'u', action: 'press', key: 'Enter' }), null);
    assert.ok(g.spendIntent('sandbox_browse', { _userId: 'u', action: 'click', selector: 'text=Pay now' }));
  }
});
test('checkout still gates generic submits, including saved-card and misleading-title pages', () => {
  const g = guard();
  for (const url of ['https://example.com/checkout', 'https://example.com/payment', 'https://example.com/checkout/payment-lookup']) {
    g.notePage('u', url, 'Payment Lookup');
    assert.ok(g.spendIntent('sandbox_browse', { _userId: 'u', action: 'click', selector: 'button[type=submit]' }));
  }
});
test('batch navigation replaces stale checkout context without exempting later payment steps', () => {
  const g = guard();
  g.notePage('u', 'https://example.com/checkout', 'Checkout');
  const steps = [{ action: 'navigate', url: 'https://example.com/payment-lookup' }, { action: 'click', selector: 'button[type=submit]' }];
  assert.equal(g.spendIntent('sandbox_browse', { _userId: 'u', action: 'batch', steps }), null);
  assert.ok(g.spendIntent('sandbox_browse', { _userId: 'u', action: 'batch', steps: [...steps, { action: 'navigate', url: 'https://example.com/checkout' }, { action: 'click', selector: 'button[type=submit]' }] }));
});
test('a payment word in a host or return URL does not turn a lookup into checkout', () => {
  const g = guard();
  g.notePage('u', 'https://payments.example.com/search?return=/checkout', 'Search transactions');
  assert.equal(g.spendIntent('sandbox_browse', { _userId: 'u', action: 'click', selector: 'button[type=submit]' }), null);
});
