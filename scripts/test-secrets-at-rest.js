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

// The MCP client in a box: the SDK it would load is not needed to seal and
// open a row, so any name from it is a stand-in.
function loadMcpClient() {
  const sdk = new Proxy({}, { get: () => function stub() {} });
  const deps = { './crypto-tokens': require('../webapp/crypto-tokens'), os: require('node:os'), fs, path, crypto };
  const box = { module: { exports: {} }, require: (n) => deps[n] || (n.startsWith('@modelcontextprotocol/sdk/') ? sdk : undefined), process, console, URL, Buffer, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'webapp/mcp-client.js'), 'utf8'), box);
  return box.module.exports;
}
const plain = (o) => JSON.parse(JSON.stringify(o));

test('an MCP connection keeps its key, OAuth secrets, headers and environment sealed, and opens them for use', () => {
  const mcp = loadMcpClient();
  const row = { id: 'm1', name: 'Test server', server_url: 'https://mcp.example.test/mcp', command: null, args: ['--port', '9000'], auth_type: 'bearer',
    auth_token: 'test-access-token-1', oauth_client_id: 'test-client-id', oauth_client_secret: 'test-client-secret', oauth_refresh_token: 'test-refresh-token',
    headers: { 'X-Api-Key': 'test-header-key' }, env: { TEST_API_KEY: 'test-env-key', PORT: 9000, EMPTY: '' } };
  const sealed = plain(mcp.sealRow(row));
  for (const v of [sealed.auth_token, sealed.oauth_client_secret, sealed.oauth_refresh_token, sealed.headers['X-Api-Key'], sealed.env.TEST_API_KEY, sealed.env.PORT]) assert.match(v, /^enc:v1:/);
  assert.doesNotMatch(JSON.stringify(sealed), /test-access|test-client-secret|test-refresh|test-header-key|test-env-key/);
  for (const k of ['id', 'name', 'server_url', 'auth_type', 'oauth_client_id']) assert.equal(sealed[k], row[k], k);
  assert.deepEqual(sealed.args, row.args);
  assert.equal(sealed.env.EMPTY, '');
  assert.equal(row.auth_token, 'test-access-token-1', 'the row passed in is not changed');
  assert.deepEqual(plain(mcp.sealRow(sealed)), sealed, 'sealing twice changes nothing');
  const opened = plain(mcp.openRow(sealed));
  assert.equal(opened.auth_token, 'test-access-token-1');
  assert.equal(opened.oauth_client_secret, 'test-client-secret');
  assert.equal(opened.oauth_refresh_token, 'test-refresh-token');
  assert.deepEqual(opened.headers, { 'X-Api-Key': 'test-header-key' });
  assert.deepEqual(opened.env, { TEST_API_KEY: 'test-env-key', PORT: '9000', EMPTY: '' });
  assert.equal(plain(mcp.requestHeaders(opened)).Authorization, 'Bearer test-access-token-1');
  assert.deepEqual(plain(mcp.openRow(row)), plain(row), 'a row saved before sealing reads as it was');
  assert.equal(mcp.sealRow(null), null);
});

test('MCP credentials saved before sealing are sealed once at start, and only those', async () => {
  const mcp = loadMcpClient();
  const rows = [
    { id: 'old', auth_token: 'test-plain-token', oauth_client_secret: null, oauth_refresh_token: null, env: { TEST_KEY: 'test-plain-env' }, headers: null },
    { id: 'none', auth_token: null, oauth_client_secret: null, oauth_refresh_token: null, env: null, headers: null },
  ];
  const writes = [];
  const supabase = { from: () => ({
    select: async () => ({ data: rows.map((r) => ({ ...r })), error: null }),
    update: (patch) => ({ eq: async (col, id) => { writes.push({ id, patch }); Object.assign(rows.find((r) => r.id === id), patch); return { error: null }; } }),
  }) };
  const server = fs.readFileSync(path.join(root, 'webapp/server.js'), 'utf8');
  const src = server.slice(server.indexOf('async function sealStoredMcps() {'), server.indexOf('// The one connect handler.'));
  const sealStoredMcps = new Function('supabase', 'mcpClient', src + '; return sealStoredMcps;')(supabase, mcp);
  assert.equal(await sealStoredMcps(), 1);
  assert.deepEqual(writes.map((w) => w.id), ['old']);
  assert.match(rows[0].auth_token, /^enc:v1:/);
  assert.match(rows[0].env.TEST_KEY, /^enc:v1:/);
  assert.equal(plain(mcp.openRow(rows[0])).auth_token, 'test-plain-token');
  assert.equal(await sealStoredMcps(), 0, 'nothing left to seal');
});

