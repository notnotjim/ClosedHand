// When a person's settings could not be read, no model is chosen for them.
// Unreadable settings used to look like empty ones, so the lookup fell through
// to the .env provider: messages could go to a provider the person never
// picked. Now every lookup stops and the chat says why.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ctx = require('../lib/context');
const llm = require('../lib/llm');

const fallback = { messages: { create: async () => ({ content: [] }) } };
const chosen = {
  model_config: {
    connections: { c1: { provider: 'openai', backend: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' } },
    roles: { chat: { connection: 'c1', model: 'gpt-test' }, background: { connection: 'c1', model: 'gpt-test-mini' } },
  },
};
const store = (over) => ({ userId: 'u1', profile: { id: 'u1', settings: {} }, settingsUnread: false, ...over });

test('unreadable settings stop every model lookup with words the person can read', () => {
  ctx.defaultLLMClient = fallback;
  const unread = store({ profile: null, settingsUnread: true });
  for (const [name, run] of [
    ['chat', () => llm.getUserLLMClient('u1', unread)],
    ['chat model name', () => llm.resolveUserModel('u1', 'default', unread)],
    ['background', () => llm.getInternalClient('u1', unread)],
    ['a configured role', () => llm.getConfiguredRole('chat', unread)],
    ['vision check', () => llm.chatModelSupportsVision(unread)],
  ]) {
    assert.throws(run, (e) => e.userFacing === true && /couldn't read my settings/.test(e.message), name);
  }
});

test('readable settings choose exactly as before', () => {
  ctx.defaultLLMClient = fallback;
  assert.equal(llm.getUserLLMClient('u1', store({ profile: { id: 'u1', settings: chosen } })).model, 'gpt-test');
  const legacy = llm.getUserLLMClient('u1', store());
  assert.equal(legacy.client, fallback, 'a profile with no model choice still uses the .env provider');
  assert.equal(llm.getConfiguredRole('chat', undefined), undefined, 'no store at all is not an unreadable one');
});

test('the chat shows a user-facing error as written, never "something went wrong"', () => {
  const src = fs.readFileSync(path.join(__dirname, '../lib/engine.js'), 'utf8');
  assert.match(src, /catch \(error\) \{ if \(error\.userFacing\) return error\.message; throw error; \}/);
  assert.match(src, /console\.error\("LLM API error:"[^\n]*\n\s*if \(error\.userFacing\) return error\.message;/);
});

test('a failed profile read marks the settings unread; a missing row does not', () => {
  const src = fs.readFileSync(path.join(__dirname, '../user-store.js'), 'utf8');
  assert.match(src, /store\.settingsUnread = !!\(profileRes\.error && profileRes\.error\.code !== "PGRST116"\);/);
});
