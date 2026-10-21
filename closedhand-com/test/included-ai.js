// The AI that comes with Closedhand (lib/included-ai.js), against a stand-in
// OpenRouter and a stand-in database: nothing leaves this machine.
// Run: node --test closedhand-com/test/included-ai.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { create } = require('../lib/included-ai');

const MANAGEMENT = 'sk-or-v1-' + 'm'.repeat(64);

// OpenRouter as far as Closedhand uses it: keys with a limit and usage, and
// guardrails that keys are attached to.
function openRouter({ down = false, failAssign = false } = {}) {
  const keys = new Map(), guardrails = [], calls = [];
  const reply = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status });
  const request = async (url, opts = {}) => {
    const method = opts.method || 'GET', path = url.replace('https://openrouter.ai/api/v1', '');
    calls.push(method + ' ' + path);
    assert.equal(opts.headers.Authorization, 'Bearer ' + MANAGEMENT, 'only the management key is used');
    if (down) throw new Error('fetch failed');
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (method === 'GET' && path.startsWith('/guardrails')) return reply(200, { data: guardrails });
    if (method === 'POST' && path === '/guardrails') { const g = { id: crypto.randomUUID(), ...body }; guardrails.push(g); return reply(201, { data: g }); }
    if (method === 'PATCH' && path.startsWith('/guardrails/')) { Object.assign(guardrails.find(g => g.id === path.split('/')[2]), body); return reply(200, { data: {} }); }
    let m = path.match(/^\/guardrails\/([^/]+)\/assignments\/keys$/);
    if (m && method === 'POST') {
      if (failAssign) return reply(500, { error: 'boom' });
      for (const hash of body.key_hashes) keys.get(hash).guardrail = m[1];
      return reply(200, { assigned_count: body.key_hashes.length });
    }
    if (method === 'POST' && path === '/keys') {
      const hash = crypto.randomBytes(32).toString('hex'), key = 'sk-or-v1-' + crypto.randomBytes(32).toString('hex');
      keys.set(hash, { name: body.name, limit: body.limit, usage: 0, key, guardrail: null });
      return reply(201, { data: { hash, name: body.name, limit: body.limit, limit_remaining: body.limit, usage: 0 }, key });
    }
    m = path.match(/^\/keys\/([a-f0-9]{64})$/);
    if (m && method === 'GET') {
      const k = keys.get(m[1]);
      return k ? reply(200, { data: { hash: m[1], limit: k.limit, usage: k.usage, limit_remaining: k.limit - k.usage } }) : reply(404, { error: 'not found' });
    }
    if (m && method === 'DELETE') { keys.delete(m[1]); return reply(200, { deleted: true }); }
    throw new Error('unexpected ' + method + ' ' + url);
  };
  return { request, keys, guardrails, calls };
}

// The few queries included-ai.js makes, over lists of rows: accounts (owners),
// their keys (included_ai_keys) and the free use given (starter_grants).
function database() {
  const rows = [], grants = [], owners = new Map();
  const DAY = 24 * 3600 * 1000;
  const monthStart = () => { const d = new Date(); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0); return d; };
  const result = list => ({ rows: list, rowCount: list.length });
  return {
    rows, grants, owners,
    async query(sql, args = []) {
      if (sql.startsWith('SELECT * FROM included_ai_keys') || sql.startsWith('SELECT key_hash FROM included_ai_keys')) return result(rows.filter(r => r.owner_id === args[0]));
      if (sql.startsWith('INSERT INTO included_ai_keys')) { rows.push({ owner_id: args[0], key_hash: args[1], granted_usd: args[2], granted_at: new Date() }); return result([]); }
      if (sql.startsWith('UPDATE included_ai_keys')) { rows.find(r => r.owner_id === args[0]).key_hash = args[1]; return result([]); }
      if (sql.startsWith('SELECT provider, subject FROM owners')) return result(owners.has(args[0]) ? [owners.get(args[0])] : []);
      if (sql.startsWith('UPDATE starter_grants SET network_hash = NULL')) { for (const g of grants) if (Date.now() - g.granted_at > 30 * DAY) g.network_hash = null; return result([]); }
      if (sql.startsWith('SELECT 1 FROM starter_grants WHERE person_hash')) return result(grants.filter(g => g.person_hash === args[0]));
      if (sql.includes('FROM starter_grants WHERE network_hash')) return result([{ n: grants.filter(g => g.network_hash === args[0] && Date.now() - g.granted_at < 30 * DAY).length }]);
      if (sql.includes('SUM(granted_usd) FILTER')) {
        const sum = list => list.reduce((n, g) => n + g.granted_usd, 0);
        return result([{ day: sum(grants.filter(g => Date.now() - g.granted_at < DAY)), month: sum(grants.filter(g => g.granted_at >= monthStart())) }]);
      }
      if (sql.startsWith('INSERT INTO starter_grants')) {
        if (grants.some(g => g.person_hash === args[0])) return result([]);
        const g = { id: grants.length + 1, person_hash: args[0], network_hash: args[1], granted_usd: args[2], granted_at: new Date() };
        grants.push(g);
        return result([{ id: g.id }]);
      }
      if (sql.startsWith('DELETE FROM starter_grants')) { grants.splice(grants.findIndex(g => g.id === args[0]), 1); return result([]); }
      throw new Error('unexpected query ' + sql);
    },
  };
}
// An account signed in with an invented Google account.
const ACCOUNT_KEY = 'k'.repeat(44);
const env = (more = {}) => ({ OPENROUTER_PROVISIONING_KEY: MANAGEMENT, TOKEN_ENCRYPTION_KEY: ACCOUNT_KEY, ...more });
let people = 0;
const owner = (db, subject = 'g-' + (++people)) => { const id = crypto.randomUUID(); db?.owners.set(id, { provider: 'google', subject }); return id; };
// Each claim from its own connection unless a test says otherwise.
let addresses = 0;
const from = () => ({ ip: '198.51.100.' + (++addresses % 250) });
const quiet = fn => async () => { const log = console.log, err = console.error; console.log = console.error = () => {}; try { await fn(); } finally { console.log = log; console.error = err; } };

