const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
function registration(values, request) {
  const context = { module: { exports: {} }, URL, AbortSignal, fetch: request, require: name => ({
    'node:crypto': crypto,
    './config': { getConf: async k => values[k], setConf: async patch => Object.assign(values, patch) },
    './crypto-tokens': { encryptString: x => 'enc:v1:' + x, decryptString: x => x?.replace(/^enc:v1:/, '') },
  })[name] };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../webapp/phone-registration.js'), 'utf8'), context);
  return context.module.exports;
}
test('installation identity survives restart and tunnel credentials are not stored in plaintext', async () => {
  const values = {}, calls = [];
  const url = 'https://ch-11111111111141118111111111111111.closedhand.com';
  const request = async (path, options) => { calls.push(options.headers.Authorization); return { ok: true, json: async () => path.endsWith('/register') ? { ticket: 'signed-fixture' } : { state: 'active', url, token: 'fixture-per-install-token-1234567890' } }; };
  const first = registration(values, request);
  await Promise.all([first.begin(), first.begin()]);
  assert.equal(calls[0], calls[1]);
  assert.match(values.PHONE_INSTALL_SECRET, /^enc:v1:/);
  await first.connection();
  assert.match(values.PHONE_TUNNEL_TOKEN, /^enc:v1:/);
  const restarted = registration(values, async () => { throw new Error('Provider unavailable'); });
  assert.equal((await restarted.connection()).url, url, 'existing installation can restart while the provisioning service is down');
  for (const invalid of ['https://evil.example', 'https://ch-11111111111141118111111111111111.closedhand.com.evil.example', url + '?secret=leak', url + '/other', 'http://localhost:3000']) assert.equal(first.validAddress(invalid), false);
});
test('unexpected registration responses never persist tokens or an attacker address', async () => {
  const values = {};
  const client = registration(values, async () => ({ ok: true, json: async () => ({ state: 'active', url: 'https://other.example', token: 'a'.repeat(40) }) }));
  await assert.rejects(client.connection(), /verified/);
  assert.equal(values.PHONE_TUNNEL_TOKEN, undefined);
});
