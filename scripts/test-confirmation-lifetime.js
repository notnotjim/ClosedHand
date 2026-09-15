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
test('moving on marks the task dropped and forgets the held action', async () => {
  const c = loadConfirmation({ u1: { isAgent: true, taskId: 't1', pausedAt: Date.now() - 60000 } });
  assert.equal(await c.handleConfirmation('u1', 'chat', 'what is the weather'), false);
  assert.equal(c.dropped.length, 0, 'a non-answer alone decides nothing');
  await c.dropPending('u1', 'moved_on');
  assert.equal(c.ctx.pendingConfirmations.u1, undefined);
  assert.deepEqual(c.dropped, [['t1', 'moved_on']]);
  assert.equal(c.conversation.at(-1).content, 'OK, cancelled.');
  await c.dropPending('u1', 'moved_on');
  assert.equal(c.dropped.length, 1, 'dropping twice is harmless');
});
test('a chat-only held action drops without touching any task', async () => {
  const c = loadConfirmation({ u1: { toolName: 'gmail_send', askedAt: Date.now() - 2 * DAY } });
  assert.equal(await c.handleConfirmation('u1', 'chat', 'hello'), false);
  assert.equal(c.ctx.pendingConfirmations.u1, undefined);
  assert.equal(c.dropped.length, 0);
});
