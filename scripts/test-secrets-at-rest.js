// Provider keys and saved secrets (a Telegram bot token, a Google client
// secret) are stored encrypted with TOKEN_ENCRYPTION_KEY and read back plain
// only where used. Values saved before this read as they were, and are
// sealed once when the dashboard starts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
const root = path.join(__dirname, '..');

test('a provider key is saved sealed and opened only when a role is used', () => {
  const policy = require('../webapp/model-policy');
  const config = { version: 1, connections: { primary: { provider: 'deepseek', backend: 'openai', baseUrl: 'https://api.example.test/v1', apiKey: 'sk-test-0123456789abcdef' } },
    roles: { chat: { connection: 'primary', model: 'chat-model', capabilities: {} }, vision: null } };
  const sealed = policy.sealConfig(config);
  assert.match(sealed.connections.primary.apiKey, /^enc:v1:/);
  assert.equal(config.connections.primary.apiKey, 'sk-test-0123456789abcdef', 'the config passed in is not changed');
  assert.equal(policy.getRole({ model_config: sealed }, 'chat').apiKey, 'sk-test-0123456789abcdef');
  assert.equal(policy.getRole({ model_config: config }, 'chat').apiKey, 'sk-test-0123456789abcdef', 'a key saved before sealing still works');
  assert.deepEqual(policy.sealConfig(sealed), sealed, 'sealing twice changes nothing');
  assert.equal(policy.publicConfig(sealed).connections.primary.hasKey, true);
  assert.doesNotMatch(JSON.stringify(policy.publicConfig(sealed)), /enc:v1:|sk-test/);
});

test('saving models writes every copy of the key sealed', () => {
  const { withConfig } = require('../webapp/model-config');
  const config = { version: 1, connections: { primary: { provider: 'openai', backend: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test-abcdef0123456789' } },
    roles: { chat: { connection: 'primary', model: 'gpt-test', capabilities: {} }, vision: null } };
  const next = withConfig({}, config);
  assert.match(next.model_config.connections.primary.apiKey, /^enc:v1:/);
  assert.match(next.openai_api_key, /^enc:v1:/);
  assert.doesNotMatch(JSON.stringify(next), /sk-test/);
});

test('keys saved before sealing are sealed once at start, and only those', async () => {
  const { sealStoredKeys } = require('../webapp/model-config');
  const settings = { model_config: { version: 1, connections: { primary: { backend: 'custom', apiKey: 'plain-key-0123456789' } }, roles: { chat: { connection: 'primary', model: 'm' } } },
    custom_api_key: 'plain-key-0123456789', llm_provider: 'custom' };
  const writes = [];
  const supabase = { from: () => { const q = { select: () => q, eq: () => q, single: async () => ({ data: { settings } }) }; return q; } };
  const patchPath = require.resolve('../webapp/settings-patch');
  const saved = require.cache[patchPath];
  require.cache[patchPath] = { id: patchPath, filename: patchPath, loaded: true, exports: { patchSettings: async (db, id, patch) => { writes.push(patch); Object.assign(settings, patch.set); return settings; } } };
  try {
    assert.equal(await sealStoredKeys(supabase, 'u1'), 2);
    assert.match(settings.custom_api_key, /^enc:v1:/);
    assert.match(settings.model_config.connections.primary.apiKey, /^enc:v1:/);
    assert.equal(await sealStoredKeys(supabase, 'u1'), 0, 'nothing left to seal');
    assert.equal(writes.length, 1);
  } finally {
    if (saved) require.cache[patchPath] = saved; else delete require.cache[patchPath];
  }
});

function loadConfig(store) {
  const deps = {
    './crypto-tokens': require('../webapp/crypto-tokens'),
    './db': { isDbConfigured: () => true, supabase: { from: () => { const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { settings: { self_host_config: store } }, error: null }) }; return q; } } },
    './admin': { getAdminUserId: () => 'u1' },
    './settings-patch': { patchSettings: async (db, id, { confSet = {}, confUnset = [] }) => { Object.assign(store, confSet); for (const k of confUnset) delete store[k]; return { self_host_config: store }; } },
  };
  const box = { module: { exports: {} }, require: (n) => deps[n], process, console, setInterval, URL };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'webapp/config.js'), 'utf8'), box);
  return box.module.exports;
}

test('saved secrets are stored sealed and read back plain; other settings are untouched', async () => {
  const store = {};
  const conf = loadConfig(store);
  await conf.setConf({ TELEGRAM_BOT_TOKEN: '123456:test-bot-token', GOOGLE_CLIENT_SECRET: 'test-client-secret', TELEGRAM_BOT_USERNAME: 'test_bot', SETUP_FINISHED: '1' });
  assert.match(store.TELEGRAM_BOT_TOKEN, /^enc:v1:/);
  assert.match(store.GOOGLE_CLIENT_SECRET, /^enc:v1:/);
  assert.equal(store.TELEGRAM_BOT_USERNAME, 'test_bot');
  assert.equal(store.SETUP_FINISHED, '1');
  conf.invalidateConf();
  assert.equal(await conf.getConf('TELEGRAM_BOT_TOKEN'), '123456:test-bot-token');
  assert.equal(await conf.getConfStrict('GOOGLE_CLIENT_SECRET'), 'test-client-secret');
  assert.equal(conf.getConfCached('TELEGRAM_BOT_TOKEN'), '123456:test-bot-token');
});

test('a secret saved before sealing still reads, and is sealed once at start', async () => {
  const store = { TELEGRAM_BOT_TOKEN: '123456:old-plain-token', DASHBOARD_PASSWORD_HASH: 'salt:hash', PHONE_ADDRESS_NAME: 'test' };
  const conf = loadConfig(store);
  assert.equal(await conf.getConf('TELEGRAM_BOT_TOKEN'), '123456:old-plain-token');
  assert.equal(await conf.sealStoredConf(), 1);
  assert.match(store.TELEGRAM_BOT_TOKEN, /^enc:v1:/);
  assert.equal(store.DASHBOARD_PASSWORD_HASH, 'salt:hash', 'a hash is not a secret to seal');
  conf.invalidateConf();
  assert.equal(await conf.getConf('TELEGRAM_BOT_TOKEN'), '123456:old-plain-token');
  assert.equal(await conf.sealStoredConf(), 0);
});

test('every place that uses a stored key opens it first', () => {
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  assert.match(read('lib/llm.js'), /for \(const f of \["anthropic_api_key", "openai_api_key", "gemini_api_key", "custom_api_key"\]\) userSettings\[f\] = openKey\(userSettings\[f\]\);/);
  assert.match(read('webapp/server.js'), /for \(const f of \["anthropic_api_key", "openai_api_key", "gemini_api_key", "custom_api_key"\]\) s\[f\] = openKey\(s\[f\]\);/);
  assert.match(read('lib/outbound-guard.js'), /secrets\.add\(String\(openKey\(c\.apiKey\)\)\)/);
  assert.match(read('webapp/model-config.js'), /conn\.apiKey = policy\.openKey\(previous\.apiKey\);/);
  assert.equal(read('lib/crypto-tokens.js').trim().split('\n').pop(), 'module.exports = require("../crypto-tokens");');
  assert.match(read('webapp/server.js'), /await require\("\.\/config"\)\.sealStoredConf\(\)\) \+ \(await require\("\.\/model-config"\)\.sealStoredKeys\(supabase, getAdminUserId\(\)\)\)/);
});
