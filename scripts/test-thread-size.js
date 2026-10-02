const { test } = require('node:test');
const assert = require('node:assert/strict');
const { longThreadNotice, historyTokens, LONG_THREAD_TOKENS } = require('../lib/thread-size');

const say = (n) => ({ role: 'user', content: 'word '.repeat(n) });
const long = () => Array.from({ length: 40 }, () => say(2000));

test('only the conversation itself counts, not instructions, tools or recall', () => {
  assert.ok(historyTokens(long()) >= LONG_THREAD_TOKENS);
  assert.equal(historyTokens([]), 0);
  assert.equal(historyTokens(undefined), 0);
});

test('a short thread says nothing, however large the request around it', () => {
  const store = { facts: {} };
  const shortThread = [say(20), { role: 'assistant', content: 'ok' }, say(20), { role: 'assistant', content: 'done' }];
  assert.equal(longThreadNotice(store, 't1', shortThread), null);
  assert.equal(store.facts['_long-thread-notice'], undefined);
});

test('the optional thread notice is bracketed and appears once per thread', () => {
  const store = { facts: {} };
  const first = longThreadNotice(store, 't1', long());
  assert.match(first, /^\[Thread note: .*\]$/);
  assert.match(first, /You can keep chatting here/);
  assert.match(first, /condensed automatically/);
  assert.match(first, /\/new starts a separate thread/);
  assert.match(first, /Earlier conversations stay saved/);
  assert.doesNotMatch(first, /tokens of history|each reply/);
  assert.equal(longThreadNotice(store, 't1', long()), null, 'said once per thread');
  assert.match(longThreadNotice(store, 't2', long()), /Thread note:/, 'a new thread gets its own notice');
  assert.equal(longThreadNotice({ facts: { '_long-thread-notice': { value: 't3' } } }, 't3', long()), null, 'facts stored as objects count too');
});
