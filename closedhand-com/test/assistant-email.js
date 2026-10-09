// The assistant email relay against a real Postgres: pairing a copy of
// Closedhand to its owner, who mail may go to, the allowances, and the
// worker's handling of incoming mail. Google and Amazon are stand-ins;
// nothing leaves this machine.
// Run: DATABASE_URL=postgres://... node --test closedhand-com/test/assistant-email.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
const { connect, migrate } = require('../lib/db');
const { createApp } = require('../server');
const p = require('../lib/assistant-email-protocol');
const worker = require('../lib/assistant-mail-worker');

const env = {
  BASE_URL: 'https://closedhand.com', SESSION_SECRET: crypto.randomBytes(32).toString('hex'), TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY,
  GOOGLE_CLIENT_ID: 'google-client', GOOGLE_CLIENT_SECRET: 'g-secret', MICROSOFT_CLIENT_ID: 'ms-client', MICROSOFT_CLIENT_SECRET: 'm-secret',
  ASSISTANT_EMAIL_ENABLED: '1', ASSISTANT_EMAIL_RELEASED: '1', ASSISTANT_EMAIL_PRODUCTION: '1',
};
const idToken = claims => 'x.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.y';
let db, mailDb, server, base, nextClaims = null, workerRunning = true;
const request = async (url, opts) => {
  if (url.includes('oauth2.googleapis.com/token') || url.includes('login.microsoftonline.com')) {
    const nonce = new URLSearchParams(opts.body).get('code');
    return new Response(JSON.stringify({ id_token: idToken({ ...nextClaims, nonce }) }));
  }
  throw new Error('unexpected request ' + url);
};

before(async () => {
  db = connect();
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate(db);
  mailDb = require('../lib/db-driver-pg').createPgClient({ pool: db });
  const { app } = createApp({ db, env, request, startMailWorker: () => workerRunning && (() => {}) });
  await new Promise(r => { server = app.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
});
after(async () => { server?.close(); await db?.end(); });

const cookieFrom = res => (res.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).filter(c => !c.endsWith('=')).join('; ');
async function signIn(provider, claims) {
  const start = await fetch(base + '/auth/' + provider + '?return_to=' + encodeURIComponent('/assistant-email/confirm#t'), { redirect: 'manual' });
  const to = new URL(start.headers.get('location'));
  nextClaims = claims;
  const back = await fetch(base + `/auth/${provider}/callback?code=${to.searchParams.get('nonce')}&state=${to.searchParams.get('state')}`, { redirect: 'manual', headers: { cookie: cookieFrom(start) } });
  return { location: back.headers.get('location'), cookie: cookieFrom(back) };
}
const google = (sub, email, verified = true) => ({ iss: 'https://accounts.google.com', aud: 'google-client', sub, email, email_verified: verified, exp: Date.now() / 1000 + 600 });
const microsoft = (tid, oid, email) => ({ iss: `https://login.microsoftonline.com/${tid}/v2.0`, aud: 'ms-client', tid, oid, email, preferred_username: email, exp: Date.now() / 1000 + 600 });
const call = (method, path, body, headers = {}) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) });

