const { test } = require('node:test');
const assert = require('node:assert/strict');
const { longThreadNotice, carriedTokens } = require('../lib/thread-size');
test('cached and fresh input both count towards the notice threshold', () => {
  assert.equal(carriedTokens({ input_tokens: 1000, cache_read_input_tokens: 20000, cache_creation_input_tokens: 500 }), 21500);
  assert.equal(carriedTokens(undefined), 0);
});
test('a short thread says nothing', () => {
  const store = { facts: {} };
  assert.equal(longThreadNotice(store, 't1', { input_tokens: 5000 }), null);
  assert.equal(store.facts['_long-thread-notice'], undefined);
});
test('the optional thread notice is bracketed and appears once per thread', () => {
  const store = { facts: {} };
  const first = longThreadNotice(store, 't1', { input_tokens: 24700, output_tokens: 300 });
  assert.match(first, /^\[Thread note: .*\]$/);
  assert.match(first, /You can keep chatting here/);
  assert.match(first, /condensed automatically/);
  assert.match(first, /\/new starts a separate thread/);
  assert.match(first, /Earlier conversations stay saved/);
  assert.doesNotMatch(first, /tokens of history|each reply/);
  assert.equal(longThreadNotice(store, 't1', { input_tokens: 30000 }), null, 'said once per thread');
  assert.match(longThreadNotice(store, 't2', { input_tokens: 30000 }), /Thread note:/, 'a new thread gets its own notice');
  assert.equal(longThreadNotice({ facts: { '_long-thread-notice': { value: 't3' } } }, 't3', { input_tokens: 30000 }), null, 'facts stored as objects count too');
});
