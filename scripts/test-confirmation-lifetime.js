const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const lifetime = require('../lib/confirmation-lifetime');
const DAY = 24 * 3600 * 1000;
test('a question lapses a day after it was asked, whichever timestamp it carries', () => {
  const now = Date.now();
  assert.equal(lifetime.isLapsed({ asked: { at: now - DAY - 1 } }, now), true);
  assert.equal(lifetime.isLapsed({ pausedAt: now - DAY + 60000 }, now), false);
  assert.equal(lifetime.isLapsed({ askedAt: now - 2 * DAY }, now), true);
  assert.equal(lifetime.isLapsed({}, now), false);
  assert.match(lifetime.droppedNote('lapsed'), /within a day/);
  assert.match(lifetime.droppedNote('unknown'), /moved on/);
});
function loadConfirmation(pendings) {
  const conversation = [], dropped = [], ctx = { pendingConfirmations: pendings };
  const stub = new Proxy({}, { get: () => () => {} });
  const deps = {
    './context': ctx, './llm': stub, './storage': { saveStore() {} }, './conversation': { getConversation: () => conversation },
    './tools/handlers': stub, './mcp': stub, './user-mcp': stub, './spend-guard': { ledgerUpdate: async () => {} },
    './messaging': { sendTyping() {} }, './services-config': { CONNECTABLE_SERVICES: [] },
    './confirmation-lifetime': lifetime, './agents': { dropConfirmation: async (p, reason) => { dropped.push([p.taskId, reason]); } },
  };
  const context = { module: { exports: {} }, console, Date, require: name => { if (!(name in deps)) throw Error(name); return deps[name]; } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'lib/confirmation.js'), 'utf8'), context);
  return { ...context.module.exports, ctx, conversation, dropped };
}
test('a yes to a lapsed question does nothing and the task is marked dropped', async () => {
  const c = loadConfirmation({ u1: { isAgent: true, taskId: 't1', pausedAt: Date.now() - 2 * DAY } });
  const reply = await c.handleConfirmation('u1', 'chat', 'yes');
  assert.match(reply, /lapsed/);
  assert.equal(c.ctx.pendingConfirmations.u1, undefined);
  assert.deepEqual(c.dropped, [['t1', 'lapsed']]);
});
// A message that is not a yes or no drops the held action, so a later "yes"
// to something else cannot fire it. Nothing is written as said: an "OK,
// cancelled." once stood in the conversation that the person never saw.
// The reply to their message is told instead, and asks afresh if needed.
test('moving on marks the task dropped and tells the reply, not the record', async () => {
  const c = loadConfirmation({ u1: { isAgent: true, taskId: 't1', pausedAt: Date.now() - 60000 } });
  assert.equal(await c.handleConfirmation('u1', 'chat', 'is it from my other address?'), false);
  assert.equal(c.dropped.length, 0, 'a non-answer alone decides nothing');
  const note = await c.dropPending('u1', 'moved_on');
  assert.equal(c.ctx.pendingConfirmations.u1, undefined);
  assert.deepEqual(c.dropped, [['t1', 'moved_on']]);
  assert.equal(c.conversation.length, 0, 'nothing written as if said');
  assert.match(note, /not done, and they have not been told[\s\S]*call the tool again so they get a fresh question/);
  assert.equal(await c.dropPending('u1', 'moved_on'), null, 'dropping twice is harmless');
  assert.equal(c.dropped.length, 1);
});
test('a lapsed question: a new message drops it the same way, a late yes is told it lapsed', async () => {
  const c = loadConfirmation({ u1: { toolName: 'gmail_send', askedAt: Date.now() - 2 * DAY } });
  assert.equal(await c.handleConfirmation('u1', 'chat', 'hello'), false);
  assert.match(await c.dropPending('u1', 'moved_on'), /HELD ACTION NOT DONE/);
  assert.equal(c.ctx.pendingConfirmations.u1, undefined);
  assert.equal(c.dropped.length, 0);
  const late = loadConfirmation({ u1: { toolName: 'gmail_send', askedAt: Date.now() - 2 * DAY } });
  assert.match(await late.handleConfirmation('u1', 'chat', 'yes'), /lapsed, so nothing was done/);
  assert.deepEqual(late.conversation.map((m) => m.content), ['yes', 'That question is from more than a day ago and has lapsed, so nothing was done. Ask again if you still want it.'], 'what was said, as said');
});
