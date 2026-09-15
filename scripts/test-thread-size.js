const { test } = require('node:test');
const assert = require('node:assert/strict');
const { longThreadNotice, carriedTokens } = require('../lib/thread-size');
test('cached and fresh input both count as carried history', () => {
  assert.equal(carriedTokens({ input_tokens: 1000, cache_read_input_tokens: 20000, cache_creation_input_tokens: 500 }), 21500);
  assert.equal(carriedTokens(undefined), 0);
});
test('a short thread says nothing', () => {
  const store = { facts: {} };
  assert.equal(longThreadNotice(store, 't1', { input_tokens: 5000 }), null);
  assert.equal(store.facts['_long-thread-notice'], undefined);
});
test('a long thread is mentioned once, with its size and the way out', () => {
  const store = { facts: {} };
  const first = longThreadNotice(store, 't1', { input_tokens: 24700, output_tokens: 300 });
  assert.match(first, /about 25k tokens of history/);
  assert.match(first, /Send \/new/);
  assert.equal(longThreadNotice(store, 't1', { input_tokens: 30000 }), null, 'said once per thread');
  assert.match(longThreadNotice(store, 't2', { input_tokens: 30000 }), /30k/, 'a new thread gets its own notice');
  assert.equal(longThreadNotice({ facts: { '_long-thread-notice': { value: 't3' } } }, 't3', { input_tokens: 30000 }), null, 'facts stored as objects count too');
});