test('every place that reads or writes an MCP connection seals and opens it', () => {
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const server = read('webapp/server.js');
  assert.match(server, /\.upsert\(mcpClient\.sealRow\(record\), \{ onConflict: "user_id,server_url" \}\)/);
  assert.match(server, /from\("user_mcps"\)\.update\(mcpClient\.sealRow\(patch\)\)\.eq\("id", row\.id\)/);
  assert.match(server, /const mcp = mcpClient\.openRow\(stored\);/);
  assert.match(server, /\(await sealStoredMcps\(\)\);/);
  assert.match(read('lib/user-mcp.js'), /from\("user_mcps"\)\.update\(mcp\.sealRow\(patch\)\)/);
  assert.match(read('lib/user-mcp.js'), /await openEntry\(mcp\.openRow\(row\), /);
  assert.match(read('lib/services/usi-connector.js'), /mcp\.openClient\(mcp\.openRow\(row\), \{ connectTimeoutMs: 20000, save: patch => mustWrite\(db\.from\("user_mcps"\)\.update\(mcp\.sealRow\(patch\)\)/);
  for (const f of ['webapp/server.js', 'lib/user-mcp.js', 'lib/services/usi-connector.js']) {
    assert.doesNotMatch(read(f), /from\("user_mcps"\)\s*\.(?:update|upsert|insert)\((?!mcp(?:Client)?\.sealRow\(|\{ status|patch\)|\{ \.\.\.)/, f);
  }
});

test('a Mac Bridge token is kept only as a hash, and a token saved before still works', async () => {
  const bt = require('../webapp/bridge-token');
  assert.equal(fs.readFileSync(path.join(root, 'lib/bridge-token.js'), 'utf8'), fs.readFileSync(path.join(root, 'webapp/bridge-token.js'), 'utf8'));
  const token = 'a'.repeat(64);
  const hash = bt.hashBridgeToken(token);
  assert.match(hash, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(hash.slice(7), token);
  assert.deepEqual(bt.storedForms(token), [hash, token]);
  assert.deepEqual(bt.storedForms(hash), [bt.hashBridgeToken(hash)], 'a hash copied from the database is not a token');
  const rows = [{ user_id: 'u1', token }, { user_id: 'u2', token: bt.hashBridgeToken('b'.repeat(64)) }];
  const db = { from: () => ({
    select: async () => ({ data: rows.map((r) => ({ ...r })), error: null }),
    update: (patch) => { const q = { filters: {}, eq(col, v) { this.filters[col] = v; return this; },
      then(resolve) { const r = rows.find((x) => x.user_id === this.filters.user_id && x.token === this.filters.token); if (r) Object.assign(r, patch); resolve({ error: null }); } }; return q; },
  }) };
  assert.equal(await bt.hashStoredTokens(db), 1);
  assert.equal(rows[0].token, hash);
  assert.equal(await bt.hashStoredTokens(db), 0, 'nothing left to hash');
});

test('the Bridge token goes only to the Mac: made at pairing, stored hashed, looked up by hash', () => {
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  for (const f of ['webapp/server.js', 'lib/bridge-server.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /from\("user_bridges"\)[^;]*\.eq\("token"/, f);
    assert.doesNotMatch(src, /select\("user_id, token, pairing_code"\)|token: row\.token|token: msg\.token/, f);
    assert.match(src, /\.update\(\{ token: (?:bridgeToken\.)?hashBridgeToken\(token\), status: "connected", pairing_code: null \}\)/, f);
  }
  const server = read('webapp/server.js');
  assert.equal((server.match(/\.in\("token", bridgeToken\.storedForms\((?:msg\.)?token\)\)/g) || []).length, 3);
  assert.match(server, /token: bridgeToken\.hashBridgeToken\(msg\.token\), status: "connected"/);
  assert.match(server, /await bridgeToken\.hashStoredTokens\(supabase\)/);
  assert.match(read('lib/bridge-server.js'), /\.in\("token", storedForms\(token\)\)/);
  assert.match(read('lib/bridge-server.js'), /user_id: userId,\n\s*token: hashBridgeToken\(token\),/);
});
