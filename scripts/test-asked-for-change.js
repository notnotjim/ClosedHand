// A change nobody asked for never reaches a card, and a "no" still answers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
let reply = 'no', seen = null, fail = false;
stub('../lib/llm', { getInternalClient: () => ({ client: {}, model: 'fixture' }) });
stub('../lib/task-model', { modelCall: async (client, req) => { if (fail) throw Error('offline'); seen = req; return { content: [{ type: 'text', text: reply }] }; } });
const { askedForChange, lastAssistantBefore, describe } = require('../lib/asked-for-change');

test('the model is asked about the latest message, read with the assistant\'s previous one', async () => {
  reply = 'No.';
  const r = await askedForChange({ userId: 'u', userMessage: "What's on today?", lastAssistant: 'Your table is now 7pm.', toolName: 'gcal_update_event', input: { summary: 'Dinner', _userId: 'u' } });
  assert.equal(r, false);
  const msg = seen.messages[0].content;
  assert.match(msg, /Person's latest message: What's on today\?/);
  assert.match(msg, /Assistant's previous message: Your table is now 7pm\./);
  assert.match(msg, /gcal_update_event \{"summary":"Dinner"\}/);
  assert.doesNotMatch(msg, /_userId/);
  reply = 'yes';
  assert.equal(await askedForChange({ userId: 'u', userMessage: 'yes do it', toolName: 'gcal_update_event', input: {} }), true);
  reply = 'maybe';
  assert.equal(await askedForChange({ userId: 'u', userMessage: 'hm', toolName: 'x', input: {} }), null, 'unclear goes to the card');
  fail = true;
  assert.equal(await askedForChange({ userId: 'u', userMessage: 'hm', toolName: 'x', input: {} }), null, 'a failed check goes to the card');
  fail = false;
});

test('the previous assistant message is found past the latest user message', () => {
  const conv = [{ role: 'assistant', content: 'Want me to move it to 7?' }, { role: 'user', content: 'yes' }];
  assert.equal(lastAssistantBefore(conv, 'yes'), 'Want me to move it to 7?');
  assert.equal(lastAssistantBefore([{ role: 'assistant', content: [{ type: 'text', text: 'Hi' }] }], 'new'), 'Hi');
  assert.equal(lastAssistantBefore([], 'x'), '');
  assert.ok(describe('t', { a: 'x'.repeat(2000) }).length <= 600);
});

test('the chat checks before any change card, and a no carries the turn on', () => {
  const engine = fs.readFileSync(path.join(__dirname, '..', 'lib', 'engine.js'), 'utf8');
  const at = engine.indexOf('if (needsConfirmation && !spendPlan && !outboundPlan)');
  assert.ok(at > 0, 'check present');
  assert.ok(at < engine.indexOf('ctx.pendingConfirmations[userId] = {', at), 'check comes before the card is built');
  assert.match(engine.slice(at, at + 1200), /asked === false[\s\S]*continue;/);
  const conf = fs.readFileSync(path.join(__dirname, '..', 'lib', 'confirmation.js'), 'utf8');
  assert.match(conf, /result = \{ declined: true, note: "The person said no, so this was not done\./);
  assert.doesNotMatch(conf, /return "Cancelled\.";/);
});
