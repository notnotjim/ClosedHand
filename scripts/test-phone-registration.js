const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
function registration(values, request) {
  const context = { module: { exports: {} }, URL, AbortSignal, process: { env: {PORT:'3000'} }, fetch: request, require: name => ({
    'node:crypto': crypto,
    './config': { getConf: async k => values[k], setConf: async patch => Object.assign(values, patch) },
    './crypto-tokens': { encryptString: x => 'enc:v1:' + x, decryptString: x => x?.replace(/^enc:v1:/, '') },
  })[name] };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../webapp/phone-registration.js'), 'utf8'), context);
  return context.module.exports;
}
test('installation identity survives restart and tunnel credentials are not stored in plaintext', async () => {
  const values = {}, calls = [];
  const url = 'https://james.closedhand.ai';
  const request = async (path, options) => { calls.push(options.headers.Authorization); return { ok: true, json: async () => path.endsWith('/register') ? { ticket: 'signed-fixture' } : { state: 'active', url, token: 'fixture-per-install-token-1234567890' } }; };
  const first = registration(values, request);
  await Promise.all([first.begin('fixture'), first.begin('fixture')]);
  assert.equal(calls[0], calls[1]);
  assert.match(values.PHONE_INSTALL_SECRET, /^enc:v1:/);
  await first.connection();
  assert.match(values.PHONE_TUNNEL_TOKEN, /^enc:v1:/);
  const restarted = registration(values, async () => { throw new Error('Provider unavailable'); });
  assert.equal((await restarted.connection()).url, url, 'existing installation can restart while the provisioning service is down');
  for (const invalid of ['https://evil.example', 'https://james.closedhand.ai.evil.example', 'https://www.closedhand.ai', 'https://james.closedhand.com', url + '?secret=leak', url + '/other', 'http://localhost:3000']) assert.equal(first.validAddress(invalid), false);
});
test('an old address is refreshed without changing the installation identity', async () => {
  const values = { PHONE_PERMANENT_URL: 'https://ch-11111111111141118111111111111111.closedhand.com', PHONE_TUNNEL_TOKEN: 'enc:v1:old-token-fixture', PHONE_INSTALL_ID: '11111111-1111-4111-8111-111111111111', PHONE_INSTALL_SECRET: 'enc:v1:' + 'a'.repeat(64) };
  let calls = 0;
  const client = registration(values, async () => { calls++; return { ok: true, json: async () => ({ state: 'active', url: 'https://james.closedhand.ai', token: 'fixture-per-install-token-1234567890' }) }; });
  assert.equal((await client.connection()).url, 'https://james.closedhand.ai');
  assert.equal(calls, 1);
  assert.equal(values.PHONE_INSTALL_ID, '11111111-1111-4111-8111-111111111111');
});
test('unexpected registration responses never persist tokens or an attacker address', async () => {
  const values = {};
  const client = registration(values, async () => ({ ok: true, json: async () => ({ state: 'active', url: 'https://other.example', token: 'a'.repeat(40) }) }));
  await assert.rejects(client.connection(), /verified/);
  assert.equal(values.PHONE_TUNNEL_TOKEN, undefined);
});
test('new address stays unpublished until the exact installation confirms it', async () => {
  const values={}, calls=[];
  const client=registration(values,async(url,options)=>{
    calls.push({url,options});
    return {ok:true,json:async()=>url.endsWith('/register') ? {ticket:'fixture'} : url.endsWith('/connected') ? {state:'active'} : {state:'connecting',url:'https://fixture.closedhand.ai',token:'private-fixture-token-1234567890'}};
  });
  await client.begin('fixture');
  assert.ok(calls[0].url.includes('/phone-enrollment/register'));
  assert.deepEqual(JSON.parse(calls[0].options.body),{name:'fixture',port:3000});
  const connecting=await client.connection();assert.equal(connecting.verify,true);
  assert.equal(values.PHONE_PERMANENT_URL,undefined);assert.equal(values.PHONE_TUNNEL_TOKEN,undefined);
  const nonce='b'.repeat(64),secret=values.PHONE_INSTALL_SECRET.replace('enc:v1:','');
  assert.equal(await client.challenge(nonce),crypto.createHmac('sha256',secret).update('closedhand-address:'+nonce).digest('hex'));
  await assert.rejects(client.challenge('invalid'));
  await client.confirm(connecting);
  assert.equal(values.PHONE_PERMANENT_URL,'https://fixture.closedhand.ai');
  assert.match(values.PHONE_TUNNEL_TOKEN,/^enc:v1:/);
});

test('ownership confirmation is distinct from provisioning and a verified URL', async () => {
  const values = { PHONE_ENROLLMENT: '2' };
  let state = 'unconfirmed';
  const client = registration(values, async () => ({ ok: true, json: async () => ({ state }) }));
  await client.connection(); assert.equal(client.status().ownershipConfirmed, false);
  for (state of ['pending', 'provisioning', 'error']) {
    assert.equal(await client.connection(), null);
    assert.equal(client.status().ownershipConfirmed, true);
    assert.equal(client.status().registrationState, state);
    assert.equal(values.PHONE_PERMANENT_URL, undefined);
  }
});

test('a personal URL always has a chosen name and uses the one enrollment route', async () => {
  const calls = [];
  const client = registration({}, async (url) => { calls.push(url); return { ok: true, json: async () => ({ ticket: 'fixture' }) }; });
  await assert.rejects(client.begin(), /Choose a name/);
  assert.equal(calls.length, 0);
  await client.begin('fixture');
  await client.connection().catch(() => {});
  assert.ok(calls.every(u => u.startsWith('https://closedhand.com/api/phone-enrollment/')), 'no calls to the retired route');
});