test('a claim gets a key of its own: the starter credit, the chosen model only, on providers that keep nothing', async () => {
  const or = openRouter(), db = database();
  const ai = create({ db, env: env(), request: or.request });
  const id = owner(db);
  const given = await ai.forOwner(id, from());
  assert.match(given.key, /^sk-or-v1-[a-f0-9]{64}$/);
  assert.deepEqual(given.models, { chat: 'deepseek/deepseek-v4.1-flash', background: 'deepseek/deepseek-v4.1-flash' });
  const [hash, made] = [...or.keys][0];
  assert.equal(made.limit, 10);
  assert.equal(made.name, 'Closedhand ' + id, 'named by the account, never its email');
  const rail = or.guardrails[0];
  assert.equal(made.guardrail, rail.id, 'attached to the guardrail');
  assert.deepEqual(rail.allowed_models, ['deepseek/deepseek-v4.1-flash']);
  for (const field of ['enforce_zdr_other', 'enforce_zdr_anthropic', 'enforce_zdr_openai', 'enforce_zdr_google', 'enforce_zdr_xai']) assert.equal(rail[field], true, field);
  for (const field of ['allow_safety_retention_other', 'allow_safety_retention_google', 'enable_paid_model_training', 'enable_free_model_training', 'enable_free_model_publication']) assert.equal(rail[field], false, field);
  assert.deepEqual(db.rows.map(r => [r.key_hash, r.granted_usd]), [[hash, 10]], 'only the hash is kept, with the credit given');
  assert.ok(!JSON.stringify(db.rows).includes(given.key), 'the key itself is never stored');
  // A second account reuses the guardrail instead of making another.
  await ai.forOwner(owner(db), from());
  assert.equal(or.guardrails.length, 1);
});

test('claiming again gets a new key with what was left; the old one stops working', async () => {
  const or = openRouter(), db = database();
  const ai = create({ db, env: env(), request: or.request });
  const id = owner(db);
  await ai.forOwner(id, from());
  const [firstHash, first] = [...or.keys][0];
  first.usage = 6.25;
  const again = await ai.forOwner(id, from());
  assert.ok(again.key);
  assert.ok(!or.keys.has(firstHash), 'the old key is deleted');
  const [, second] = [...or.keys][0];
  assert.equal(second.limit, 3.75, 'it carries what was left');
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].granted_usd, 10, 'no new starter credit');
  // Used up: nothing more to hand over.
  second.usage = 3.75;
  assert.equal(await ai.forOwner(id, from()), null);
});

test('new starter credit stops at the monthly cap, and the claim goes on without a key', quiet(async () => {
  const or = openRouter(), db = database();
  const ai = create({ db, env: env({ INCLUDED_AI_MONTHLY_CAP_USD: '25' }), request: or.request });
  assert.ok(await ai.forOwner(owner(db), from()));
  assert.ok(await ai.forOwner(owner(db), from()));
  assert.equal(await ai.forOwner(owner(db), from()), null, '$30 would pass the $25 cap');
  assert.equal(or.keys.size, 2);
}));