// A copy of Closedhand: its install ID, the secret only it holds, and the key
// its incoming mail is sealed to.
function copy() {
  const id = crypto.randomUUID(), secret = crypto.randomBytes(32).toString('hex'), keys = p.keyPair();
  return { id, keys, auth: { Authorization: `Bearer ${id}.${secret}` } };
}
async function pair(c, cookie, name = 'Pete') {
  const registered = await (await call('POST', '/api/assistant-mail-relay/register', { publicKey: c.keys.publicKey, name }, c.auth)).json();
  assert.match(registered.url, /^https:\/\/closedhand\.com\/assistant-email\/confirm#/);
  const ticket = registered.url.split('#')[1];
  return call('POST', '/api/assistant-mail-relay/approve', { ticket }, { cookie, Origin: 'https://closedhand.com' });
}

test('the relay says it is available only when switched on and its worker is running', async () => {
  assert.deepEqual(await (await call('GET', '/api/assistant-mail-relay/availability')).json(), { available: true });
  workerRunning = false;
  const { app } = createApp({ db, env, request, startMailWorker: () => null });
  const quiet = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const answer = await (await fetch('http://127.0.0.1:' + quiet.address().port + '/api/assistant-mail-relay/availability')).json();
  quiet.close(); workerRunning = true;
  assert.deepEqual(answer, { available: false }, 'a worker that did not start means no mail would move');
  assert.equal((await fetch(base + '/assistant-email/confirm')).status, 200);
});

test('a copy is paired to the owner who signs in, only with an address the provider vouches for', async () => {
  const sam = await signIn('google', google('g-sam', 'sam@example.com'));
  assert.equal(sam.location, '/assistant-email/confirm#t', 'sign-in comes back to the confirmation with its ticket');
  const c = copy();
  const paired = await (await pair(c, sam.cookie)).json();
  assert.match(paired.address, /^pete-[a-f0-9]{8}@assist\.closedhand\.ai$/);
  assert.equal(paired.email, 'sam@example.com');
  const status = await (await call('GET', '/api/assistant-mail-relay/status', null, c.auth)).json();
  assert.equal(status.address, paired.address);
  assert.equal(status.enabled, true);

  const unverified = await signIn('google', google('g-ann', 'ann@example.com', false));
  assert.equal((await pair(copy(), unverified.cookie)).status, 400, 'Google has not verified this address');
  const work = await signIn('microsoft', microsoft(crypto.randomUUID(), crypto.randomUUID(), 'ceo@bigco.example'));
  assert.equal((await pair(copy(), work.cookie)).status, 400, "a work account's address is whatever its organisation typed in");
  const personal = await signIn('microsoft', microsoft('9188040d-6c67-4c5b-b112-36a304b66dad', crypto.randomUUID(), 'kim@outlook.com'));
  assert.equal((await pair(copy(), personal.cookie)).status, 200, "a personal Microsoft account's address is its sign-in");

  const elsewhere = await call('POST', '/api/assistant-mail-relay/approve', { ticket: 'x' }, { cookie: sam.cookie, Origin: 'https://evil.example' });
  assert.equal(elsewhere.status, 403);
  assert.equal((await call('GET', '/api/assistant-mail-relay/status', null, { Authorization: `Bearer ${c.id}.${'0'.repeat(64)}` })).status, 401, 'the wrong secret is no copy at all');
});

test('a new email goes to the owner only; a reply only to someone who wrote first', async () => {
  const owner = await signIn('google', google('g-lee', 'lee@example.com'));
  const c = copy();
  const { address } = await (await pair(c, owner.cookie, 'Max')).json();
  const send = body => call('POST', '/api/assistant-mail-relay/outbox', { id: crypto.randomUUID(), subject: 'Oil monitor', text: 'Brent is up 2%.', displayName: 'Max', ...body }, c.auth);

  const toOwner = await send({ to: ['lee@example.com'] });
  assert.equal(toOwner.status, 200);
  assert.equal((await toOwner.json()).state, 'pending');
  assert.equal((await send({ to: ['stranger@example.com'] })).status, 403, 'nobody else can be reached with a new email');
  assert.equal((await send({ to: ['lee@example.com', 'stranger@example.com'] })).status, 403);

  // An authenticated email from a guest who wrote to the address directly
  // lets the assistant reply to that guest, and only to them.
  const event = { notificationType: 'Received', mail: { messageId: 'ses-1', timestamp: new Date().toISOString(), source: 'guest@example.com' },
    receipt: { recipients: [address], dmarcVerdict: { status: 'PASS' }, spamVerdict: { status: 'PASS' }, virusVerdict: { status: 'PASS' } } };
  const parsed = { from: { value: [{ address: 'guest@example.com' }] }, to: { value: [{ address }] }, subject: 'Lunch?', text: 'Free on Friday?', messageId: '<m1@example.com>', headers: new Map(), attachments: [] };
  await worker.receive(mailDb, event, Buffer.from('raw'), async () => parsed);
  const inbox = await (await call('GET', '/api/assistant-mail-relay/inbox', null, c.auth)).json();
  assert.equal(inbox.messages.length, 1);
  const letter = p.open(inbox.messages[0].sealed, c.keys.privateKey, c.id);
  assert.equal(letter.from, 'guest@example.com');
  assert.equal(letter.authenticated, true);
  assert.equal((await send({ to: ['guest@example.com'], replyToDelivery: inbox.messages[0].id })).status, 200);
  assert.equal((await send({ to: ['other@example.com'], replyToDelivery: inbox.messages[0].id })).status, 403);

  // Collected mail is acknowledged once, and a repeat delivery from Amazon
  // does not hand it over again.
  await call('POST', '/api/assistant-mail-relay/ack', { id: inbox.messages[0].id }, c.auth);
  await worker.receive(mailDb, event, Buffer.from('raw'), async () => parsed);
  assert.equal((await (await call('GET', '/api/assistant-mail-relay/inbox', null, c.auth)).json()).messages.length, 0);
});

test('allowances are counted per owner, and an owner may run three copies', async () => {
  const owner = await signIn('google', google('g-jo', 'jo@example.com'));
  for (let i = 0; i < 3; i++) assert.equal((await pair(copy(), owner.cookie)).status, 200);
  assert.equal((await pair(copy(), owner.cookie)).status, 409, 'a fourth copy waits until one is paused');
  const c = copy();
  const other = await signIn('google', google('g-al', 'al@example.com'));
  await pair(c, other.cookie);
  const status = await (await call('GET', '/api/assistant-mail-relay/status', null, c.auth)).json();
  assert.equal(status.usage.sentLimit, 1000);
  assert.equal(status.usage.dailySent, 0);
  const sent = await call('POST', '/api/assistant-mail-relay/outbox', { id: crypto.randomUUID(), to: ['al@example.com'], subject: 'Hi', text: 'Hello.' }, c.auth);
  assert.equal(sent.status, 200);
  assert.equal((await (await call('GET', '/api/assistant-mail-relay/status', null, c.auth)).json()).usage.dailySent, 1);
});
