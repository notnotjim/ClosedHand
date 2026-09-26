// End-to-end check of the closedhand.com service against a real Postgres.
// Run: DATABASE_URL=postgres://... node --test closedhand-com/test/e2e.js
// Google, Microsoft and the copy of ClosedHand are stand-ins; nothing leaves
// this machine.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
const { connect, migrate } = require('../lib/db');
const { createApp } = require('../server');

const env = {
  BASE_URL: 'https://closedhand.com', SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
  TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY, PHONE_ENROLLMENT_ENABLED: '1', PHONE_PROVISIONER_SECRET: 'p'.repeat(40),
  GOOGLE_CLIENT_ID: 'google-client', GOOGLE_CLIENT_SECRET: 'g-secret', MICROSOFT_CLIENT_ID: 'ms-client', MICROSOFT_CLIENT_SECRET: 'm-secret',
};
const idToken = claims => 'x.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.y';
let db, server, base, nextClaims = null, challengeSecret = null;
const request = async (url, opts) => {
  if (url.includes('oauth2.googleapis.com/token') || url.includes('login.microsoftonline.com')) {
    const nonce = new URLSearchParams(opts.body).get('code');
    return new Response(JSON.stringify({ id_token: idToken({ ...nextClaims, nonce }) }));
  }
  if (url.includes('/.well-known/closedhand-installation')) {
    const nonce = new URL(url).searchParams.get('nonce');
    return new Response(JSON.stringify({ proof: crypto.createHmac('sha256', challengeSecret).update('closedhand-address:' + nonce).digest('hex') }));
  }
  throw new Error('unexpected request ' + url);
};

before(async () => {
  db = connect();
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate(db);
  const { app } = createApp({ db, env, request });
  await new Promise(r => { server = app.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
});
after(async () => { server?.close(); await db?.end(); });

const cookieFrom = res => (res.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).filter(c => !c.endsWith('=')).join('; ');
// Signs in through the real routes; the stand-in token endpoint echoes the
// nonce back as the code so the ID token matches this sign-in.
async function signIn(provider, claims) {
  const start = await fetch(base + '/auth/' + provider + '?return_to=%2Fopen', { redirect: 'manual' });
  assert.equal(start.status, 302);
  const to = new URL(start.headers.get('location'));
  assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(to.searchParams.get('code_challenge'));
  nextClaims = claims;
  const back = await fetch(base + `/auth/${provider}/callback?code=${to.searchParams.get('nonce')}&state=${to.searchParams.get('state')}`,
    { redirect: 'manual', headers: { cookie: cookieFrom(start) } });
  assert.equal(back.status, 302);
  return { location: back.headers.get('location'), cookie: cookieFrom(back) };
}
const google = (sub, email, verified = true) => ({ iss: 'https://accounts.google.com', aud: 'google-client', sub, email, email_verified: verified, exp: Date.now() / 1000 + 600 });
const microsoft = (tid, oid, email) => ({ iss: `https://login.microsoftonline.com/${tid}/v2.0`, aud: 'ms-client', tid, oid, email, preferred_username: email, exp: Date.now() / 1000 + 600 });
const account = async cookie => (await fetch(base + '/api/account', { headers: { cookie } })).json();
const json = (method, path, body, headers = {}) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) });

test('the website pages answer and old dashboard links lead to the finder', async () => {
  for (const p of ['/', '/privacy', '/terms', '/ethos', '/architecture', '/open', '/phone-access/pair']) assert.equal((await fetch(base + p)).status, 200, p);
  // Every stylesheet, script and image a page links to exists.
  const fs = require('node:fs'), path = require('node:path');
  for (const view of fs.readdirSync(path.join(__dirname, '..', 'views'))) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'views', view), 'utf8');
    for (const [, ref] of html.matchAll(/(?:href|src)="(\/[^"#?]+\.(?:css|js|png|svg|glb))"/g)) assert.equal((await fetch(base + ref)).status, 200, view + ' -> ' + ref);
  }
  const old = await fetch(base + '/dashboard#x', { redirect: 'manual' });
  assert.equal(old.headers.get('location'), '/open?next=%2Fdashboard');
  assert.equal((await fetch(base + '/nope')).status, 404);
  assert.deepEqual(await (await fetch(base + '/api/assistant-mail-relay/availability')).json(), { available: false });
});

