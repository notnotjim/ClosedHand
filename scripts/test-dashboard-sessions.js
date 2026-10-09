// Each dashboard sign-in is its own random session that can be ended.
// Logging out ends it, a new password (set on the setup page or in .env) ends
// every one made before, and a session runs out 30 days after its last use.
// Before, every sign-in got the same signed value for a year and nothing
// could take it back.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSessions, hashToken } = require('../webapp/dashboard-sessions');

const DAY = 24 * 60 * 60 * 1000;

// Just enough of the database client for one table.
function fakeDb() {
  const rows = new Map();
  const state = { rows, failReads: false };
  state.from = () => {
    const q = { filters: [], op: 'select' };
    const match = (r) => q.filters.every(([col, how, val]) => how === 'eq' ? r[col] === val : how === 'neq' ? r[col] !== val : r[col] < val);
    const run = async () => {
      if (q.op === 'select') {
        if (state.failReads) return { data: null, error: { message: 'connection refused' } };
        const hit = [...rows.values()].find(match);
        return { data: hit ? { ...hit } : null, error: null };
      }
      if (q.op === 'insert') { rows.set(q.row.token_hash, { ...q.row }); return { error: null }; }
      if (q.op === 'update') { for (const r of rows.values()) if (match(r)) Object.assign(r, q.row); return { error: null }; }
      if (q.op === 'delete') { for (const [k, r] of rows) if (match(r)) rows.delete(k); return { error: null }; }
    };
    const b = {
      select() { q.op = 'select'; return b; },
      insert(row) { q.op = 'insert'; q.row = row; return b; },
      update(row) { q.op = 'update'; q.row = row; return b; },
      delete() { q.op = 'delete'; return b; },
      eq(c, v) { q.filters.push([c, 'eq', v]); return b; },
      neq(c, v) { q.filters.push([c, 'neq', v]); return b; },
      lt(c, v) { q.filters.push([c, 'lt', v]); return b; },
      maybeSingle() { return run(); },
      then(ok, bad) { return run().then(ok, bad); },
    };
    return b;
  };
  return state;
}

function setup({ storedHash = 'salt:hash', envPassword = '' } = {}) {
  const db = fakeDb();
  const clock = { t: Date.parse('2026-10-09T12:00:00Z') };
  const pw = { storedHash, envPassword };
  const make = () => createSessions({ db, now: () => clock.t, password: async () => (pw.envPassword ? { envPassword: pw.envPassword } : { storedHash: pw.storedHash }) });
  return { db, clock, pw, sessions: make(), another: make };
}

test('every sign-in gets its own random session, and only a hash of it is kept', async () => {
  const { db, sessions } = setup();
  const a = await sessions.start();
  const b = await sessions.start();
  assert.notEqual(a.token, b.token);
  assert.ok(a.token.length >= 43, '32 random bytes');
  assert.equal(a.maxAgeSec, 30 * 24 * 60 * 60);
  for (const row of db.rows.values()) {
    assert.notEqual(row.token_hash, a.token);
    assert.notEqual(row.token_hash, b.token);
  }
  assert.ok(db.rows.has(hashToken(a.token)));
  assert.equal((await sessions.check(a.token)).ok, true);
  assert.equal((await sessions.check(b.token)).ok, true);
});

test('the old shared cookie value and made-up values do not sign in', async () => {
  const { sessions } = setup();
  await sessions.start();
  for (const v of ['admin-session.0f3c', 'admin-session', '', null, 'x'.repeat(43)]) assert.equal((await sessions.check(v)).ok, false, String(v));
});

test('logging out ends that session at once and leaves the others', async () => {
  const { sessions } = setup();
  const phone = await sessions.start();
  const laptop = await sessions.start();
  await sessions.end(phone.token);
  assert.equal((await sessions.check(phone.token)).ok, false);
  assert.equal((await sessions.check(laptop.token)).ok, true);
});

test('a session ended by another process stops working within a minute', async () => {
  const { sessions, another, clock } = setup();
  const s = await sessions.start();
  assert.equal((await sessions.check(s.token)).ok, true);
  await another().end(s.token);
  clock.t += 61 * 1000;
  assert.equal((await sessions.check(s.token)).ok, false);
});

test('a new password on the setup page ends every earlier session', async () => {
  const { sessions, pw } = setup();
  const s = await sessions.start();
  pw.storedHash = 'newsalt:newhash';
  assert.equal((await sessions.check(s.token)).ok, false);
  const fresh = await sessions.start();
  assert.equal((await sessions.check(fresh.token)).ok, true);
});

test('a new ADMIN_PASSWORD in .env ends every earlier session too', async () => {
  const { sessions, pw } = setup({ envPassword: 'first password' });
  const s = await sessions.start();
  assert.equal((await sessions.check(s.token)).ok, true);
  pw.envPassword = 'second password';
  assert.equal((await sessions.check(s.token)).ok, false);
});

