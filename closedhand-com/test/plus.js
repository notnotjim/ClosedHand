// Closedhand+ (lib/plus.js) against a real Postgres, in a database of its own
// so it can run beside e2e.js (which empties its own as it starts), with a
// stand-in Polar and a stand-in OpenRouter: nothing leaves this machine.
// Invented people only.
// Run: DATABASE_URL=postgres://... node --test closedhand-com/test/plus.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { migrate } = require('../lib/db');
const { create, verify } = require('../lib/plus');

const PLUS = '11111111-1111-4111-8111-111111111111', EXTEND = '22222222-2222-4222-8222-222222222222';
const MANAGEMENT = 'sk-or-v1-' + 'm'.repeat(64);
const SECRET = 'whsec_' + crypto.randomBytes(32).toString('base64');
const NAME = 'closedhand_plus_test';
let admin, db;

before(async () => {
  admin = new Pool({ connectionString: process.env.DATABASE_URL });
  await admin.query(`DROP DATABASE IF EXISTS ${NAME}`);
  await admin.query(`CREATE DATABASE ${NAME}`);
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = '/' + NAME;
  db = new Pool({ connectionString: url.toString() });
  await migrate(db);
});
after(async () => {
  await db?.end();
  await admin?.query(`DROP DATABASE IF EXISTS ${NAME}`);
  await admin?.end();
});

// OpenRouter's keys and guardrails, and Polar's checkouts, portal and
// subscriptions, as far as Closedhand uses them.
function world({ polarFails = null } = {}) {
  const keys = new Map(), calls = [];
  const reply = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status });
  const state = { openRouterDown: false };
  const request = async (url, opts = {}) => {
    const method = opts.method || 'GET', body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method, url, body });
    if (url.startsWith('https://openrouter.ai/api/v1')) {
      assert.equal(opts.headers.Authorization, 'Bearer ' + MANAGEMENT);
      if (state.openRouterDown) throw new Error('fetch failed');
      const path = url.slice('https://openrouter.ai/api/v1'.length);
      if (path.startsWith('/guardrails?')) return reply(200, { data: [{ id: 'rail-1', name: 'Closedhand included AI' }] });
      if (path === '/guardrails/rail-1') return reply(200, { data: {} });
      if (path === '/guardrails/rail-1/assignments/keys') { for (const h of body.key_hashes) keys.get(h).guarded = true; return reply(200, {}); }
      if (path === '/keys' && method === 'POST') {
        const hash = crypto.randomBytes(32).toString('hex'), key = 'sk-or-v1-' + crypto.randomBytes(32).toString('hex');
        keys.set(hash, { key, limit: body.limit, limit_reset: body.limit_reset || null, usage: 0, guarded: false });
        return reply(201, { data: { hash, limit: body.limit }, key });
      }
      const m = path.match(/^\/keys\/([a-f0-9]{64})$/);
      if (m && method === 'GET') { const k = keys.get(m[1]); return k ? reply(200, { data: { limit: k.limit, usage: k.usage, usage_monthly: k.usage_monthly ?? k.usage, limit_reset: k.limit_reset } }) : reply(404, {}); }
      if (m && method === 'PATCH') { Object.assign(keys.get(m[1]), body); return reply(200, { data: keys.get(m[1]) }); }
      if (m && method === 'DELETE') { keys.delete(m[1]); return reply(200, {}); }
    }
    if (url.startsWith('https://api.polar.sh/') || url.startsWith('https://sandbox-api.polar.sh/')) {
      assert.equal(opts.headers.Authorization, 'Bearer polar-token');
      const path = url.replace(/^https:\/\/(sandbox-)?api\.polar\.sh/, '');
      if (polarFails && path.startsWith(polarFails.path)) return reply(polarFails.status, { error: polarFails.error || 'Unavailable', detail: 'no' });
      if (path === '/v1/checkouts/') return reply(201, { id: 'chk_1', url: 'https://polar.sh/checkout/fixture-' + body.products[0].slice(0, 4) });
      if (path === '/v1/customer-sessions/') return reply(201, { token: 't', customer_portal_url: 'https://polar.sh/portal/fixture' });
      if (path.startsWith('/v1/subscriptions/') && method === 'DELETE') return reply(200, { status: 'canceled' });
      const product = path.match(/^\/v1\/products\/(.+)$/);
      if (product && method === 'GET') {
        const each = (usd, gbp, eur) => [['usd', usd], ['gbp', gbp], ['eur', eur]].map(([c, a]) => ({ amount_type: 'fixed', price_currency: c, price_amount: a, is_archived: false }));
        return reply(200, { id: product[1], prices: product[1] === PLUS ? each(800, 600, 700) : each(800, 600, 750) });
      }
    }
    throw new Error('unexpected ' + method + ' ' + url);
  };
  const env = {
    OPENROUTER_PROVISIONING_KEY: MANAGEMENT, TOKEN_ENCRYPTION_KEY: 'k'.repeat(44),
    POLAR_ACCESS_TOKEN: 'polar-token', POLAR_WEBHOOK_SECRET: SECRET, POLAR_PLUS_PRODUCT_ID: PLUS, POLAR_EXTEND_PRODUCT_ID: EXTEND,
  };
  const includedAi = require('../lib/included-ai').create({ db, env, request });
  const plus = create({ db, env, request, includedAi, baseUrl: 'https://closedhand.com' });
  return { keys, calls, state, plus, includedAi };
}