test('a Microsoft account claiming someone else\'s email becomes its own owner, never theirs', async () => {
  const victim = await signIn('google', google('g-victim', 'victim@example.com'));
  assert.equal(victim.location, '/open');
  const attacker = await signIn('microsoft', microsoft('11111111-2222-4333-8444-555555555555', '66666666-7777-4888-9999-000000000000', 'victim@example.com'));
  const a = await account(victim.cookie), b = await account(attacker.cookie);
  assert.equal(a.provider, 'google'); assert.equal(b.provider, 'microsoft');
  const owners = (await db.query("SELECT count(*)::int n FROM owners WHERE lower(email) = 'victim@example.com'")).rows[0].n;
  assert.equal(owners, 2, 'two separate owners, not one merged by email');
  // A changed ID token (wrong audience, wrong issuer, stale nonce) signs nobody in.
  const bad = await signIn('microsoft', { ...microsoft('11111111-2222-4333-8444-555555555555', '66666666-7777-4888-9999-000000000000', 'x@y.z'), aud: 'someone-else' });
  assert.match(bad.location, /sign_in_error=1/);
  assert.equal(bad.cookie, '');
});

test('an owner carried over from the old service is claimed only by the same verified Google address', async () => {
  await db.query("INSERT INTO owners (provider, subject, email) VALUES ('google', NULL, 'carried@example.com')");
  const unverified = await signIn('google', google('g-other', 'carried@example.com', false));
  const claimedEarly = (await db.query("SELECT subject FROM owners WHERE subject IS NULL AND email = 'carried@example.com'")).rowCount;
  assert.equal(claimedEarly, 1, 'an unverified address does not claim it');
  const ms = await signIn('microsoft', microsoft('11111111-2222-4333-8444-555555555555', '12121212-2222-4333-8444-555555555555', 'carried@example.com'));
  assert.equal((await db.query("SELECT 1 FROM owners WHERE subject IS NULL AND email = 'carried@example.com'")).rowCount, 1, 'Microsoft never claims it');
  const verified = await signIn('google', google('g-carried', 'carried@example.com'));
  assert.equal((await db.query("SELECT subject FROM owners WHERE email = 'carried@example.com' AND provider = 'google' AND subject = 'g-carried'")).rowCount, 1);
  assert.ok(unverified.cookie && ms.cookie && verified.cookie);
});

