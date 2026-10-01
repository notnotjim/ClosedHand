const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
function registration(values, request) {
  const context = { module: { exports: {} }, URL, URLSearchParams, Buffer, AbortSignal, process: { env: {PORT:'3000'} }, fetch: request, require: name => ({
    'node:crypto': crypto,
    './config': { getConf: async k => values[k], setConf: async patch => Object.assign(values, patch) },
    './crypto-tokens': { encryptString: x => 'enc:v1:' + x, decryptString: x => x?.replace(/^enc:v1:/, '') },
  })[name] };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../webapp/phone-registration.js'), 'utf8'), context);
  return context.module.exports;
}
test('installation identity survives restart and tunnel credentials are not stored in plaintext', async () => {
  const values = {}, calls = [];
  const url = 'https://alex.closedhand.ai';
  const request = async (path, options) => { calls.push(options.headers.Authorization); return { ok: true, json: async () => path.endsWith('/register') ? { ticket: 'signed-fixture' } : { state: 'active', url, token: 'fixture-per-install-token-1234567890' } }; };
  const first = registration(values, request);
  await Promise.all([first.begin('fixture'), first.begin('fixture')]);
  assert.equal(calls[0], calls[1]);
  assert.match(values.PHONE_INSTALL_SECRET, /^enc:v1:/);
  await first.connection();
  assert.match(values.PHONE_TUNNEL_TOKEN, /^enc:v1:/);
  const restarted = registration(values, async () => { throw new Error('Provider unavailable'); });
  assert.equal((await restarted.connection()).url, url, 'existing installation can restart while the provisioning service is down');
  for (const invalid of ['https://evil.example', 'https://alex.closedhand.ai.evil.example', 'https://www.closedhand.ai', 'https://alex.closedhand.com', url + '?secret=leak', url + '/other', 'http://localhost:3000']) assert.equal(first.validAddress(invalid), false);
});
test('an old address is refreshed without changing the installation identity', async () => {
  const values = { PHONE_PERMANENT_URL: 'https://ch-11111111111141118111111111111111.closedhand.com', PHONE_TUNNEL_TOKEN: 'enc:v1:old-token-fixture', PHONE_INSTALL_ID: '11111111-1111-4111-8111-111111111111', PHONE_INSTALL_SECRET: 'enc:v1:' + 'a'.repeat(64) };
  let calls = 0;
  const client = registration(values, async () => { calls++; return { ok: true, json: async () => ({ state: 'active', url: 'https://alex.closedhand.ai', token: 'fixture-per-install-token-1234567890' }) }; });
  assert.equal((await client.connection()).url, 'https://alex.closedhand.ai');
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
  await client.begin();
  assert.ok(calls[0].url.includes('/phone-enrollment/register'));
  assert.deepEqual(JSON.parse(calls[0].options.body),{port:3000,confirm:'code'},'no name: closedhand.com picks it');
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

test('a personal URL is asked for without a name, through the one enrollment route', async () => {
  const calls = [], values = {};
  const client = registration(values, async (url, options) => { calls.push([url, options.body]); return { ok: true, json: async () => ({ ticket: 'fixture' }) }; });
  assert.match(await client.begin(), /^https:\/\/closedhand\.com\/phone-access\/pair#t=fixture&state=[a-f0-9]{32}$/);
  assert.deepEqual(JSON.parse(calls[0][1]), { port: 3000, confirm: 'code' });
  assert.equal(values.PHONE_ADDRESS_NAME, undefined, 'the name is not known until it is confirmed');
  await client.connection().catch(() => {});
  assert.ok(calls.every(([u]) => u.startsWith('https://closedhand.com/api/phone-enrollment/')), 'no calls to the retired route');
});

test('renaming tidies the name as closedhand.com does, then drops the old connection to reconnect', async () => {
  const website = require('../closedhand-com/lib/names');
  const values = { PHONE_PERMANENT_URL: 'https://amber-fox-42.closedhand.ai', PHONE_TUNNEL_TOKEN: 'enc:v1:token', PHONE_ADDRESS_NAME: 'amber-fox-42' }, calls = [];
  const client = registration(values, async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({ state: 'pending', url: 'https://lucy-smith.closedhand.ai', redirectUntil: '2026-10-29T00:00:00.000Z' }) }; });
  for (const typed of ['Lucy Smith', '  José! ', 'my.home_server', '--a--b', 'x'.repeat(40), '42-lucy', '日本', 'Zoë-Ångström']) {
    assert.equal(client.cleanName(typed), website.cleanName(typed), JSON.stringify(typed));
  }
  for (const bad of ['ab', 'admin', '日本', '']) await assert.rejects(client.rename(bad), /3 to 32 letters/);
  assert.equal(calls.length, 0, 'nothing sent for a name that cannot be used');
  const done = await client.rename('  Lucy Smith! ');
  assert.ok(calls[0].url.endsWith('/api/phone-enrollment/rename'));
  assert.deepEqual(calls[0].body, { name: 'lucy-smith' });
  assert.equal(done.url, 'https://lucy-smith.closedhand.ai');
  assert.equal(values.PHONE_PERMANENT_URL, null, 'the old address is no longer used');
  assert.equal(values.PHONE_TUNNEL_TOKEN, null);
  assert.equal(values.PHONE_ADDRESS_NAME, 'lucy-smith');
  assert.equal(client.status().ownershipConfirmed, true);
  const refused = registration({}, async () => ({ ok: false, json: async () => ({ error: 'That name is taken. Try another.' }) }));
  await assert.rejects(refused.rename('lucy'), /taken/);
  const odd = registration({}, async () => ({ ok: true, json: async () => ({ state: 'pending', url: 'https://evil.example' }) }));
  await assert.rejects(odd.rename('lucy'), /could not be verified/);
});

test('a confirmed code remembers the name closedhand.com picked', async () => {
  const values = {};
  const client = registration(values, async () => ({ ok: true, json: async () => ({ state: 'pending', url: 'https://amber-fox-42.closedhand.ai' }) }));
  await client.claim('ABC234');
  assert.equal(values.PHONE_ADDRESS_NAME, 'amber-fox-42');
});

test('the code from closedhand.com is checked, tidied and sent only by this copy', async () => {
  const values = {}, calls = [];
  const client = registration(values, async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ state: 'pending', url: 'https://fixture.closedhand.ai' }) }; });
  await assert.rejects(client.claim('12'), /6 letters and numbers/);
  await assert.rejects(client.claim(''), /6 letters and numbers/);
  assert.equal(calls.length, 0, 'nothing sent for a malformed code');
  assert.equal((await client.claim(' abc-234 ')).state, 'pending');
  assert.ok(calls[0].url.endsWith('/api/phone-enrollment/claim'));
  assert.deepEqual(JSON.parse(calls[0].options.body), { code: 'ABC234' });
  assert.match(calls[0].options.headers.Authorization, /^Bearer [a-f0-9-]{36}\.[a-f0-9]{64}$/);
  assert.equal(client.status().ownershipConfirmed, true);
  const refused = registration({}, async () => ({ ok: false, json: async () => ({ error: 'That code does not match. Check the code on closedhand.com and try again.' }) }));
  await assert.rejects(refused.claim('ABC234'), /does not match/);
  assert.equal(refused.status().ownershipConfirmed, false);
});