test('nothing is made without a management key, or when OpenRouter is unreachable', quiet(async () => {
  const or = openRouter();
  assert.equal(await create({ db: database(), env: {}, request: or.request }).forOwner(owner(), from()), null);
  assert.equal(or.calls.length, 0);
  const down = openRouter({ down: true });
  assert.equal(await create({ db: database(), env: env(), request: down.request }).forOwner(owner(), from()), null);
}));

test('a key the guardrail could not be attached to is deleted, never handed over', quiet(async () => {
  const or = openRouter({ failAssign: true }), db = database();
  const ai = create({ db, env: env(), request: or.request });
  assert.equal(await ai.forOwner(owner(db), from()), null);
  assert.equal(or.keys.size, 0, 'the unguarded key is gone');
  assert.equal(db.rows.length, 0);
  assert.equal(db.grants.length, 0, 'the free use it held is given back');
}));

test('deleting the account deletes its key', async () => {
  const or = openRouter(), db = database();
  const ai = create({ db, env: env(), request: or.request });
  const id = owner(db);
  await ai.forOwner(id, from());
  await ai.forget(id);
  assert.equal(or.keys.size, 0);
});

test('the models come from the settings: chat first, support second; ones being switched away from stay allowed', async () => {
  const or = openRouter();
  const ai = create({ db: database(), env: env({ INCLUDED_AI_MODELS: 'deepseek/deepseek-v4.1-flash, qwen/qwen3-next', INCLUDED_AI_RETIRING_MODELS: 'deepseek/deepseek-v4-flash', INCLUDED_AI_STARTER_USD: '5' }), request: or.request });
  const given = await ai.forOwner(owner(), from());
  assert.deepEqual(given.models, { chat: 'deepseek/deepseek-v4.1-flash', background: 'qwen/qwen3-next' });
  assert.deepEqual(ai.current(), given.models, 'computers asking get the same pick');
  assert.deepEqual(or.guardrails[0].allowed_models, ['deepseek/deepseek-v4.1-flash', 'qwen/qwen3-next', 'deepseek/deepseek-v4-flash']);
  assert.equal(create({ db: database(), env: {}, request: or.request }).current(), null, 'none without a management key');
  assert.equal([...or.keys.values()][0].limit, 5);
});

test('free use is given once per person: deleting the account and claiming again gives nothing new', quiet(async () => {
  const or = openRouter(), db = database();
  const ai = create({ db, env: env(), request: or.request });
  const first = owner(db, 'g-avery');
  assert.ok(await ai.forOwner(first, from()));
  await ai.forget(first);
  db.rows.length = 0; // the account's row goes with it
  assert.equal(await ai.forOwner(owner(db, 'g-avery'), from()), null, 'the same sign-in, as a new account');
  assert.ok(await ai.forOwner(owner(db, 'g-blake'), from()), 'someone else still gets it');
  const kept = JSON.stringify(db.grants);
  for (const plain of ['g-avery', 'g-blake', '198.51.100.']) assert.ok(!kept.includes(plain), 'only fingerprints are kept, never ' + plain);
}));

test('one connection gets it a few times a month, then no more; others still do', quiet(async () => {
  const or = openRouter(), db = database();
  const ai = create({ db, env: env(), request: or.request });
  const home = { ip: '2001:db8:4:7:a::1' };
  for (let i = 0; i < 3; i++) assert.ok(await ai.forOwner(owner(db), home), 'claim ' + (i + 1));
  assert.equal(await ai.forOwner(owner(db), { ip: '2001:db8:4:7:b::2' }), null, 'another address in the same home');
  assert.equal(await ai.offered(home), false, 'setup is told before claiming');
  assert.equal(await ai.offered({ ip: '203.0.113.9' }), true);
  assert.ok(await ai.forOwner(owner(db), { ip: '203.0.113.9' }));
  // After 30 days the connection's fingerprint is forgotten.
  for (const g of db.grants) g.granted_at = new Date(Date.now() - 31 * 24 * 3600 * 1000);
  assert.ok(await ai.forOwner(owner(db), home));
  assert.equal(db.grants.filter(g => g.network_hash === null).length, 4);
}));

test('no more than a day\'s ceiling of new free use goes out in a day', quiet(async () => {
  const or = openRouter(), db = database();
  const ai = create({ db, env: env({ INCLUDED_AI_DAILY_CAP_USD: '25' }), request: or.request });
  assert.ok(await ai.forOwner(owner(db), from()));
  assert.ok(await ai.forOwner(owner(db), from()));
  assert.equal(await ai.forOwner(owner(db), from()), null, '$30 would pass the $25 day');
  assert.equal(await ai.offered(from()), false);
}));