let people = 0;
async function person({ freeKey = null } = {}, w) {
  const id = (await db.query("INSERT INTO owners (provider, subject, email) VALUES ('google', $1, $2) RETURNING id", ['g-plus-' + (++people), `person${people}@example.com`])).rows[0].id;
  if (freeKey) {
    const hash = crypto.randomBytes(32).toString('hex');
    w.keys.set(hash, { key: 'sk-or-v1-free', limit: 10, limit_reset: null, usage: freeKey.usage || 0, guarded: true });
    await db.query('INSERT INTO included_ai_keys (owner_id, key_hash, granted_usd) VALUES ($1, $2, 10)', [id, hash]);
    return { id, hash };
  }
  return { id };
}
const heldKey = async (w, ownerId) => w.keys.get((await db.query('SELECT key_hash FROM included_ai_keys WHERE owner_id = $1', [ownerId])).rows[0]?.key_hash);
const lastMonth = () => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };
let events = 0;
const subscription = (type, ownerId, { id = 'sub_' + ownerId.slice(0, 8), status = 'active', cancel = false, at = new Date(Date.now() + (++events) * 1000).toISOString(), product = PLUS } = {}) => ({
  type, timestamp: at,
  data: { id, status, product_id: product, customer_id: 'cus_' + ownerId.slice(0, 8), customer: { id: 'cus_' + ownerId.slice(0, 8), external_id: ownerId },
    current_period_end: '2026-12-01T00:00:00Z', cancel_at_period_end: cancel, modified_at: at, metadata: {} },
});
const paid = (ownerId, product = EXTEND) => ({ type: 'order.paid', data: { id: 'ord_1', product_id: product, customer: { external_id: ownerId }, metadata: { owner_id: ownerId } } });
async function settled(ownerId) {
  for (let i = 0; i < 100; i++) {
    const row = (await db.query('SELECT key_synced FROM plus_subscriptions WHERE owner_id = $1', [ownerId])).rows[0];
    if (!row || row.key_synced) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('the key was never set to match');
}
const quiet = fn => async () => { const log = console.log, err = console.error; console.log = console.error = () => {}; try { await fn(); } finally { console.log = log; console.error = err; } };

test('a webhook is accepted only with a fresh, valid signature', () => {
  const body = Buffer.from(JSON.stringify({ type: 'subscription.active', data: {} }));
  const now = Date.now(), at = String(Math.floor(now / 1000)), id = 'msg_1';
  const sign = (key, content = body, stamp = at) => 'v1,' + crypto.createHmac('sha256', key).update(Buffer.concat([Buffer.from(`${id}.${stamp}.`), content])).digest('base64');
  const standard = Buffer.from(SECRET.slice(6), 'base64');
  const headers = (signature, stamp = at) => ({ 'webhook-id': id, 'webhook-timestamp': stamp, 'webhook-signature': signature });
  assert.equal(verify(headers(sign(standard)), body, SECRET, now), true, 'a Standard Webhooks secret');
  assert.equal(verify(headers(sign(Buffer.from(SECRET, 'utf8'))), body, SECRET, now), true, 'an older secret, signed with its own bytes');
  assert.equal(verify(headers('v1,bm90IGl0 ' + sign(standard)), body, SECRET, now), true, 'any one of several signatures');
  assert.equal(verify(headers(sign(crypto.randomBytes(32))), body, SECRET, now), false, 'another secret');
  assert.equal(verify(headers(sign(standard)), Buffer.from(body.toString().replace('active', 'revoked')), SECRET, now), false, 'a changed body');
  const old = String(Math.floor(now / 1000) - 400);
  assert.equal(verify(headers(sign(standard, body, old), old), body, SECRET, now), false, 'a replay from minutes ago');
  assert.equal(verify({ 'webhook-id': id, 'webhook-timestamp': at }, body, SECRET, now), false, 'no signature');
  assert.equal(verify(headers(sign(standard)), body, '', now), false, 'no secret set');
});

test('checkout, carrying on and the portal go to Polar for this account only', async () => {
  const w = world();
  const p = await person({}, w);
  assert.equal(await w.plus.checkout({ id: p.id, email: 'person@example.com' }), 'https://polar.sh/checkout/fixture-1111');
  const asked = w.calls.at(-1);
  assert.equal(asked.url, 'https://api.polar.sh/v1/checkouts/');
  assert.deepEqual(asked.body, { products: [PLUS], external_customer_id: p.id, customer_email: 'person@example.com', success_url: 'https://closedhand.com/account?plus=welcome', metadata: { owner_id: p.id } });
  await w.plus.extend({ id: p.id });
  assert.deepEqual(w.calls.at(-1).body.products, [EXTEND]);
  assert.equal(w.calls.at(-1).body.success_url, 'https://closedhand.com/account?plus=extended');
  assert.equal(await w.plus.portal({ id: p.id }), 'https://polar.sh/portal/fixture');
  assert.deepEqual(w.calls.at(-1).body, { external_customer_id: p.id, return_url: 'https://closedhand.com/account' });
  // Polar's sandbox, for trying it out.
  const sandbox = create({ db, env: { POLAR_SERVER: 'sandbox', POLAR_ACCESS_TOKEN: 'polar-token', POLAR_WEBHOOK_SECRET: SECRET, POLAR_PLUS_PRODUCT_ID: PLUS }, request: (u, o) => { w.calls.push({ url: u }); return new Response(JSON.stringify({ url: 'https://sandbox.polar.sh/c' })); }, includedAi: w.includedAi });
  await sandbox.checkout({ id: p.id });
  assert.equal(w.calls.at(-1).url, 'https://sandbox-api.polar.sh/v1/checkouts/');
});

test('subscribing sets the key to the fair-use ceiling, reset monthly; carrying on doubles it this month; ending stops it', async () => {
  const w = world();
  const p = await person({ freeKey: { usage: 3 } }, w);
  assert.equal(await w.plus.handle(subscription('subscription.created', p.id, { status: 'incomplete' })), 'subscription incomplete');
  await settled(p.id);
  assert.deepEqual([(await heldKey(w, p.id)).limit, (await heldKey(w, p.id)).limit_reset], [10, null], 'a payment not through yet changes nothing');
  assert.equal((await w.plus.state(p.id)).active, false);

  await w.plus.handle(subscription('subscription.active', p.id));
  await settled(p.id);
  assert.deepEqual([(await heldKey(w, p.id)).limit, (await heldKey(w, p.id)).limit_reset], [20, 'monthly']);
  assert.deepEqual(await w.plus.state(p.id), { available: true, active: true, renews_at: '2026-12-01T00:00:00.000Z', extended: false, nearly: false });

  assert.equal(await w.plus.handle(paid(p.id)), 'carried on to the end of the month');
  await settled(p.id);
  assert.equal((await heldKey(w, p.id)).limit, 40);
  assert.equal((await w.plus.state(p.id)).extended, true);
  assert.equal(await w.plus.handle(paid(p.id, PLUS)), 'not carrying on', 'only the carry-on product counts');

  // Cancelled: it runs to the end of the paid month.
  await w.plus.handle(subscription('subscription.canceled', p.id, { cancel: true }));
  await settled(p.id);
  assert.deepEqual(await w.plus.state(p.id), { available: true, active: true, ends_at: '2026-12-01T00:00:00.000Z', extended: true, nearly: false });
  assert.equal((await heldKey(w, p.id)).limit, 40, 'still on until it ends');
  // An older event arriving late changes nothing.
  assert.equal(await w.plus.handle(subscription('subscription.updated', p.id, { at: '2020-01-01T00:00:00Z' })), 'older than what is known');

  (await heldKey(w, p.id)).usage = 7.456;
  await w.plus.handle(subscription('subscription.revoked', p.id, { status: 'canceled', cancel: true }));
  await settled(p.id);
  assert.deepEqual([(await heldKey(w, p.id)).limit, (await heldKey(w, p.id)).limit_reset], [7.45, null], 'stopped where it stands');
  assert.equal((await w.plus.state(p.id)).active, false);
});

test('a checkout that never went through leaves the free use alone', async () => {
  const w = world();
  const p = await person({ freeKey: { usage: 2 } }, w);
  await w.plus.handle(subscription('subscription.created', p.id, { status: 'incomplete' }));
  await w.plus.handle(subscription('subscription.updated', p.id, { status: 'incomplete_expired' }));
  await settled(p.id);
  assert.deepEqual([(await heldKey(w, p.id)).limit, (await heldKey(w, p.id)).limit_reset], [10, null]);
});

test('events for other products or unknown accounts are ignored', async () => {
  const w = world();
  const p = await person({}, w);
  assert.equal(await w.plus.handle(subscription('subscription.active', p.id, { product: '33333333-3333-4333-8333-333333333333' })), 'another product');
  assert.equal(await w.plus.handle(subscription('subscription.active', crypto.randomUUID())), 'no account');
  assert.equal(await w.plus.handle({ type: 'checkout.updated', data: {} }), 'not used');
  assert.equal((await db.query('SELECT 1 FROM plus_subscriptions WHERE owner_id = $1', [p.id])).rowCount, 0);
});

test('a subscriber whose account has no key gets one from their computer, once; nobody else does', async () => {
  const w = world();
  const p = await person({}, w), free = await person({}, w);
  await w.plus.handle(subscription('subscription.active', p.id));
  await settled(p.id);
  assert.equal(await w.includedAi.collect(free.id), null, 'not a subscriber');
  const got = await w.includedAi.collect(p.id);
  assert.match(got.key, /^sk-or-v1-[a-f0-9]{64}$/);
  const held = await heldKey(w, p.id);
  assert.equal(held.key, got.key);
  assert.deepEqual([held.limit, held.limit_reset, held.guarded], [20, 'monthly', true], 'the fair-use ceiling, behind the guardrail');
  const row = (await db.query('SELECT * FROM included_ai_keys WHERE owner_id = $1', [p.id])).rows[0];
  assert.ok(!JSON.stringify(row).includes(got.key), 'only its hash is kept');
  assert.equal(Number(row.granted_usd), 0, 'no free use was given');
  assert.equal(await w.includedAi.collect(p.id), null, 'handed over once');
  // Claiming again from another computer makes a fresh subscriber key.
  const again = await w.includedAi.forOwner(p.id, { ip: '198.51.100.9' });
  assert.ok(again.key && again.key !== got.key);
  assert.deepEqual([(await heldKey(w, p.id)).limit, (await heldKey(w, p.id)).limit_reset], [20, 'monthly']);
});

test('the hourly sweep ends a month carried on past fair use, and retries keys OpenRouter missed', quiet(async () => {
  const w = world();
  const p = await person({ freeKey: {} }, w);
  await w.plus.handle(subscription('subscription.active', p.id));
  await settled(p.id);
  await db.query('UPDATE plus_subscriptions SET extended_month = $2 WHERE owner_id = $1', [p.id, lastMonth()]);
  w.state.openRouterDown = true;
  await w.plus.handle(paid(p.id));
  await new Promise(r => setTimeout(r, 50));
  assert.equal((await db.query('SELECT key_synced FROM plus_subscriptions WHERE owner_id = $1', [p.id])).rows[0].key_synced, false, 'not set while OpenRouter is down');
  w.state.openRouterDown = false;
  await w.plus.sweep();
  assert.equal((await heldKey(w, p.id)).limit, 40, 'carried on this month');
  await db.query('UPDATE plus_subscriptions SET extended_month = $2 WHERE owner_id = $1', [p.id, lastMonth()]);
  // The server's hourly run: the month carried on ends, then the key follows.
  await w.includedAi.sweep();
  await w.plus.sweep();
  assert.equal((await heldKey(w, p.id)).limit, 20, 'back to fair use in a new month');
  assert.equal((await db.query('SELECT extended_month FROM plus_subscriptions WHERE owner_id = $1', [p.id])).rows[0].extended_month, null);
}));

test('a new subscription is not undone by the old one ending late', async () => {
  const w = world();
  const p = await person({ freeKey: {} }, w);
  await w.plus.handle(subscription('subscription.active', p.id, { id: 'sub_new' }));
  await w.plus.handle(subscription('subscription.revoked', p.id, { id: 'sub_old', status: 'canceled' }));
  await settled(p.id);
  assert.equal((await w.plus.state(p.id)).active, true);
  assert.equal((await heldKey(w, p.id)).limit, 20);
});

test('deleting an account stops its subscription at Polar first, and waits when Polar can not be reached', async () => {
  const w = world();
  const p = await person({}, w);
  await w.plus.handle(subscription('subscription.active', p.id, { id: 'sub_fixture_1' }));
  assert.equal(await w.plus.forget(p.id), true);
  assert.deepEqual([w.calls.at(-1).method, w.calls.at(-1).url], ['DELETE', 'https://api.polar.sh/v1/subscriptions/sub_fixture_1']);

  const gone = world({ polarFails: { path: '/v1/subscriptions/', status: 403, error: 'AlreadyCanceledSubscription' } });
  const q = await person({}, gone);
  await gone.plus.handle(subscription('subscription.active', q.id));
  assert.equal(await gone.plus.forget(q.id), true, 'already cancelled at Polar is fine');

  const barred = world({ polarFails: { path: '/v1/subscriptions/', status: 403, error: 'InsufficientScope' } });
  const s = await person({}, barred);
  await barred.plus.handle(subscription('subscription.active', s.id));
  await assert.rejects(barred.plus.forget(s.id), /Polar answered 403/, 'a token that may not cancel keeps the account');

  const down = world({ polarFails: { path: '/v1/subscriptions/', status: 503 } });
  const r = await person({}, down);
  await down.plus.handle(subscription('subscription.active', r.id));
  await assert.rejects(down.plus.forget(r.id), /Polar answered 503/);

  const none = await person({}, w);
  assert.equal(await w.plus.forget(none.id), false, 'nothing to stop');
});

test('prices are shown in the currency Polar will charge where the person is', async () => {
  const w = world();
  const { currencyFor } = require('../lib/plus');
  assert.deepEqual(['GB', 'JE', 'DE', 'ie', 'US', 'JP', '', undefined].map(currencyFor), ['gbp', 'gbp', 'eur', 'eur', 'usd', 'usd', 'usd', 'usd']);
  assert.deepEqual(await w.plus.prices('GB'), { plus: '£6', extend: '£6' });
  assert.deepEqual(await w.plus.prices('FR'), { plus: '€7', extend: '€7.50' });
  assert.deepEqual(await w.plus.prices('US'), { plus: '$8', extend: '$8' }, 'each currency written as its own customers write it');
  const asked = w.calls.filter(c => c.url.includes('/v1/products/')).length;
  await w.plus.prices('GB');
  assert.equal(w.calls.filter(c => c.url.includes('/v1/products/')).length, asked, 'read once an hour, not per visit');
});

test('the account page is told when most of this month\'s fair use is used, never how much', async () => {
  const w = world();
  const p = await person({ freeKey: true }, w);
  await w.plus.handle(subscription('subscription.active', p.id));
  await settled(p.id);
  assert.equal((await w.plus.state(p.id)).nearly, false);
  const [, key] = [...w.keys][0];
  key.usage_monthly = 17;
  const now = await w.plus.state(p.id);
  assert.equal(now.nearly, true);
  assert.ok(!JSON.stringify(now).includes('17'), 'no amount reaches the page');
});