test('no password set means no session can start', async () => {
  const { sessions } = setup({ storedHash: '' });
  await assert.rejects(sessions.start(), /no dashboard password/);
});

test('endAll signs every browser out', async () => {
  const { sessions } = setup();
  const a = await sessions.start();
  const b = await sessions.start();
  await sessions.endAll();
  assert.equal((await sessions.check(a.token)).ok, false);
  assert.equal((await sessions.check(b.token)).ok, false);
});

test('a password session lasts 30 days from its last use, stretched at most once a day', async () => {
  const { sessions, clock } = setup();
  const s = await sessions.start();
  clock.t += 2 * 60 * 60 * 1000;
  assert.deepEqual(await sessions.check(s.token), { ok: true }, 'used again the same day: not stretched yet');
  clock.t += 2 * DAY;
  assert.deepEqual(await sessions.check(s.token), { ok: true, refreshSec: 30 * 24 * 60 * 60 }, 'stretched, and the cookie is sent again');
  clock.t += 29 * DAY;
  assert.equal((await sessions.check(s.token)).ok, true, 'still inside 30 days of last use');
  clock.t += 31 * DAY;
  assert.equal((await sessions.check(s.token)).ok, false, 'unused for 31 days');
});

test('a Telegram session keeps its own length and does not stretch', async () => {
  const { sessions, clock } = setup();
  const s = await sessions.start({ kind: 'telegram', lastsSec: 12 * 60 * 60 });
  assert.equal(s.maxAgeSec, 12 * 60 * 60);
  clock.t += 11 * 60 * 60 * 1000;
  assert.deepEqual(await sessions.check(s.token), { ok: true });
  clock.t += 2 * 60 * 60 * 1000;
  assert.equal((await sessions.check(s.token)).ok, false);
});

test('while the database cannot be read, a session this process checked stays good and an unknown one does not', async () => {
  const { db, sessions, clock } = setup();
  const s = await sessions.start();
  const other = await setup().sessions.start();
  db.failReads = true;
  clock.t += 5 * 60 * 1000;
  assert.equal((await sessions.check(s.token)).ok, true);
  assert.equal((await sessions.check(other.token)).ok, false);
  await sessions.end(s.token);
  assert.equal((await sessions.check(s.token)).ok, false, 'ending it here forgets it at once');
});

test('the dashboard starts, checks and ends sessions through this module', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'webapp/server.js'), 'utf8');
  assert.doesNotMatch(server, /ADMIN_SESSION_VALUE|setAdminSessionCookie|"admin-session"/);
  assert.match(server, /require\("\.\/dashboard-sessions"\)\.createSessions\(/);
  const logout = server.slice(server.indexOf('app.post("/logout"'), server.indexOf('app.get("/logout"'));
  assert.match(logout, /await dashboardSessions\.end\(readCookie\(req, browserAccess\.sessionName\(req\)\)\)/);
  assert.match(logout, /sessionCookie\(req, "", 0\)/);
  const setPw = server.slice(server.indexOf('app.post("/api/setup/password"'), server.indexOf('app.post("/api/setup/detect"'));
  assert.match(setPw, /await dashboardSessions\.endAll\(\);\n\s*await startAdminSession\(req, res\);/);
  const login = server.slice(server.indexOf('app.post("/api/login"'), server.indexOf('// --- Reach the dashboard from your phone'));
  assert.match(login, /await startAdminSession\(req, res\);/);
  assert.equal((server.match(/hasAdminSession\(req\)/g) || []).length, 0, 'every check awaits the session and can refresh its cookie');
  const access = fs.readFileSync(path.join(__dirname, '..', 'webapp/browser-access.js'), 'utf8');
  assert.match(access, /Max-Age=2592000/, 'the cookie lasts 30 days, matching the session');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'migrations/058_dashboard_sessions.sql')));
});

// The five-tries lockout covers every way of trying the password, and the
// address it counts against can't be made up by whoever is asking.
test("Cloudflare's address header is believed only from the tunnel on this computer", () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'webapp/server.js'), 'utf8');
  const src = server.slice(server.indexOf('const isLoopback = '), server.indexOf('function lockedOut('));
  const clientIp = new Function(src + '; return clientIp;')();
  const req = (peer, cf) => ({ socket: { remoteAddress: peer }, headers: cf ? { 'cf-connecting-ip': cf } : {} });
  assert.equal(clientIp(req('::1', '203.0.113.9')), '203.0.113.9', 'through the tunnel');
  assert.equal(clientIp(req('127.0.0.1', '203.0.113.9')), '203.0.113.9');
  assert.equal(clientIp(req('::ffff:127.0.0.1', '203.0.113.9')), '203.0.113.9');
  assert.equal(clientIp(req('172.18.0.1', '203.0.113.9')), '172.18.0.1', 'reached directly: the header is ignored');
  assert.equal(clientIp(req('192.168.1.20', '1.2.3.4')), '192.168.1.20');
  assert.equal(clientIp(req('::1')), '::1');
});