test('closedhand.com counts as available only when reached and giving out personal URLs, checked at most every thirty seconds', async () => {
  let calls = 0, reply = { ok: true, json: async () => ({ signedIn: false, available: true }) };
  const client = registration({}, async url => { calls++; assert.equal(url, 'https://closedhand.com/api/account'); if (reply instanceof Error) throw reply; return reply; });
  assert.equal(await client.serviceAvailable(), true);
  assert.equal(await client.serviceAvailable(), true);
  assert.equal(calls, 1, 'cached');
  for (const [answer, why] of [[{ ok: true, json: async () => ({ available: false }) }, 'switched off'], [{ ok: false, json: async () => ({}) }, 'refused'], [new Error('offline'), 'unreachable']]) {
    reply = answer;
    const fresh = registration({}, async () => { if (reply instanceof Error) throw reply; return reply; });
    assert.equal(await fresh.serviceAvailable(), false, why);
  }
});
test('a saved address that stops working is checked again, and forgotten only when closedhand.com no longer knows it', async () => {
  const saved = { PHONE_PERMANENT_URL: 'https://amber-fox-42.closedhand.ai', PHONE_TUNNEL_TOKEN: 'enc:v1:fixture-per-install-token-1234567890', PHONE_ADDRESS_NAME: 'amber-fox-42', PHONE_ENROLLMENT: '2',
    PHONE_INSTALL_ID: '11111111-1111-4111-8111-111111111111', PHONE_INSTALL_SECRET: 'enc:v1:' + 'a'.repeat(64) };
  let calls = 0;
  const ask = answer => async () => { calls++; if (answer instanceof Error) throw answer; return { ok: true, json: async () => answer }; };
  // Working: the saved one is used without asking.
  let values = { ...saved };
  assert.equal((await registration(values, ask({ state: 'unconfirmed' })).connection()).url, saved.PHONE_PERMANENT_URL);
  assert.equal(calls, 0);
  // Stopped working, and closedhand.com can't be reached: kept.
  values = { ...saved };
  assert.equal((await registration(values, ask(new Error('offline'))).connection({ recheck: true })).url, saved.PHONE_PERMANENT_URL);
  assert.equal(values.PHONE_PERMANENT_URL, saved.PHONE_PERMANENT_URL);
  // Still known there: carries on.
  values = { ...saved };
  const still = await registration(values, ask({ state: 'active', url: saved.PHONE_PERMANENT_URL, token: 'fixture-per-install-token-1234567890' })).connection({ recheck: true });
  assert.equal(still.url, saved.PHONE_PERMANENT_URL);
  // Gone there (account deleted, unused, or moved to another computer): forgotten here too.
  values = { ...saved };
  const client = registration(values, ask({ state: 'unconfirmed' }));
  assert.equal(await client.connection({ recheck: true }), null);
  assert.deepEqual([values.PHONE_PERMANENT_URL, values.PHONE_TUNNEL_TOKEN, values.PHONE_ADDRESS_NAME, values.PHONE_ENROLLMENT], [null, null, null, null]);
  assert.equal(values.PHONE_INSTALL_ID, saved.PHONE_INSTALL_ID, 'the computer keeps its identity');
  assert.equal(client.status().ownershipConfirmed, false);
});
// Objects made inside the sandbox, compared as plain data.
const plain = value => JSON.parse(JSON.stringify(value));
test('the ClosedHand account: shown only as closedhand.com states it, and deleted there before anything here is forgotten', async () => {
  const saved = { PHONE_PERMANENT_URL: 'https://amber-fox-42.closedhand.ai', PHONE_TUNNEL_TOKEN: 'enc:v1:fixture-per-install-token-1234567890', PHONE_ADDRESS_NAME: 'amber-fox-42',
    PHONE_INSTALL_ID: '11111111-1111-4111-8111-111111111111', PHONE_INSTALL_SECRET: 'enc:v1:' + 'a'.repeat(64) };
  const calls = [];
  const reply = answer => async (url, options) => { calls.push([options.method, url]); return { ok: !answer.error, json: async () => answer }; };
  assert.deepEqual(plain(await registration({ ...saved }, reply({ account: { provider: 'google', email: 'a@example.com', url: 'https://amber-fox-42.closedhand.ai' } })).account()),
    { provider: 'google', email: 'a@example.com', url: 'https://amber-fox-42.closedhand.ai' });
  assert.equal(await registration({ ...saved }, reply({ account: { provider: 'google', email: 'a@example.com', url: 'https://evil.example' } })).account(), null, 'never an address it cannot verify');
  assert.equal(await registration({ ...saved }, reply({ account: null })).account(), null);
  // A computer that never asked for a personal URL has no account, and never makes an identity to find out.
  const fresh = {};
  assert.equal(await registration(fresh, reply({})).account(), null);
  assert.deepEqual(plain(await registration(fresh, reply({})).deleteAccount()), { deleted: false });
  assert.equal(fresh.PHONE_INSTALL_ID, undefined);
  // Refused there: nothing forgotten here.
  let values = { ...saved };
  await assert.rejects(registration(values, reply({ error: 'Please wait a minute and try again.' })).deleteAccount(), /wait a minute/);
  assert.equal(values.PHONE_PERMANENT_URL, saved.PHONE_PERMANENT_URL);
  values = { ...saved };
  calls.length = 0;
  assert.deepEqual(plain(await registration(values, reply({ deleted: true })).deleteAccount()), { deleted: true });
  assert.deepEqual(calls, [['POST', 'https://closedhand.com/api/phone-enrollment/account/delete']]);
  assert.equal(values.PHONE_PERMANENT_URL, null); assert.equal(values.PHONE_TUNNEL_TOKEN, null);
});

