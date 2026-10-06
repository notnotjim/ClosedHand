// The Google scopes requested are exactly the ones on the console's Data
// Access page, the narrowest that do the job, and a broader grant from before
// the narrowing still counts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const server = read('webapp/server.js');

test('the request lists exactly the console scopes', () => {
  const block = server.slice(server.indexOf('    scopes: [\n      "openid",'), server.indexOf('    extraAuthParams', server.indexOf('    scopes: [\n      "openid",')));
  const scopes = [...block.matchAll(/^\s*"([^"]+)",/gm)].map((m) => m[1]);
  assert.deepEqual(scopes, [
    'openid',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.compose',
    'https://www.googleapis.com/auth/calendar.events.owned',
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/drive.file',
  ]);
});

test('Calendar calls only touch the main calendar, which events.owned covers', () => {
  const code = ['lib/tools/handlers.js', 'lib/services/data-sync.js', 'lib/services/google.js'].map((f) => { try { return read(f); } catch { return ''; } }).join('\n');
  const calls = [...code.matchAll(/calendar\/v3\/([a-zA-Z]+)\/([^/"`?]+)/g)].map((m) => m[1] + '/' + m[2]);
  assert.ok(calls.length > 0);
  for (const c of calls) assert.equal(c, 'calendars/primary', c);
});

test('an account holding the broader Calendar grant is not told to reconnect', () => {
  assert.match(server, /const GRANT_COVERS = \{ \[AUTH \+ "calendar\.events\.owned"\]: \[AUTH \+ "calendar\.events", AUTH \+ "calendar"\] \};/);
  assert.match(server, /const missing = REQUIRED\.filter\(r => !granted\.includes\(r\) && !\(GRANT_COVERS\[r\] \|\| \[\]\)\.some\(\(b\) => granted\.includes\(b\)\)\);/);
});

test('a Mac build offers ClosedHand\'s Google app only when asked to', () => {
  assert.match(read('desktop/build.sh'), /\[ "\$\{CLOSEDHAND_GOOGLE_QUICK:-\}" = "1" \] && \[ -f "\$GOOGLE_APP_ENV" \]; then \. "\$GOOGLE_APP_ENV"; fi/);
});