test('the sign-in form, the wallet check and Basic auth share one count of wrong passwords', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'webapp/server.js'), 'utf8');
  const login = server.slice(server.indexOf('app.post("/api/login"'), server.indexOf('// --- Reach the dashboard from your phone'));
  const wallet = server.slice(server.indexOf('app.post("/api/wallet/confirm"'), server.indexOf('function walletAvailable()'));
  const gate = server.slice(server.indexOf('const SIGNED_BY_BRIDGE = new Set('), server.indexOf('// BYOK spend: daily token rollups'));
  for (const [name, part] of [['sign-in', login], ['wallet', wallet], ['Basic auth', gate]]) {
    assert.match(part, /if \(lockedOut\(ip, req\)\) return res\.status\(429\)/, name);
    assert.match(part, /noteWrongPassword\(ip, req\);/, name);
    assert.doesNotMatch(part, /rec\.n \+= 1/, name + ' keeps no count of its own');
  }
  assert.ok(gate.indexOf('lockedOut(ip, req)') < gate.indexOf('checkDashboardPassword(pass)'), 'a locked-out address is refused before its password is checked');
});

test('through the personal URL, 100 wrong passwords an hour from all addresses together stop every try; this computer is never held to it', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'webapp/server.js'), 'utf8');
  const src = server.slice(server.indexOf('const _loginFails = new Map();'), server.indexOf('app.post("/api/login"'));
  const box = new Function(src + '; return { lockedOut, noteWrongPassword, clientIp };')();
  const tunnel = (ip) => ({ socket: { remoteAddress: '::1' }, headers: { 'cf-connecting-ip': ip } });
  const local = { socket: { remoteAddress: '172.18.0.1' }, headers: {} };
  for (let i = 0; i < 100; i++) {
    const req = tunnel('198.51.100.' + (i % 250) + '.' + i);
    assert.equal(box.lockedOut(box.clientIp(req), req), false, 'try ' + i);
    box.noteWrongPassword(box.clientIp(req), req);
  }
  const fresh = tunnel('203.0.113.77');
  assert.equal(box.lockedOut(box.clientIp(fresh), fresh), true, 'a new address through the personal URL is refused too');
  assert.equal(box.lockedOut(box.clientIp(local), local), false, 'the computer itself still signs in');
});

test('a dashboard password has at least 8 characters, on the setup page and on the server', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'webapp/server.js'), 'utf8');
  const route = server.slice(server.indexOf('app.post("/api/setup/password"'), server.indexOf('app.post("/api/setup/detect"'));
  assert.match(route, /if \(pw\.length < 8\) return res\.status\(400\)\.json\(\{ error: "Use at least 8 characters\." \}\);/);
  const setup = fs.readFileSync(path.join(__dirname, '..', 'webapp/views/setup.html'), 'utf8');
  assert.match(setup, /id="pw-input" autocomplete="new-password" minlength="8" required/);
});

test('logging out is a POST that clears what the browser kept, and a link elsewhere cannot do it', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'webapp/server.js'), 'utf8');
  const post = server.slice(server.indexOf('app.post("/logout"'), server.indexOf('app.get("/logout"'));
  assert.match(post, /res\.set\("Clear-Site-Data", '"cache", "storage"'\);/);
  for (const c of ['ch_user', 'ch_wa_link', 'ch_connect_queue', 'ch_wallet_ok']) assert.ok(post.includes(c + '=;'), c + ' is cleared');
  const get = server.slice(server.indexOf('app.get("/logout"'), server.indexOf('app.get("/logout"') + 900);
  assert.doesNotMatch(get, /dashboardSessions\.end/, 'opening /logout only shows the button');
  assert.match(get, /<form method="post" action="\/logout"/);
  assert.doesNotMatch(server, /setUserCookie|signUserId|verifySignedCookie/, 'the old signed cookie is gone');
  const dash = fs.readFileSync(path.join(__dirname, '..', 'webapp/views/dashboard.html'), 'utf8');
  assert.match(dash, /fetch\('\/logout', \{ method: 'POST', credentials: 'same-origin' \}\)/);
});

test('API answers are kept by no browser cache, from the first route on', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'webapp/server.js'), 'utf8');
  const noStore = server.indexOf('app.use("/api", (req, res, next) => {\n  res.set("Cache-Control", "no-store");');
  assert.ok(noStore > 0 && noStore < server.indexOf('app.get("/api/'), 'before any API route');
});