test('personal URL: request, confirm, build, connect, and every refusal on the way', async () => {
  const installId = crypto.randomUUID(), installSecret = crypto.randomBytes(32).toString('hex');
  challengeSecret = installSecret;
  const bearer = { Authorization: `Bearer ${installId}.${installSecret}` };
  const reg = await (await json('POST', '/api/phone-enrollment/register', { name: 'alex', port: 3000 }, bearer)).json();
  assert.ok(reg.ticket);
  assert.equal((await json('POST', '/api/phone-enrollment/register', { name: 'admin', port: 3000 }, bearer)).status, 400, 'reserved name');
  assert.equal((await json('POST', '/api/phone-enrollment/register', { name: 'alex', port: 3000 })).status, 401, 'no installation');
  const unsigned = await (await json('POST', '/api/phone-enrollment/details', { ticket: reg.ticket })).json();
  assert.deepEqual(unsigned, { url: 'https://alex.closedhand.ai', state: 'unconfirmed' });
  const owner = await signIn('microsoft', microsoft('9188040d-6c67-4c5b-b112-36a304b66dad', '00000000-0000-0000-aaaa-000000000001', 'alex@outlook.com'));
  assert.equal((await json('POST', '/api/phone-enrollment/approve', { ticket: reg.ticket })).status, 401, 'not signed in');
  assert.equal((await json('POST', '/api/phone-enrollment/approve', { ticket: reg.ticket }, { cookie: owner.cookie, Origin: 'https://evil.example' })).status, 403, 'other origin');
  const tampered = reg.ticket.replace(/.$/, c => (c === 'a' ? 'b' : 'a'));
  assert.equal((await json('POST', '/api/phone-enrollment/approve', { ticket: tampered }, { cookie: owner.cookie, Origin: 'https://closedhand.com' })).status, 400, 'tampered ticket');
  const approved = await (await json('POST', '/api/phone-enrollment/approve', { ticket: reg.ticket }, { cookie: owner.cookie, Origin: 'https://closedhand.com' })).json();
  assert.deepEqual(approved, { state: 'pending', url: 'https://alex.closedhand.ai' });
  // Somebody else asking for the same name is refused.
  const otherId = crypto.randomUUID(), otherSecret = crypto.randomBytes(32).toString('hex');
  const other = await (await json('POST', '/api/phone-enrollment/register', { name: 'alex', port: 3000 }, { Authorization: `Bearer ${otherId}.${otherSecret}` })).json();
  const rival = await signIn('google', google('g-rival', 'rival@example.com'));
  const taken = await json('POST', '/api/phone-enrollment/approve', { ticket: other.ticket }, { cookie: rival.cookie, Origin: 'https://closedhand.com' });
  assert.equal(taken.status, 409);
  assert.match((await taken.json()).error, /already taken/);
  // The Worker builds the route.
  const worker = { Authorization: 'Bearer ' + env.PHONE_PROVISIONER_SECRET };
  assert.equal((await json('POST', '/api/phone-enrollment/jobs/lease', {}, { Authorization: 'Bearer wrong' })).status, 401);
  const { job } = await (await json('POST', '/api/phone-enrollment/jobs/lease', {}, worker)).json();
  assert.equal(job.hostname, 'alex.closedhand.ai'); assert.equal(job.port, 3000);
  const tunnelId = crypto.randomUUID(), dnsId = crypto.randomBytes(16).toString('hex');
  const tunnelToken = t => Buffer.from(JSON.stringify({ a: 'f'.repeat(32), t, s: crypto.randomBytes(32).toString('base64') })).toString('base64');
  const token = tunnelToken(tunnelId);
  const wrongTunnel = await json('POST', '/api/phone-enrollment/jobs/checkpoint', { id: job.id, attempt: job.attempt, tunnelId, dnsId, token: tunnelToken(crypto.randomUUID()) }, worker);
  assert.equal(wrongTunnel.status, 400, 'a token for some other tunnel is refused');
  assert.deepEqual(await (await json('POST', '/api/phone-enrollment/jobs/checkpoint', { id: job.id, attempt: job.attempt, tunnelId, dnsId, token }, worker)).json(), { ok: true });
  const stored = (await db.query('SELECT tunnel_token, state FROM addresses WHERE id = $1', [installId])).rows[0];
  assert.equal(stored.state, 'connecting'); assert.ok(stored.tunnel_token.startsWith('enc:v1:')); assert.ok(!stored.tunnel_token.includes(token));
  // The copy collects its connection, connects, and proves it answers there.
  const conn = await (await fetch(base + '/api/phone-enrollment/connection', { headers: bearer })).json();
  assert.deepEqual(conn, { state: 'connecting', url: 'https://alex.closedhand.ai', token });
  const wrongCopy = await (await fetch(base + '/api/phone-enrollment/connection', { headers: { Authorization: `Bearer ${installId}.${'0'.repeat(64)}` } })).json();
  assert.deepEqual(wrongCopy, { state: 'unconfirmed' }, 'the wrong secret learns nothing');
  challengeSecret = crypto.randomBytes(32).toString('hex');
  assert.equal((await json('POST', '/api/phone-enrollment/connected', {}, bearer)).status, 409, 'a wrong answer to the challenge does not activate');
  challengeSecret = installSecret;
  assert.deepEqual(await (await json('POST', '/api/phone-enrollment/connected', {}, bearer)).json(), { state: 'active' });
  assert.equal((await account(owner.cookie)).url, 'https://alex.closedhand.ai');
  assert.equal((await account(rival.cookie)).url, null);
  assert.equal((await (await json('POST', '/api/phone-enrollment/details', { ticket: reg.ticket }, { cookie: rival.cookie })).json()).state, 'unconfirmed', 'progress only for its owner');
});

