// The closedhand.com service's rules that need no database or packages.
// Its end-to-end test (closedhand-com/test/e2e.js) runs against Postgres in CI.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY || crypto.randomBytes(32).toString('base64');
const session = require('../closedhand-com/lib/session');
const { PROVIDERS } = require('../closedhand-com/lib/signin');
const addresses = require('../closedhand-com/lib/addresses');
const bugs = require('../closedhand-com/lib/bugs');
const navigation = require('../closedhand-com/public/entry-navigation');

test('signed cookies refuse tampering, expiry and the wrong purpose', () => {
  const secret = 's'.repeat(40), sealed = session.seal(secret, 'session', { owner: 'x', exp: Date.now() + 1000 });
  assert.equal(session.open(secret, 'session', sealed).owner, 'x');
  assert.equal(session.open(secret, 'signin', sealed), null);
  assert.equal(session.open('t'.repeat(40), 'session', sealed), null);
  assert.equal(session.open(secret, 'session', sealed.slice(0, -2) + 'AA'), null);
  assert.equal(session.open(secret, 'session', session.seal(secret, 'session', { owner: 'x', exp: Date.now() - 1 })), null);
  assert.throws(() => session.createSessions({ secret: 'short' }), /at least 32/);
});

test('Google and Microsoft identities come from their permanent IDs, never the email', () => {
  const g = PROVIDERS.google.identity({ iss: 'https://accounts.google.com', aud: 'c', sub: '123', email: 'a@b.c', email_verified: true }, 'c');
  assert.deepEqual([g.provider, g.subject, g.emailVerified], ['google', '123', true]);
  assert.equal(PROVIDERS.google.identity({ iss: 'https://evil.example', aud: 'c', sub: '1' }, 'c'), null);
  assert.equal(PROVIDERS.google.identity({ iss: 'accounts.google.com', aud: 'other', sub: '1' }, 'c'), null);
  const tid = '11111111-2222-4333-8444-555555555555', oid = '66666666-7777-4888-9999-000000000000';
  const m = PROVIDERS.microsoft.identity({ iss: `https://login.microsoftonline.com/${tid}/v2.0`, aud: 'c', tid, oid, email: 'victim@gmail.com' }, 'c');
  assert.equal(m.subject, tid + ':' + oid);
  assert.equal(m.emailVerified, false, 'a Microsoft email is never treated as proof');
  assert.equal(PROVIDERS.microsoft.identity({ iss: 'https://login.microsoftonline.com/99999999-2222-4333-8444-555555555555/v2.0', aud: 'c', tid, oid }, 'c'), null, 'issuer must match the directory');
  assert.equal(PROVIDERS.microsoft.identity({ iss: `https://login.microsoftonline.com/${tid}/v2.0`, aud: 'c', tid }, 'c'), null, 'no ID, no owner');
  assert.equal(PROVIDERS.microsoft.scope, 'openid profile email');
  assert.equal(PROVIDERS.google.scope, 'openid email profile');
});

test('personal URL tickets carry one request, signed, for thirty minutes', () => {
  const secret = 'k'.repeat(40), request = { secret_hash: 'a'.repeat(64), hostname: 'alex.closedhand.ai', port: 3000 };
  const ticket = addresses.ticketFor(request, secret);
  assert.equal(addresses.readTicket(ticket, secret).hostname, 'alex.closedhand.ai');
  assert.equal(addresses.readTicket(ticket, 'other'.repeat(8)), null);
  assert.equal(addresses.readTicket(addresses.ticketFor({ ...request, hostname: 'admin.closedhand.ai' }, secret), secret), null, 'reserved names');
  assert.ok(addresses.readTicket(addresses.ticketFor(request, secret, Date.now() - 31 * 60000), secret).expires < Date.now(), 'expiry is visible to the caller');
  assert.equal(addresses.validHostname('a.closedhand.ai'), false);
  assert.equal(addresses.validHostname('alex.closedhand.ai.evil.com'), false);
  // A copy is known by its secret; the ID it states is not part of who it is.
  const copy = addresses.installation({ headers: { authorization: 'Bearer ' + crypto.randomUUID() + '.' + 'b'.repeat(64) } });
  assert.equal(copy.secret_hash, crypto.createHash('sha256').update('b'.repeat(64)).digest('hex'));
  assert.equal(copy.id, undefined);
  // Tickets from before confirmation codes are not accepted.
  const old = Buffer.from(JSON.stringify({ ...request, id: crypto.randomUUID(), version: 2, expires: Date.now() + 60000 })).toString('base64url');
  assert.equal(addresses.readTicket(old + '.' + crypto.createHmac('sha256', secret).update('phone-pair:' + old).digest('hex'), secret), null);
});

test('bug receipts and sign-in return paths stay narrow', () => {
  const key = 'c'.repeat(64);
  assert.equal(bugs.submissionId(key), bugs.submissionId(key));
  const id = bugs.submissionId(key), receipt = bugs.receiptFor(id, 'secret');
  assert.ok(bugs.validReceipt(id, receipt, 'secret'));
  assert.equal(bugs.validReceipt(id, receipt, 'other'), false);
  assert.equal(navigation.signInReturn('/phone-access/pair#t'), '/phone-access/pair#t');
  assert.equal(navigation.signInReturn('https://evil.example/open'), '/open');
  assert.equal(navigation.signInReturn('//evil.example/open'), '/open');
  assert.equal(navigation.signInReturn('/assistant-email/confirm'), '/open');
});

test('the service keeps only the retired flow out and the relay switched off', () => {
  const server = fs.readFileSync(path.join(__dirname, '../closedhand-com/server.js'), 'utf8');
  assert.doesNotMatch(server, /phone-links/);
  assert.match(server, /assistant-mail-relay\/availability'.*available: false/);
  const migration = fs.readFileSync(path.join(__dirname, '../closedhand-com/migrations/001_initial.sql'), 'utf8');
  assert.match(migration, /CREATE UNIQUE INDEX owners_identity ON owners \(provider, subject\)/);
  assert.doesNotMatch(migration, /profiles/);
});
