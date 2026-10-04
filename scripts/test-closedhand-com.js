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
  assert.equal(PROVIDERS.microsoft.scope, 'openid profile email', 'profile carries the address of Microsoft accounts with no email claim');
  assert.equal(PROVIDERS.google.scope, 'openid email', 'Google is asked for the email only');
});

test('a ClosedHand account keeps only the email: no name from the sign-in, and no page says otherwise', () => {
  const tid = '11111111-2222-4333-8444-555555555555', oid = '66666666-7777-4888-9999-000000000000';
  const g = PROVIDERS.google.identity({ iss: 'https://accounts.google.com', aud: 'c', sub: '1', email: 'a@b.c', email_verified: true, name: 'Pat Example', picture: 'https://p' }, 'c');
  const m = PROVIDERS.microsoft.identity({ iss: `https://login.microsoftonline.com/${tid}/v2.0`, aud: 'c', tid, oid, email: 'a@b.c', name: 'Pat Example' }, 'c');
  for (const who of [g, m]) assert.ok(!JSON.stringify(who).includes('Pat Example') && !('picture' in who), 'only the ID and email leave the sign-in');
  const owners = fs.readFileSync(path.join(__dirname, '../closedhand-com/lib/owners.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(owners, /\bname\b\s*(=|,|\))/, 'owners.js never writes a name');
  const pages = ['closedhand-com/views', 'webapp/views'].flatMap(dir => fs.readdirSync(path.join(__dirname, '..', dir)).filter(f => f.endsWith('.html')).map(f => path.join(dir, f)));
  for (const page of [...pages, 'README.md']) {
    const text = fs.readFileSync(path.join(__dirname, '..', page), 'utf8');
    assert.doesNotMatch(text, /keeps\s+only\s+(its|that\s+account.s|that\s+sign-in.s)\s+name|name\s+and\s+e-?mail/i, page);
  }
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
  // The automatic claim's link survives the sign-in round trip whole.
  const auto = '/phone-access/pair#t=abc.def&state=' + 'a'.repeat(32) + '&back=http%3A%2F%2Flocalhost%3A3000%2Fsetup&via=google&hint=sam%40example.com&tried=1';
  assert.equal(navigation.signInReturn(auto), auto);
  assert.equal(navigation.signInReturn('https://evil.example/open'), '/open');
  assert.equal(navigation.signInReturn('//evil.example/open'), '/open');
  assert.equal(navigation.signInReturn('/assistant-email/confirm#ticket.sig'), '/assistant-email/confirm#ticket.sig', "the assistant email confirmation comes back with its ticket");
});

test("the confirmation page never presents the owner's own address as the assistant's", () => {
  const view = fs.readFileSync(path.join(__dirname, '../closedhand-com/views/assistant-email-confirm.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '../closedhand-com/public/assistant-email-confirm.js'), 'utf8');
  assert.match(view, /<p class="address" id="address" hidden><\/p>\s*<p class="address-note" id="address-note" hidden>/, 'the assistant address appears only once it exists');
  assert.match(view, /<p class="fine" id="who-label">Your assistant’s private replies go to<\/p>\s*<div class="who">/, 'the signed-in account is labelled as where replies go');
  assert.match(view, />Create your assistant’s email address<\/button>/);
  assert.match(script, /\$\('approve'\)\.textContent = 'Create ' \+ whose \+ ' email address';/);
  assert.match(script, /if \(!account\.signedIn \|\| !account\.emailVerified\) \{/, 'an older or unverified sign-in is asked to sign in again before confirming');
});

test('the service keeps the retired flow out and runs the real assistant email relay', () => {
  const server = fs.readFileSync(path.join(__dirname, '../closedhand-com/server.js'), 'utf8');
  assert.doesNotMatch(server, /phone-links/);
  assert.doesNotMatch(server, /available: false/, "the relay is the real one, not a placeholder");
  assert.match(server, /require\('\.\/lib\/assistant-mail-relay'\)\.createRelay\(\{ db: mailDb, owner: req => sessions\.owner\(req\), secret, env, baseUrl, ready: \(\) => !!mailWorker \}\)\.register\(app\);/);
  const migration = fs.readFileSync(path.join(__dirname, '../closedhand-com/migrations/001_initial.sql'), 'utf8');
  assert.match(migration, /CREATE UNIQUE INDEX owners_identity ON owners \(provider, subject\)/);
  assert.doesNotMatch(migration, /profiles/);
});

test('picked names are two ordinary words and a number, always a valid, unreserved address', () => {
  const { randomName, FIRST, SECOND } = require('../closedhand-com/lib/names');
  const { validHostname } = require('../closedhand-com/lib/addresses');
  // Every possible pairing, at the shortest and longest number.
  for (const a of FIRST) for (const b of SECOND) for (const n of [2, 99]) assert.ok(validHostname(`${a}-${b}-${n}.closedhand.ai`), `${a}-${b}-${n}`);
  for (let i = 0; i < 200; i++) assert.match(randomName(), /^[a-z]+-[a-z]+-([2-9]|[1-9][0-9])$/);
  assert.equal(new Set([...FIRST, ...SECOND]).size, FIRST.length + SECOND.length, 'no word appears twice');
  // Colours and animals that can pair into an insult are left out.
  for (const word of ['black', 'white', 'yellow', 'brown', 'red', 'ape', 'monkey', 'pig', 'rat', 'cow', 'dog']) {
    assert.ok(!FIRST.includes(word) && !SECOND.includes(word), word);
  }
  assert.ok(FIRST.length * SECOND.length * 98 > 100000, 'plenty of names to go round');
});

test('a typed name is tidied into one an address can use', () => {
  const { cleanName } = require('../closedhand-com/lib/names');
  const cases = [
    ['Lucy Smith', 'lucy-smith'], ['  Lucy   Smith! ', 'lucy-smith'], ['José', 'jose'], ['Zoë-Ångström', 'zoe-angstrom'],
    ['my.home_server', 'my-home-server'], ['--lucy--', 'lucy'], ['42-lucy', 'lucy'], ['LUCY', 'lucy'], ['a--b', 'a-b'],
    ['日本', ''], ['', ''], ['x'.repeat(40), 'x'.repeat(32)], ['abc-'.repeat(10), 'abc-abc-abc-abc-abc-abc-abc-abc'],
  ];
  for (const [typed, want] of cases) assert.equal(cleanName(typed), want, JSON.stringify(typed));
  assert.equal(cleanName(null), ''); assert.equal(cleanName(undefined), '');
});

test('My ClosedHand: signed in without a personal URL means Setup is not finished', () => {
  const base = { signedIn: true, found: false, available: true, choosing: false, failedSignIn: false, newcomer: false };
  assert.equal(navigation.openScreen(base), 'not-set-up');
  assert.equal(navigation.openScreen({ ...base, found: true }), 'found');
  assert.equal(navigation.openScreen({ ...base, signedIn: false }), 'find');
  assert.equal(navigation.openScreen({ ...base, choosing: true }), 'find', 'Use another account');
  assert.equal(navigation.openScreen({ ...base, failedSignIn: true }), 'find');
  assert.equal(navigation.openScreen({ ...base, available: false }), 'find', 'lookups down: they can still type it');
  assert.equal(navigation.openScreen({ ...base, signedIn: false, newcomer: true }), 'new');
  const fresh = { signedIn: false, choosing: false, failedSignIn: false, next: '/', known: null, nothingHere: true };
  assert.equal(navigation.isNewcomer(fresh), true);
  for (const change of [{ signedIn: true }, { choosing: true }, { failedSignIn: true }, { next: '/dashboard' }, { known: 'https://a-b-3.closedhand.ai/' }, { nothingHere: false }]) {
    assert.equal(navigation.isNewcomer({ ...fresh, ...change }), false, JSON.stringify(change));
  }
  // The page offers ClosedHand on this computer wherever it can't see it, on computers only.
  const html = fs.readFileSync(path.join(__dirname, '..', 'closedhand-com', 'views', 'open.html'), 'utf8');
  assert.match(html, /id="not-set-up"[\s\S]*Finish Setup on the computer you installed ClosedHand on\./);
  assert.doesNotMatch(html, /id="not-here"/, 'the old branch is gone');
  assert.match(html, /class="aside computer-only" id="local-link"[^>]*><a id="local-open" href="http:\/\/localhost:3000\/">Open ClosedHand on this computer<\/a>/);
  const js = fs.readFileSync(path.join(__dirname, '..', 'closedhand-com', 'public', 'open.js'), 'utf8');
  assert.match(js, /\$\('local-link'\)\.hidden = !\['new', 'find', 'not-set-up'\]\.includes\(screen\)/);
  assert.equal(navigation.LOCAL, 'http://localhost:3000');
});

test('the website sizes everything in rem, so computers get their density from one root size', () => {
  const site = path.join(__dirname, '..', 'closedhand-com');
  const views = fs.readdirSync(path.join(site, 'views')).filter(f => f.endsWith('.html'));
  const sources = new Map();
  for (const view of views) {
    const html = fs.readFileSync(path.join(site, 'views', view), 'utf8');
    for (const [, css] of html.matchAll(/<style>([\s\S]*?)<\/style>/g)) sources.set(view, (sources.get(view) || '') + css);
    for (const [, css] of html.matchAll(/ style="([^"]*)"/g)) sources.set(view, (sources.get(view) || '') + css);
    for (const [, sheet] of html.matchAll(/<link rel="stylesheet" href="\/([\w-]+\.css)">/g)) {
      sources.set(sheet, fs.readFileSync(path.join(site, 'public', sheet), 'utf8'));
    }
  }
  assert.ok(sources.has('interface.css') && sources.has('site.css') && sources.has('ethos.css') && sources.has('home.html'));
  // Pixels are only for hairlines and small offsets, media queries, and SVG user units.
  for (const [name, css] of sources) {
    const sizes = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{|url\([^)]*\)|transform-origin\s*:[^;}]*/g, '')
      .match(/-?\d*\.?\d+px\b/g) || [];
    assert.deepEqual(sizes.filter(v => Math.abs(parseFloat(v)) > 2), [], `${name} sizes in rem (px / 16)`);
  }
  const root = sources.get('interface.css');
  assert.match(root, /html \{ font-size: 100%; \}\n@media \(hover: hover\) and \(pointer: fine\) \{ html \{ font-size: 87\.5%; \} \}/);
  // The phone sheet: one line, and nothing more under the email note.
  const sheet = fs.readFileSync(path.join(site, 'public', 'get-sheet.js'), 'utf8');
  assert.match(sheet, /ClosedHand runs on your computer or server, so needs to be downloaded there\./);
  assert.doesNotMatch(sheet, /Note:/);
});
