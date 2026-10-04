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
  MAIL_SES_REGION: 'ap-southeast-2', MAIL_FROM: 'ClosedHand <download@assist.closedhand.ai>', MAIL_AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', MAIL_AWS_SECRET_ACCESS_KEY: 'x', ALERT_EMAIL: 'operator@example.com', ADDRESS_RATE_PER_MINUTE: '1000',
};
const mails = [];
const idToken = claims => 'x.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.y';
let db, server, base, nextClaims = null, challengeSecret = null;
// Stand-in Microsoft signing key, for sign-ins a copy passes on (claim-microsoft).
const msKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const msJwk = { ...msKey.publicKey.export({ format: 'jwk' }), kid: 'test-kid', use: 'sig' };
const signedToken = (claims, key = msKey.privateKey, kid = 'test-kid') => {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return head + '.' + body + '.' + crypto.sign('RSA-SHA256', Buffer.from(head + '.' + body), key).toString('base64url');
};
const request = async (url, opts) => {
  if (url === 'https://login.microsoftonline.com/common/discovery/v2.0/keys') return new Response(JSON.stringify({ keys: [msJwk] }));
  if (url.includes('oauth2.googleapis.com/token') || url.includes('login.microsoftonline.com')) {
    const nonce = new URLSearchParams(opts.body).get('code');
    return new Response(JSON.stringify({ id_token: idToken({ ...nextClaims, nonce }) }));
  }
  if (url.startsWith('https://email.ap-southeast-2.amazonaws.com/')) { mails.push(JSON.parse(opts.body)); return new Response('{}'); }
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
  for (const p of ['/', '/privacy', '/terms', '/ethos', '/architecture', '/open', '/account', '/pcl', '/phone-access/pair']) assert.equal((await fetch(base + p)).status, 200, p);
  // Every stylesheet, script and image a page links to exists.
  const fs = require('node:fs'), path = require('node:path');
  for (const view of fs.readdirSync(path.join(__dirname, '..', 'views'))) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'views', view), 'utf8');
    for (const [, ref] of html.matchAll(/(?:href|src)="(\/[^"#?]+\.(?:css|js|png|svg|glb))"/g)) assert.equal((await fetch(base + ref)).status, 200, view + ' -> ' + ref);
  }
  // Pages name their files with a fingerprint, so a deploy can never pair a
  // new page with an old stylesheet or script kept by a browser or Cloudflare.
  const served = await (await fetch(base + '/open')).text();
  const css = served.match(/href="(\/site\.css\?v=[a-f0-9]{12})"/)?.[1], js = served.match(/src="(\/open\.js\?v=[a-f0-9]{12})"/)?.[1];
  assert.ok(css && js, 'the page links fingerprinted files');
  assert.match((await fetch(base + css)).headers.get('cache-control'), /immutable/);
  assert.equal((await fetch(base + '/site.css')).headers.get('cache-control'), 'no-cache');
  assert.equal((await fetch(base + '/site.css?v=000000000000')).headers.get('cache-control'), 'no-cache', 'a stale fingerprint is never kept');
  const missing = await fetch(base + '/nope');
  assert.equal(missing.status, 404); assert.match(await missing.text(), /site\.css\?v=/);
  // Signing out from My ClosedHand comes back to it, and never leaves the site.
  assert.equal((await fetch(base + '/logout?return_to=%2Fopen', { method: 'POST', redirect: 'manual' })).headers.get('location'), '/open');
  assert.equal((await fetch(base + '/logout?return_to=https%3A%2F%2Fevil.example', { method: 'POST', redirect: 'manual' })).headers.get('location'), '/open');
  assert.equal((await fetch(base + '/logout', { method: 'POST', redirect: 'manual' })).headers.get('location'), '/');
  const old = await fetch(base + '/dashboard#x', { redirect: 'manual' });
  assert.equal(old.headers.get('location'), '/open?next=%2Fdashboard');
  assert.equal((await fetch(base + '/nope')).status, 404);
  assert.deepEqual(await (await fetch(base + '/api/assistant-mail-relay/availability')).json(), { available: false });
  // Microsoft reads this to confirm closedhand.com publishes the sign-in app.
  assert.deepEqual(await (await fetch(base + '/.well-known/microsoft-identity-association.json')).json(), { associatedApplications: [] }, 'no real app IDs in the test settings');
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

test('signing in keeps only the email: names and pictures the provider sends are never saved', async () => {
  const start = await fetch(base + '/auth/google?return_to=%2Fopen', { redirect: 'manual' });
  assert.equal(new URL(start.headers.get('location')).searchParams.get('scope'), 'openid email');
  await signIn('google', { ...google('g-named', 'named@example.com'), name: 'Pat Example', picture: 'https://example.com/pat.png' });
  await signIn('microsoft', { ...microsoft('22222222-2222-4333-8444-555555555555', '77777777-7777-4888-9999-000000000000', 'ms-named@example.com'), name: 'Sam Example' });
  const columns = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'owners' ORDER BY 1")).rows.map(r => r.column_name);
  assert.deepEqual(columns, ['created_at', 'email', 'email_verified', 'id', 'provider', 'subject', 'updated_at'], 'the email, and whether the provider vouches for it');
  assert.doesNotMatch(JSON.stringify((await db.query('SELECT * FROM owners')).rows), /Pat Example|Sam Example|pat\.png/);
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

// A copy of ClosedHand, as the service sees it: a secret and the port it runs on.
const newCopy = (port = 3000) => {
  const secret = crypto.randomBytes(32).toString('hex');
  return { secret, port, hash: crypto.createHash('sha256').update(secret).digest('hex'), auth: { Authorization: `Bearer ${crypto.randomUUID()}.${secret}` } };
};
const signedIn = cookie => ({ cookie, Origin: 'https://closedhand.com' });
const worker = { Authorization: 'Bearer ' + env.PHONE_PROVISIONER_SECRET };
const tunnelToken = t => Buffer.from(JSON.stringify({ a: 'f'.repeat(32), t, s: crypto.randomBytes(32).toString('base64') })).toString('base64');
async function ask(copy, name) {
  const r = await json('POST', '/api/phone-enrollment/register', { name, port: copy.port, confirm: 'code' }, copy.auth);
  assert.equal(r.status, 200, name);
  return (await r.json()).ticket;
}
// The Worker builds (or rebuilds) the route and hands over a connection.
async function build(tunnelId = crypto.randomUUID(), dnsId = crypto.randomBytes(16).toString('hex')) {
  const { job } = await (await json('POST', '/api/phone-enrollment/jobs/lease', {}, worker)).json();
  assert.ok(job && !job.revoked, 'a build job');
  const token = tunnelToken(tunnelId);
  assert.deepEqual(await (await json('POST', '/api/phone-enrollment/jobs/checkpoint', { id: job.id, attempt: job.attempt, tunnelId, dnsId, token }, worker)).json(), { ok: true });
  return { job, token };
}

test('personal URL: request, confirm, type the code, build, connect, and every refusal on the way', async () => {
  const copy = newCopy();
  challengeSecret = copy.secret;
  const outdated = await json('POST', '/api/phone-enrollment/register', { name: 'alex', port: 3000 }, copy.auth);
  assert.equal(outdated.status, 400);
  assert.match((await outdated.json()).error, /Update ClosedHand/, 'a copy from before codes is told to update');
  const ticket = await ask(copy, 'alex');
  assert.equal((await json('POST', '/api/phone-enrollment/register', { name: 'admin', port: 3000, confirm: 'code' }, copy.auth)).status, 400, 'reserved name');
  assert.equal((await json('POST', '/api/phone-enrollment/register', { name: 'alex', port: 3000, confirm: 'code' })).status, 401, 'no installation');
  assert.deepEqual(await (await json('POST', '/api/phone-enrollment/details', { ticket })).json(), { url: 'https://alex.closedhand.ai', state: 'unconfirmed' });
  const owner = await signIn('microsoft', microsoft('9188040d-6c67-4c5b-b112-36a304b66dad', '00000000-0000-0000-aaaa-000000000001', 'alex@example.com'));
  assert.equal((await json('POST', '/api/phone-enrollment/approve', { ticket })).status, 401, 'not signed in');
  assert.equal((await json('POST', '/api/phone-enrollment/approve', { ticket }, { cookie: owner.cookie, Origin: 'https://evil.example' })).status, 403, 'other origin');
  const tampered = ticket.replace(/.$/, c => (c === 'a' ? 'b' : 'a'));
  assert.equal((await json('POST', '/api/phone-enrollment/approve', { ticket: tampered }, signedIn(owner.cookie))).status, 400, 'tampered ticket');
  // Confirming shows a code and changes nothing yet.
  assert.equal((await json('POST', '/api/phone-enrollment/claim', { code: 'ABC234' }, copy.auth)).status, 409, 'nothing to finish before confirming');
  const approved = await (await json('POST', '/api/phone-enrollment/approve', { ticket }, signedIn(owner.cookie))).json();
  assert.equal(approved.state, 'awaiting-code'); assert.match(approved.code, /^[A-HJKMNP-Z2-9]{6}$/); assert.equal(approved.move, undefined);
  assert.equal((await db.query("SELECT 1 FROM addresses WHERE hostname = 'alex.closedhand.ai'")).rowCount, 0);
  const shown = await (await json('POST', '/api/phone-enrollment/details', { ticket }, { cookie: owner.cookie })).json();
  assert.deepEqual(shown, { url: 'https://alex.closedhand.ai', state: 'awaiting-code', code: approved.code }, 'the owner sees the code again after a reload');
  const rival = await signIn('google', google('g-rival', 'rival@example.com'));
  assert.deepEqual(await (await json('POST', '/api/phone-enrollment/details', { ticket }, { cookie: rival.cookie })).json(), { url: 'https://alex.closedhand.ai', state: 'unconfirmed' }, 'nobody else sees it');
  const stored = (await db.query('SELECT code FROM approvals WHERE secret_hash = $1', [copy.hash])).rows[0].code;
  assert.ok(stored.startsWith('enc:v1:') && !stored.includes(approved.code), 'the code is stored sealed');
  // Only the copy that asked can finish, and only with the right code.
  assert.equal((await json('POST', '/api/phone-enrollment/claim', { code: approved.code }, newCopy().auth)).status, 409, 'another copy cannot use the code');
  const wrong = await json('POST', '/api/phone-enrollment/claim', { code: approved.code === 'ABC234' ? 'ABC235' : 'ABC234' }, copy.auth);
  assert.equal(wrong.status, 400); assert.match((await wrong.json()).error, /does not match/);
  const done = await (await json('POST', '/api/phone-enrollment/claim', { code: approved.code.slice(0, 3).toLowerCase() + ' ' + approved.code.slice(3) }, copy.auth)).json();
  assert.deepEqual(done, { state: 'pending', url: 'https://alex.closedhand.ai' }, 'typed with a space and in lower case still works');
  assert.equal((await json('POST', '/api/phone-enrollment/claim', { code: approved.code }, copy.auth)).status, 409, 'a code works once');
  // Somebody else asking for the same name is refused before any code.
  const otherTicket = await ask(newCopy(), 'alex');
  const taken = await json('POST', '/api/phone-enrollment/approve', { ticket: otherTicket }, signedIn(rival.cookie));
  assert.equal(taken.status, 409);
  assert.match((await taken.json()).error, /already taken/);
  // The Worker builds the route.
  assert.equal((await json('POST', '/api/phone-enrollment/jobs/lease', {}, { Authorization: 'Bearer wrong' })).status, 401);
  const { job } = await (await json('POST', '/api/phone-enrollment/jobs/lease', {}, worker)).json();
  assert.equal(job.hostname, 'alex.closedhand.ai'); assert.equal(job.port, 3000);
  const tunnelId = crypto.randomUUID(), dnsId = crypto.randomBytes(16).toString('hex'), token = tunnelToken(tunnelId);
  const wrongTunnel = await json('POST', '/api/phone-enrollment/jobs/checkpoint', { id: job.id, attempt: job.attempt, tunnelId, dnsId, token: tunnelToken(crypto.randomUUID()) }, worker);
  assert.equal(wrongTunnel.status, 400, 'a token for some other tunnel is refused');
  assert.deepEqual(await (await json('POST', '/api/phone-enrollment/jobs/checkpoint', { id: job.id, attempt: job.attempt, tunnelId, dnsId, token }, worker)).json(), { ok: true });
  const row = (await db.query('SELECT tunnel_token, state FROM addresses WHERE id = $1', [job.id])).rows[0];
  assert.equal(row.state, 'connecting'); assert.ok(row.tunnel_token.startsWith('enc:v1:')); assert.ok(!row.tunnel_token.includes(token));
  // The copy collects its connection, connects, and proves it answers there.
  assert.deepEqual(await (await fetch(base + '/api/phone-enrollment/connection', { headers: copy.auth })).json(), { state: 'connecting', url: 'https://alex.closedhand.ai', token });
  assert.deepEqual(await (await fetch(base + '/api/phone-enrollment/connection', { headers: newCopy().auth })).json(), { state: 'unconfirmed' }, 'the wrong secret learns nothing');
  challengeSecret = crypto.randomBytes(32).toString('hex');
  assert.equal((await json('POST', '/api/phone-enrollment/connected', {}, copy.auth)).status, 409, 'a wrong answer to the challenge does not activate');
  challengeSecret = copy.secret;
  assert.deepEqual(await (await json('POST', '/api/phone-enrollment/connected', {}, copy.auth)).json(), { state: 'active' });
  assert.equal((await account(owner.cookie)).url, 'https://alex.closedhand.ai');
  assert.equal((await account(rival.cookie)).url, null);
  assert.equal((await (await json('POST', '/api/phone-enrollment/details', { ticket }, { cookie: rival.cookie })).json()).state, 'unconfirmed', 'progress only for its owner');

  // Reinstalling: the owner moves alex to a new copy on another port.
  const fresh = newCopy(3100);
  const moveTicket = await ask(fresh, 'alex');
  assert.equal((await (await json('POST', '/api/phone-enrollment/details', { ticket: moveTicket }, { cookie: owner.cookie })).json()).move, true, 'the page says it is a move');
  const moving = await (await json('POST', '/api/phone-enrollment/approve', { ticket: moveTicket }, signedIn(owner.cookie))).json();
  assert.equal(moving.move, true);
  assert.equal((await account(owner.cookie)).url, 'https://alex.closedhand.ai', 'confirming alone moves nothing');
  assert.deepEqual(await (await json('POST', '/api/phone-enrollment/claim', { code: moving.code }, fresh.auth)).json(), { state: 'provisioning', url: 'https://alex.closedhand.ai' });
  assert.deepEqual(await (await fetch(base + '/api/phone-enrollment/connection', { headers: copy.auth })).json(), { state: 'unconfirmed' }, 'the old copy lost it');
  assert.deepEqual(await (await fetch(base + '/api/phone-enrollment/connection', { headers: fresh.auth })).json(), { state: 'provisioning' });
  // The Worker cuts the old computer off, then builds the route again, keeping its name.
  const cut = (await (await json('POST', '/api/phone-enrollment/jobs/lease', {}, worker)).json()).job;
  assert.equal(cut.id, job.id); assert.equal(cut.revoked, true); assert.equal(cut.tunnelId, tunnelId);
  assert.deepEqual(await (await json('POST', '/api/phone-enrollment/jobs/checkpoint', { id: cut.id, attempt: cut.attempt, revoked: true }, worker)).json(), { ok: true });
  const rebuilt = await build(tunnelId, dnsId);
  assert.equal(rebuilt.job.id, job.id); assert.equal(rebuilt.job.port, 3100); assert.equal(rebuilt.job.revoked, false);
  assert.equal((await (await fetch(base + '/api/phone-enrollment/connection', { headers: fresh.auth })).json()).token, rebuilt.token);
  challengeSecret = fresh.secret;
  assert.deepEqual(await (await json('POST', '/api/phone-enrollment/connected', {}, fresh.auth)).json(), { state: 'active' });
  assert.equal((await account(owner.cookie)).url, 'https://alex.closedhand.ai');
  // An owner cannot take a second name, even from a new copy.
  const second = await json('POST', '/api/phone-enrollment/approve', { ticket: await ask(newCopy(), 'alex-two') }, signedIn(owner.cookie));
  assert.equal(second.status, 409); assert.match((await second.json()).error, /already has a personal URL, alex\.closedhand\.ai/);
});

test('a confirmation link sent by somebody else cannot point your address at their computer', async () => {
  const victim = await signIn('google', google('g-target', 'target@example.com'));
  // The attacker's copy asks for a name and sends the victim the link.
  const attacker = newCopy();
  const approved = await (await json('POST', '/api/phone-enrollment/approve', { ticket: await ask(attacker, 'target') }, signedIn(victim.cookie))).json();
  assert.equal(approved.state, 'awaiting-code');
  // The victim types the code into their own ClosedHand: it does not finish the attacker's request.
  assert.equal((await json('POST', '/api/phone-enrollment/claim', { code: approved.code }, newCopy().auth)).status, 409);
  // The attacker guesses, many at once: only five tries ever count, then the code is gone.
  const guesses = Array.from({ length: 30 }, (_, i) => 'ZZZ' + String(200 + i).slice(-3).replace(/[01]/g, '2'));
  const answers = await Promise.all(guesses.filter(g => g !== approved.code).map(code => json('POST', '/api/phone-enrollment/claim', { code }, attacker.auth)));
  assert.equal(answers.filter(r => r.status === 400).length, 5, 'five tries counted');
  assert.equal((await json('POST', '/api/phone-enrollment/claim', { code: approved.code }, attacker.auth)).status, 409, 'even the right code is too late');
  assert.equal((await db.query("SELECT 1 FROM addresses WHERE hostname = 'target.closedhand.ai'")).rowCount, 0);
  // Knowing a copy's install ID is no longer a way to take its place: IDs are not identities.
  const id = crypto.randomUUID(), a = newCopy(), b = newCopy();
  a.auth = { Authorization: `Bearer ${id}.${a.secret}` }; b.auth = { Authorization: `Bearer ${id}.${b.secret}` };
  const first = await signIn('google', google('g-first', 'first@example.com'));
  const aCode = (await (await json('POST', '/api/phone-enrollment/approve', { ticket: await ask(a, 'first') }, signedIn(first.cookie))).json()).code;
  assert.equal((await (await json('POST', '/api/phone-enrollment/claim', { code: aCode }, a.auth)).json()).state, 'pending');
  const second = await signIn('google', google('g-second', 'second@example.com'));
  const bCode = (await (await json('POST', '/api/phone-enrollment/approve', { ticket: await ask(b, 'second') }, signedIn(second.cookie))).json()).code;
  assert.equal((await (await json('POST', '/api/phone-enrollment/claim', { code: bCode }, b.auth)).json()).state, 'pending', 'the same stated ID does not block another copy');
  assert.equal((await (await fetch(base + '/api/phone-enrollment/connection', { headers: b.auth })).json()).state, 'pending');
});

test('with EDGE_SECRET set, only requests through Cloudflare reach the site', async () => {
  const edge = createApp({ db, env: { ...env, EDGE_SECRET: 'e'.repeat(48) }, request }).app;
  const s = await new Promise(r => { const x = edge.listen(0, () => r(x)); });
  const at = 'http://127.0.0.1:' + s.address().port;
  try {
    assert.equal((await fetch(at + '/')).status, 403, 'straight to the origin');
    assert.equal((await fetch(at + '/', { headers: { 'X-ClosedHand-Edge': 'wrong' } })).status, 403);
    assert.equal((await fetch(at + '/', { headers: { 'X-ClosedHand-Edge': 'e'.repeat(48) } })).status, 200, 'through Cloudflare');
    assert.equal((await fetch(at + '/health')).status, 200, 'Railway health check');
    const lease = await fetch(at + '/api/phone-enrollment/jobs/lease', { method: 'POST', headers: { 'Content-Type': 'application/json', ...worker }, body: '{}' });
    assert.equal(lease.status, 200, 'the route-building Worker');
  } finally { s.close(); }
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
    assert.equal((await json('POST', '/api/phone-enrollment/register', { name, port: 3000, confirm: 'code' }, { Authorization: `Bearer ${id}.${sec}` })).status, 400, name);
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

// Newer copies ask for an address without a name; one is picked here.
const picked = /^https:\/\/[a-z]+-[a-z]+-\d{1,2}\.closedhand\.ai$/;
async function askPicked(copy) {
  const r = await json('POST', '/api/phone-enrollment/register', { port: copy.port, confirm: 'code' }, copy.auth);
  assert.equal(r.status, 200);
  return (await r.json()).ticket;
}
// Confirm, type the code, build the route and connect: a working address.
async function working(copy, owner, ticket) {
  const approved = await (await json('POST', '/api/phone-enrollment/approve', { ticket }, signedIn(owner.cookie))).json();
  const claimed = await (await json('POST', '/api/phone-enrollment/claim', { code: approved.code }, copy.auth)).json();
  await buildAll();
  challengeSecret = copy.secret;
  assert.deepEqual(await (await json('POST', '/api/phone-enrollment/connected', {}, copy.auth)).json(), { state: 'active' });
  return claimed.url;
}
// The Worker works through every waiting job, as its schedule does.
async function buildAll() {
  for (;;) {
    const { job } = await (await json('POST', '/api/phone-enrollment/jobs/lease', {}, worker)).json();
    if (!job) return;
    if (job.revoked) { await json('POST', '/api/phone-enrollment/jobs/checkpoint', { id: job.id, attempt: job.attempt, revoked: true }, worker); continue; }
    const tunnelId = job.tunnelId || crypto.randomUUID();
    await json('POST', '/api/phone-enrollment/jobs/checkpoint', { id: job.id, attempt: job.attempt, tunnelId, dnsId: job.dnsId || crypto.randomBytes(16).toString('hex'), token: tunnelToken(tunnelId) }, worker);
  }
}

test('a picked name: never from the account, free when confirmed, and an owner keeps the address they have', async () => {
  const copy = newCopy();
  const ticket = await askPicked(copy);
  const offered = (await (await json('POST', '/api/phone-enrollment/details', { ticket })).json()).url;
  assert.match(offered, picked);
  const owner = await signIn('google', google('g-picked', 'sam.jones@example.com'));
  // Somebody takes the offered name before the owner confirms: another free one is picked.
  const other = (await db.query("INSERT INTO owners (provider, subject, email) VALUES ('google', 'g-quick', 'q@example.com') RETURNING id")).rows[0].id;
  await db.query('INSERT INTO addresses (id, owner_id, secret_hash, hostname) VALUES ($1, $2, $3, $4)', [crypto.randomUUID(), other, 'c'.repeat(64), new URL(offered).hostname]);
  const approved = await (await json('POST', '/api/phone-enrollment/approve', { ticket }, signedIn(owner.cookie))).json();
  assert.equal(approved.state, 'awaiting-code');
  assert.match(approved.url, picked); assert.notEqual(approved.url, offered, 'a taken name is never handed out');
  assert.doesNotMatch(approved.url, /sam|jones/, 'nothing from the account name');
  assert.equal((await (await json('POST', '/api/phone-enrollment/details', { ticket }, { cookie: owner.cookie })).json()).url, approved.url, 'the page shows the name it will get');
  const claimed = await (await json('POST', '/api/phone-enrollment/claim', { code: approved.code }, copy.auth)).json();
  assert.deepEqual(claimed, { state: 'pending', url: approved.url });
  await buildAll();
  challengeSecret = copy.secret;
  await json('POST', '/api/phone-enrollment/connected', {}, copy.auth);
  // A reinstall asking without a name is offered the owner's own address, as a move.
  const fresh = newCopy(3200);
  const again = await askPicked(fresh);
  const shown = await (await json('POST', '/api/phone-enrollment/details', { ticket: again }, { cookie: owner.cookie })).json();
  assert.equal(shown.url, approved.url); assert.equal(shown.move, true);
  const moving = await (await json('POST', '/api/phone-enrollment/approve', { ticket: again }, signedIn(owner.cookie))).json();
  assert.equal(moving.url, approved.url); assert.equal(moving.move, true);
  // The attack from before still fails for picked names: the code finishes only the copy that asked.
  const attacker = newCopy();
  const lure = await (await json('POST', '/api/phone-enrollment/approve', { ticket: await askPicked(attacker) }, signedIn((await signIn('google', google('g-lured', 'l@example.com'))).cookie))).json();
  assert.equal((await json('POST', '/api/phone-enrollment/claim', { code: lure.code }, newCopy().auth)).status, 409);
});

test('renaming: tidied names, the old name redirects for thirty days then stays reserved, three a month', async () => {
  const copy = newCopy();
  const owner = await signIn('google', google('g-renamer', 'r@example.com'));
  const first = await working(copy, owner, await ask(copy, 'renamer'));
  assert.equal(first, 'https://renamer.closedhand.ai');
  const renameTo = (name, who = copy) => json('POST', '/api/phone-enrollment/rename', { name }, who.auth);
  assert.equal((await renameTo('Lucy', { auth: {} })).status, 401, 'no installation');
  assert.equal((await renameTo('lucy', newCopy())).status, 409, 'a copy without an address');
  for (const bad of ['ab', 'admin', '---', '99']) assert.equal((await renameTo(bad)).status, 400, bad);
  const done = await (await renameTo('  Lucy Smith! ')).json();
  assert.equal(done.url, 'https://lucy-smith.closedhand.ai', 'typed names are tidied');
  assert.equal(done.state, 'pending');
  assert.ok(Math.abs(Date.parse(done.redirectUntil) - Date.now() - 30 * 86400000) < 60000, 'thirty days of redirect');
  const row = (await db.query("SELECT state, dns_id, tunnel_token FROM addresses WHERE hostname = 'lucy-smith.closedhand.ai'")).rows[0];
  assert.deepEqual(row, { state: 'pending', dns_id: null, tunnel_token: null });
  assert.equal((await account(owner.cookie)).url, null, 'not advertised until it answers at the new name');
  // The Worker learns about the old name, and routes the new one to the same tunnel.
  const worker2 = worker;
  let moves = (await (await json('POST', '/api/phone-enrollment/jobs/moves', {}, worker2)).json()).moves;
  const announced = moves.find(m => m.hostname === 'renamer.closedhand.ai');
  assert.equal(announced.to, 'lucy-smith.closedhand.ai');
  assert.deepEqual(await (await json('POST', '/api/phone-enrollment/jobs/moves/done', { hostname: 'renamer.closedhand.ai', to: 'lucy-smith.closedhand.ai' }, worker2)).json(), { ok: true });
  moves = (await (await json('POST', '/api/phone-enrollment/jobs/moves', {}, worker2)).json()).moves;
  assert.ok(!moves.some(m => m.hostname === 'renamer.closedhand.ai'), 'announced once');
  const { job } = await (await json('POST', '/api/phone-enrollment/jobs/lease', {}, worker2)).json();
  assert.equal(job.hostname, 'lucy-smith.closedhand.ai'); assert.equal(job.dnsId, null); assert.ok(job.tunnelId, 'the same tunnel');
  const tunnelId = job.tunnelId, token = tunnelToken(tunnelId);
  await json('POST', '/api/phone-enrollment/jobs/checkpoint', { id: job.id, attempt: job.attempt, tunnelId, dnsId: crypto.randomBytes(16).toString('hex'), token }, worker2);
  challengeSecret = copy.secret;
  assert.deepEqual(await (await json('POST', '/api/phone-enrollment/connected', {}, copy.auth)).json(), { state: 'active' });
  assert.equal((await account(owner.cookie)).url, 'https://lucy-smith.closedhand.ai');
  // Nobody else can take the old name, by asking for it or by renaming to it.
  const rival = await signIn('google', google('g-rival2', 'rv@example.com'));
  const taken = await json('POST', '/api/phone-enrollment/approve', { ticket: await ask(newCopy(), 'renamer') }, signedIn(rival.cookie));
  assert.equal(taken.status, 409);
  const rivalCopy = newCopy();
  await working(rivalCopy, rival, await ask(rivalCopy, 'rival-two'));
  assert.equal((await renameTo('renamer', rivalCopy)).status, 409, 'an old name is reserved to its owner');
  assert.equal((await renameTo('lucy-smith', rivalCopy)).status, 409, 'a name in use is taken');
  for (let i = 0; i < 20; i++) assert.notEqual(await freeNameOf(), 'renamer.closedhand.ai');
  // A second rename sends the first old name to the newest.
  const second = await (await renameTo('lucy')).json();
  assert.equal(second.url, 'https://lucy.closedhand.ai');
  const chain = (await db.query("SELECT hostname, redirect_to, announced FROM retired_names WHERE owner_id = (SELECT owner_id FROM addresses WHERE hostname = 'lucy.closedhand.ai') ORDER BY created_at")).rows;
  assert.deepEqual(chain.map(r => [r.hostname, r.redirect_to, r.announced]), [['renamer.closedhand.ai', 'lucy.closedhand.ai', false], ['lucy-smith.closedhand.ai', 'lucy.closedhand.ai', false]]);
  // Coming back to your own old name is allowed; the Worker finds its route again by name.
  const back = await (await renameTo('renamer')).json();
  assert.equal(back.url, 'https://renamer.closedhand.ai');
  assert.equal((await db.query("SELECT dns_id FROM addresses WHERE hostname = 'renamer.closedhand.ai'")).rows[0].dns_id, null);
  assert.equal((await db.query("SELECT 1 FROM retired_names WHERE hostname = 'renamer.closedhand.ai'")).rowCount, 0);
  // Three old names held in thirty days is the most. Going back to one of
  // your own reuses its route, so it doesn't count.
  assert.equal((await renameTo('lucy-again')).status, 200);
  const capped = await renameTo('lucy-more');
  assert.equal(capped.status, 409); assert.match((await capped.json()).error, /three times in thirty days/);
  // The Worker is told when the redirect ends and when the moved page ends.
  const announcedMove = (await (await json('POST', '/api/phone-enrollment/jobs/moves', {}, worker2)).json()).moves.find(m => m.hostname === 'lucy-smith.closedhand.ai');
  assert.ok(Date.parse(announcedMove.release) > Date.parse(announcedMove.until), 'the moved page follows the redirect');
  const months = (Date.parse(announcedMove.release) - Date.now()) / 86400000;
  assert.ok(months > 180 && months < 185, 'released six months after the rename');
  // After thirty days the Worker removes the old route; the name stays reserved.
  await db.query("UPDATE retired_names SET redirect_until = now() - interval '1 minute' WHERE hostname = 'lucy-smith.closedhand.ai'");
  moves = (await (await json('POST', '/api/phone-enrollment/jobs/moves', {}, worker2)).json()).moves;
  assert.ok(moves.some(m => m.hostname === 'lucy-smith.closedhand.ai' && m.remove), 'due for removal');
  await json('POST', '/api/phone-enrollment/jobs/moves/done', { hostname: 'lucy-smith.closedhand.ai', removed: true }, worker2);
  moves = (await (await json('POST', '/api/phone-enrollment/jobs/moves', {}, worker2)).json()).moves;
  assert.ok(!moves.some(m => m.hostname === 'lucy-smith.closedhand.ai' && m.remove), 'removed once');
  assert.equal((await renameTo('lucy-smith', rivalCopy)).status, 409, 'still reserved after the redirect ends');
  // Six months on it is released: the Worker forgets it, then so does the
  // service, and anyone can take it, with nothing linking it to its old owner.
  await db.query("UPDATE retired_names SET release_at = now() - interval '1 minute' WHERE hostname = 'lucy-smith.closedhand.ai'");
  assert.equal((await renameTo('lucy-smith', rivalCopy)).status, 409, 'still taken until the Worker has let it go');
  moves = (await (await json('POST', '/api/phone-enrollment/jobs/moves', {}, worker2)).json()).moves;
  const due = moves.find(m => m.hostname === 'lucy-smith.closedhand.ai');
  assert.deepEqual(due, { hostname: 'lucy-smith.closedhand.ai', dnsId: null, release: true }, 'its route is already gone');
  assert.deepEqual(await (await json('POST', '/api/phone-enrollment/jobs/moves/done', { hostname: 'lucy-smith.closedhand.ai', released: true }, worker2)).json(), { ok: true });
  assert.equal((await db.query("SELECT 1 FROM retired_names WHERE hostname = 'lucy-smith.closedhand.ai'")).rowCount, 0, 'no trace of the old owner');
  assert.equal((await renameTo('lucy-smith', rivalCopy)).status, 200, 'free for anyone');
  assert.equal((await json('POST', '/api/phone-enrollment/jobs/moves', {}, { Authorization: 'Bearer wrong' })).status, 401);
});

test('the operator is emailed once when personal URL DNS records pass 150, and again only after it drops back', async () => {
  const report = async n => (await json('POST', '/api/phone-enrollment/jobs/usage', { dnsRecords: n }, worker)).json();
  mails.length = 0;
  assert.equal((await json('POST', '/api/phone-enrollment/jobs/usage', { dnsRecords: 151 }, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await json('POST', '/api/phone-enrollment/jobs/usage', { dnsRecords: -1 }, worker)).status, 400);
  assert.deepEqual(await report(140), { over: false, alerted: false });
  assert.equal(mails.length, 0);
  assert.deepEqual(await report(151), { over: true, alerted: true });
  assert.equal(mails.length, 1);
  assert.deepEqual(mails[0].Destination, { ToAddresses: ['operator@example.com'] });
  assert.match(mails[0].Content.Simple.Subject.Data, /passed 150/);
  assert.match(mails[0].Content.Simple.Body.Text.Data, /151 DNS records/);
  assert.deepEqual(await report(160), { over: true, alerted: false }, 'once per crossing');
  assert.deepEqual(await report(150), { over: false, alerted: false });
  assert.deepEqual(await report(152), { over: true, alerted: true }, 'again after it drops back');
  assert.equal(mails.length, 2);
});
const freeNameOf = () => require('../lib/addresses').freeName(db);

test('deleting a ClosedHand account from its computer: the sign-in is forgotten, the route comes down, the names are held for nobody', async () => {
  const copy = newCopy();
  const owner = await signIn('google', google('g-deleter', 'deleter@example.com'));
  await working(copy, owner, await ask(copy, 'keeper'));
  // An old name too, still redirecting.
  assert.equal((await json('POST', '/api/phone-enrollment/rename', { name: 'keeper-new' }, copy.auth)).status, 200);
  await buildAll();
  // The computer sees which sign-in its account is; nobody else does.
  assert.deepEqual(await (await fetch(base + '/api/phone-enrollment/account', { headers: copy.auth })).json(),
    { account: { provider: 'google', email: 'deleter@example.com', url: 'https://keeper-new.closedhand.ai' } });
  assert.deepEqual(await (await fetch(base + '/api/phone-enrollment/account', { headers: newCopy().auth })).json(), { account: null });
  assert.equal((await json('POST', '/api/phone-enrollment/account/delete', {})).status, 401, 'no installation');
  assert.deepEqual(await (await json('POST', '/api/phone-enrollment/account/delete', {}, newCopy().auth)).json(), { deleted: false }, 'nothing linked to that computer');
  const addressId = (await db.query("SELECT id FROM addresses WHERE hostname = 'keeper-new.closedhand.ai'")).rows[0].id;
  assert.deepEqual(await (await json('POST', '/api/phone-enrollment/account/delete', {}, copy.auth)).json(), { deleted: true });
  // The sign-in is forgotten at once, and signing in again finds nothing.
  assert.equal((await db.query("SELECT 1 FROM owners WHERE subject = 'g-deleter'")).rowCount, 0);
  assert.equal((await account(owner.cookie)).signedIn, false);
  assert.deepEqual(await (await fetch(base + '/api/phone-enrollment/connection', { headers: copy.auth })).json(), { state: 'unconfirmed' });
  // The Worker takes the route down completely, then the address is gone.
  const { job } = await (await json('POST', '/api/phone-enrollment/jobs/lease', {}, worker)).json();
  assert.equal(job.id, addressId); assert.equal(job.revoked, true); assert.equal(job.teardown, true);
  assert.deepEqual(await (await json('POST', '/api/phone-enrollment/jobs/checkpoint', { id: job.id, attempt: job.attempt, revoked: true }, worker)).json(), { ok: true });
  assert.equal((await db.query('SELECT 1 FROM addresses WHERE id = $1', [addressId])).rowCount, 0);
  // The old name stops redirecting: the Worker releases it.
  const moves = (await (await json('POST', '/api/phone-enrollment/jobs/moves', {}, worker)).json()).moves;
  assert.ok(moves.some(m => m.hostname === 'keeper.closedhand.ai' && m.release === true));
  assert.deepEqual(await (await json('POST', '/api/phone-enrollment/jobs/moves/done', { hostname: 'keeper.closedhand.ai', released: true }, worker)).json(), { ok: true });
  // Both names are held, linked to nobody.
  const held = (await db.query("SELECT hostname, owner_id, release_at FROM held_names WHERE hostname LIKE 'keeper%' ORDER BY hostname")).rows;
  assert.deepEqual(held.map(h => [h.hostname, h.owner_id]).sort(), [['keeper-new.closedhand.ai', null], ['keeper.closedhand.ai', null]]);
  assert.ok(held.every(h => h.release_at - Date.now() > 150 * 86400000), 'about six months');
  const other = await signIn('google', google('g-after', 'after@example.com'));
  const grab = await json('POST', '/api/phone-enrollment/approve', { ticket: await ask(newCopy(), 'keeper-new') }, signedIn(other.cookie));
  assert.equal(grab.status, 409, 'a held name is taken for everyone');
  // The computer can start again straight away.
  assert.match(await working(copy, other, await askPicked(copy)), picked);
});

test('deleting a ClosedHand account on closedhand.com: signed in, from the site itself, then signed out', async () => {
  const copy = newCopy();
  const owner = await signIn('microsoft', microsoft('9188040d-6c67-4c5b-b112-36a304b66dad', '00000000-0000-0000-aaaa-0000000000d1', 'web@example.com'));
  const url = await working(copy, owner, await askPicked(copy));
  const before = await account(owner.cookie);
  assert.equal(before.address, new URL(url).hostname, 'the account page can show the address');
  assert.equal((await json('POST', '/api/account/delete', {})).status, 401);
  assert.equal((await json('POST', '/api/account/delete', {}, { cookie: owner.cookie, Origin: 'https://evil.example' })).status, 403);
  const gone = await json('POST', '/api/account/delete', {}, signedIn(owner.cookie));
  assert.deepEqual(await gone.json(), { deleted: true });
  assert.ok((gone.headers.getSetCookie?.() || []).some(c => /Max-Age=0/i.test(c)), 'signed out');
  assert.deepEqual(await account(owner.cookie), { signedIn: false, provider: null, email: null, url: null, address: null, available: true });
  assert.deepEqual(await (await fetch(base + '/api/phone-enrollment/connection', { headers: copy.auth })).json(), { state: 'unconfirmed' }, 'the computer finds out when it next asks');
  const held = (await db.query('SELECT owner_id FROM held_names WHERE hostname = $1', [new URL(url).hostname])).rows[0];
  assert.deepEqual(held, { owner_id: null });
  await buildAll();
  assert.equal((await db.query('SELECT 1 FROM addresses WHERE hostname = $1', [new URL(url).hostname])).rowCount, 0);
});

test('an address unused for ninety days is let go only on a current report, and its owner gets the name back', async () => {
  const copy = newCopy();
  const owner = await signIn('google', google('g-idle', 'idle@example.com'));
  await working(copy, owner, await ask(copy, 'idler'));
  await db.query("UPDATE addresses SET last_seen_at = now() - interval '91 days' WHERE hostname = 'idler.closedhand.ai'");
  const idleRow = async () => (await db.query("SELECT owner_id, state FROM addresses WHERE hostname = 'idler.closedhand.ai'")).rows[0];
  // With no report yet, or one that covers too little, nothing is let go.
  await buildAll();
  assert.equal((await idleRow()).state, 'active');
  const thin = await (await json('POST', '/api/phone-enrollment/jobs/seen', { tunnels: [] }, worker)).json();
  assert.equal(thin.matched, 0); assert.ok(thin.working > 1);
  await buildAll();
  assert.equal((await idleRow()).state, 'active', 'a report covering too little never lets anything go');
  // A full report: everything else was seen just now, this one long ago.
  const working_ = (await db.query("SELECT id, tunnel_id, hostname FROM addresses WHERE activated_at IS NOT NULL AND tunnel_id IS NOT NULL AND state <> 'revoked'")).rows;
  const tunnels = working_.map(r => ({ address: r.id, tunnel: r.tunnel_id, seen: r.hostname === 'idler.closedhand.ai' ? new Date(Date.now() - 91 * 86400000).toISOString() : new Date(Date.now() + 86400000).toISOString() }));
  const full = await (await json('POST', '/api/phone-enrollment/jobs/seen', { tunnels: [...tunnels, { address: crypto.randomUUID(), tunnel: crypto.randomUUID(), seen: new Date().toISOString() }] }, worker)).json();
  assert.equal(full.matched, working_.length);
  assert.ok((await db.query("SELECT last_seen_at FROM addresses WHERE hostname <> 'idler.closedhand.ai' AND activated_at IS NOT NULL AND last_seen_at > now() + interval '1 minute'")).rowCount === 0, 'never later than now');
  await buildAll();
  assert.equal(await idleRow(), undefined, 'let go and taken down');
  assert.equal((await db.query("SELECT 1 FROM addresses WHERE activated_at IS NOT NULL AND tunnel_id IS NOT NULL AND state <> 'revoked'")).rowCount, working_.length - 1, 'every other address stays');
  // The owner stays, with the name held for them alone.
  assert.equal((await account(owner.cookie)).signedIn, true);
  const rival = await signIn('google', google('g-idle-rival', 'rival2@example.com'));
  assert.equal((await json('POST', '/api/phone-enrollment/approve', { ticket: await ask(newCopy(), 'idler') }, signedIn(rival.cookie))).status, 409);
  // Setting up again gives it back, even when a name is picked.
  const again = newCopy();
  assert.equal(await working(again, owner, await askPicked(again)), 'https://idler.closedhand.ai');
  assert.equal((await db.query("SELECT 1 FROM held_names WHERE hostname = 'idler.closedhand.ai'")).rowCount, 0);
});

test('a sign-in holding nothing is forgotten after a day; one with a held name is kept', async () => {
  const lookup = await signIn('google', google('g-lookup', 'lookup@example.com'));
  assert.equal((await account(lookup.cookie)).signedIn, true);
  const holder = await signIn('google', google('g-holder', 'holder@example.com'));
  const holderId = (await db.query("SELECT id FROM owners WHERE subject = 'g-holder'")).rows[0].id;
  await db.query("INSERT INTO held_names (hostname, owner_id, release_at) VALUES ('held-for-me.closedhand.ai', $1, now() + interval '1 month')", [holderId]);
  await db.query("INSERT INTO held_names (hostname, owner_id, release_at) VALUES ('held-over.closedhand.ai', NULL, now() - interval '1 minute')");
  await db.query("UPDATE owners SET updated_at = now() - interval '2 days' WHERE subject IN ('g-lookup', 'g-holder')");
  await buildAll();
  assert.equal((await account(lookup.cookie)).signedIn, false, 'nothing to hold, so no account');
  assert.equal((await account(holder.cookie)).signedIn, true);
  assert.equal((await db.query("SELECT 1 FROM held_names WHERE hostname = 'held-over.closedhand.ai'")).rowCount, 0, 'a hold ends on time');
});

test('connecting Microsoft mail through ClosedHand\'s app claims the personal URL in one step, and only a genuine sign-in does', async () => {
  const DEVICE_APP = '4f57d28c-dabb-4369-9874-f7c72262859b';
  const { app } = createApp({ db, env: { ...env, MICROSOFT_ASSOCIATED_APP_IDS: '526c0b07-ae5c-46a2-9911-f7220b9f96d0,' + DEVICE_APP, MICROSOFT_CLIENT_ID: '526c0b07-ae5c-46a2-9911-f7220b9f96d0' }, request });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const at = 'http://127.0.0.1:' + srv.address().port;
  const post = (body, headers) => fetch(at + '/api/phone-enrollment/claim-microsoft', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    const tid = '0d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d', oid = '11111111-2222-4333-8444-555555555555';
    const claims = (over = {}) => ({ iss: `https://login.microsoftonline.com/${tid}/v2.0`, aud: DEVICE_APP, tid, oid, email: 'sam@contoso.example', name: 'Sam',
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...over });
    const copy = newCopy();
    assert.equal((await post({ idToken: signedToken(claims()), port: 3000 })).status, 401, 'no copy');
    const forged = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    for (const [why, token] of [['forged', signedToken(claims(), forged)], ['another app', signedToken(claims({ aud: '526c0b07-ae5c-46a2-9911-f7220b9f96d0' }))],
      ['expired', signedToken(claims({ exp: Math.floor(Date.now() / 1000) - 3600 }))], ['unsigned', 'x.' + Buffer.from(JSON.stringify(claims())).toString('base64url') + '.y'],
      ['wrong issuer', signedToken(claims({ iss: 'https://login.microsoftonline.com/other/v2.0' }))]]) {
      const r = await post({ idToken: token, port: 3000 }, copy.auth);
      assert.equal(r.status, 400, why); assert.match((await r.json()).error, /could not be checked/, why);
    }
    assert.equal((await db.query('SELECT 1 FROM addresses WHERE secret_hash = $1', [copy.hash])).rowCount, 0, 'nothing reserved by a bad sign-in');
    const done = await (await post({ idToken: signedToken(claims()), port: 3000 }, copy.auth)).json();
    assert.equal(done.state, 'pending'); assert.match(done.url, /^https:\/\/[a-z]+-[a-z]+-\d+\.closedhand\.ai$/, 'a picked name');
    assert.deepEqual(await (await post({ idToken: signedToken(claims()), port: 3000 }, copy.auth)).json(), done, 'asking again changes nothing');
    // The same Microsoft account signing in on closedhand.com is the same ClosedHand account.
    const web = await signIn('microsoft', microsoft(tid, oid, 'sam@contoso.example'));
    const seen = await account(web.cookie);
    assert.equal(seen.signedIn, true); assert.equal(seen.address, new URL(done.url).hostname, 'the same account, holding the same address');
    // An address in use on one computer is never moved by another's sign-in.
    const other = newCopy();
    assert.deepEqual(await (await post({ idToken: signedToken(claims()), port: 3000 }, other.auth)).json(), { state: 'unconfirmed', claimHere: true });
    assert.equal((await db.query('SELECT secret_hash FROM addresses WHERE hostname = $1', [new URL(done.url).hostname])).rows[0].secret_hash, copy.hash);
    // A computer already holding someone else's address is sent to the confirmation page too.
    const stranger = signedToken(claims({ oid: '99999999-2222-4333-8444-555555555555', email: 'lee@contoso.example' }));
    assert.deepEqual(await (await post({ idToken: stranger, port: 3000 }, copy.auth)).json(), { state: 'unconfirmed', claimHere: true });
  } finally { srv.close(); }
});

test('a sign-in straight on from connecting mail names that account, so the provider skips its picker', async () => {
  for (const provider of ['google', 'microsoft']) {
    const named = new URL((await fetch(base + `/auth/${provider}?return_to=%2Fopen&login_hint=sam%40example.com`, { redirect: 'manual' })).headers.get('location'));
    assert.equal(named.searchParams.get('login_hint'), 'sam@example.com');
    assert.equal(named.searchParams.get('prompt'), null, 'no picker when the account is named');
    for (const junk of ['not-an-email', 'a@b c', 'x'.repeat(320) + '@e.com', '<a>@b.c']) {
      const plain = new URL((await fetch(base + `/auth/${provider}?return_to=%2Fopen&login_hint=` + encodeURIComponent(junk), { redirect: 'manual' })).headers.get('location'));
      assert.equal(plain.searchParams.get('login_hint'), null, junk);
      assert.equal(plain.searchParams.get('prompt'), 'select_account');
    }
  }
});