test('claiming with the Microsoft sign-in sends it once, by this copy, and steps aside when closedhand.com wants the confirmation page', async () => {
  const values = {}, calls = [];
  const client = registration(values, async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ state: 'pending', url: 'https://amber-fox-42.closedhand.ai' }) }; });
  const done = await client.claimWithMicrosoft('id.token.here');
  assert.equal(done.url, 'https://amber-fox-42.closedhand.ai');
  assert.ok(calls[0].url.endsWith('/api/phone-enrollment/claim-microsoft'));
  assert.deepEqual(JSON.parse(calls[0].options.body), { idToken: 'id.token.here', port: 3000 });
  assert.match(calls[0].options.headers.Authorization, /^Bearer [a-f0-9-]{36}\.[a-f0-9]{64}$/);
  assert.equal(values.PHONE_ADDRESS_NAME, 'amber-fox-42'); assert.equal(values.PHONE_ENROLLMENT, '2');
  assert.equal(client.status().ownershipConfirmed, true);
  const elsewhere = registration({}, async () => ({ ok: true, json: async () => ({ state: 'unconfirmed', claimHere: true }) }));
  assert.equal(await elsewhere.claimWithMicrosoft('id.token.here'), null);
  assert.equal(elsewhere.status().ownershipConfirmed, false);
  const attacker = registration({}, async () => ({ ok: true, json: async () => ({ state: 'pending', url: 'https://evil.example' }) }));
  assert.equal(await attacker.claimWithMicrosoft('id.token.here'), null, 'an address that is not a personal URL is ignored');
});