test('bug reports: saved once per submission, with a receipt that checks only that report', async () => {
  const key = crypto.randomBytes(32).toString('hex');
  const body = { submission_key: key, comment: 'It broke', transcript: [{ role: 'user', content: 'hi' }], screenshots: [{ base64: Buffer.from('png').toString('base64'), mediaType: 'image/png' }, { base64: 'x', mediaType: 'text/html' }] };
  const first = await (await json('POST', '/api/bug-intake', body)).json();
  assert.equal(first.ok, true); assert.equal(first.screenshots, 1);
  const again = await (await json('POST', '/api/bug-intake', body)).json();
  assert.equal(again.id, first.id); assert.equal(again.receipt, first.receipt);
  assert.deepEqual(await (await json('POST', '/api/bug-intake/status', { id: first.id, receipt: first.receipt })).json(), { status: 'open', resolution_note: null, resolved_at: null });
  assert.equal((await json('POST', '/api/bug-intake/status', { id: first.id, receipt: '0'.repeat(64) })).status, 404);
  assert.equal((await json('POST', '/api/bug-intake', { comment: '' })).status, 400);
});

test('the attacks from the security review fail cleanly', async () => {
  // A signature with multi-byte characters once crashed the whole process.
  const crash = await fetch(base + '/auth/google/callback?code=x&state=y', { redirect: 'manual', headers: { cookie: 'ch_signin=a.' + '%C3%A9'.repeat(43) } });
  assert.equal(crash.status, 302);
  assert.equal((await fetch(base + '/health')).status, 200, 'still running');
  const oddAuth = await json('POST', '/api/phone-enrollment/jobs/lease', {}, { Authorization: 'Bearer ' + 'é'.repeat(20) });
  assert.equal(oddAuth.status, 401);
  // Lookalike and service-style names are refused.
  const id = crypto.randomUUID(), sec = crypto.randomBytes(32).toString('hex');
  for (const name of ['xn--pple-43d', 'autodiscover', 'webmail']) {
    assert.equal((await json('POST', '/api/phone-enrollment/register', { name, port: 3000 }, { Authorization: `Bearer ${id}.${sec}` })).status, 400, name);
  }
  // Large bodies only on bug intake; errors never show internals.
  const big = await json('POST', '/api/phone-enrollment/register', { name: 'x'.repeat(40000), port: 3000 }, { Authorization: `Bearer ${id}.${sec}` });
  assert.equal(big.status, 413);
  const bad = await fetch(base + '/api/bug-intake', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
  const text = await bad.text();
  assert.equal(bad.status, 400); assert.doesNotMatch(text, /\n\s+at |node_modules|\/Users\//);
  // The Worker still gets jobs when new addresses are switched off.
  const off = createApp({ db, env: { ...env, PHONE_ENROLLMENT_ENABLED: '0' }, request }).app;
  const offServer = await new Promise(r => { const s = off.listen(0, () => r(s)); });
  const offBase = 'http://127.0.0.1:' + offServer.address().port;
  const lease = await fetch(offBase + '/api/phone-enrollment/jobs/lease', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.PHONE_PROVISIONER_SECRET }, body: '{}' });
  assert.equal(lease.status, 200);
  offServer.close();
});

test('a reservation that never works is released after a day, a used one never is', async () => {
  const owner = (await db.query("INSERT INTO owners (provider, subject, email) VALUES ('google', 'g-stale', 's@example.com') RETURNING id")).rows[0].id;
  const other = (await db.query("INSERT INTO owners (provider, subject, email) VALUES ('google', 'g-used', 'u@example.com') RETURNING id")).rows[0].id;
  const staleId = crypto.randomUUID(), usedId = crypto.randomUUID();
  await db.query("INSERT INTO addresses (id, owner_id, secret_hash, hostname, created_at) VALUES ($1, $2, $3, 'stale.closedhand.ai', now() - interval '2 days')", [staleId, owner, 'a'.repeat(64)]);
  await db.query("INSERT INTO addresses (id, owner_id, secret_hash, hostname, state, activated_at, created_at) VALUES ($1, $2, $3, 'used.closedhand.ai', 'revoked', now() - interval '2 days', now() - interval '2 days')", [usedId, other, 'b'.repeat(64)]);
  await json('POST', '/api/phone-enrollment/jobs/lease', {}, { Authorization: 'Bearer ' + env.PHONE_PROVISIONER_SECRET });
  assert.equal((await db.query('SELECT 1 FROM addresses WHERE id = $1', [staleId])).rowCount, 0, 'never-routed stale reservation is gone');
  assert.equal((await db.query('SELECT 1 FROM addresses WHERE id = $1', [usedId])).rowCount, 1, 'an address that worked stays owned');
});