test('a code handed straight back counts only with the state from this copy\'s own recent link, and only once', async () => {
  const values = {}, sent = [];
  const client = registration(values, async (url, options) => { sent.push(url); return { ok: true, json: async () => url.endsWith('/register') ? { ticket: 'fixture' } : { state: 'connecting', url: 'https://amber-fox-42.closedhand.ai' } }; });
  const link = new URL(await client.begin());
  assert.equal(link.origin + link.pathname, 'https://closedhand.com/phone-access/pair');
  const params = new URLSearchParams(link.hash.slice(1));
  assert.equal(params.get('t'), 'fixture');
  assert.match(params.get('state'), /^[a-f0-9]{32}$/);
  for (const stranger of ['f'.repeat(32), 'short', '', null]) await assert.rejects(client.claim('ABC123', stranger), /didn’t come from this ClosedHand/);
  assert.equal(sent.filter(u => u.endsWith('/claim')).length, 0, 'a code with a strange state is never sent on');
  await client.claim('abc 123', params.get('state'));
  assert.equal(sent.filter(u => u.endsWith('/claim')).length, 1);
  await assert.rejects(client.claim('ABC123', params.get('state')), /didn’t come/, 'one use');
  await client.claim('ABC123');
  assert.equal(sent.filter(u => u.endsWith('/claim')).length, 2, 'a typed code needs no state');
  // A link older than its ticket's thirty minutes no longer counts.
  const later = new URLSearchParams(new URL(await client.begin()).hash.slice(1)).get('state');
  values.PHONE_CLAIM_STATES = JSON.stringify(JSON.parse(values.PHONE_CLAIM_STATES).map(s => ({ ...s, at: s.at - 31 * 60000 })));
  await assert.rejects(client.claim('ABC123', later), /didn’t come/);
});
