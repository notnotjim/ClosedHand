// The Bridge app signs its requests with its own token, never the dashboard
// session. The dashboard gate turned every one of them away once a password
// existed, so Mac file transfers, thumbnails, the Bridge's sync and its Remove
// button all failed. Exactly those routes pass the gate now, and each one
// refuses a missing or wrong token itself.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const server = read('webapp/server.js');

function handler(route) {
  const at = server.indexOf(`app.post("${route}"`);
  assert.ok(at > 0, `${route} exists`);
  return server.slice(at, at + 1400);
}

test('only the Bridge-signed POST routes pass the dashboard gate', () => {
  const set = server.match(/const SIGNED_BY_BRIDGE = new Set\(\[([^\]]*)\]\);/);
  assert.ok(set, 'the list exists');
  const routes = set[1].split(',').map((s) => s.trim().replace(/"/g, ''));
  assert.deepEqual(routes.sort(), ['/api/bridge/disconnect', '/api/bridge/file-upload', '/api/bridge/sync-cache', '/api/bridge/thumb-upload']);
  assert.match(server, /if \(hasAdminSession\(req\)\) return next\(\);\n\s*if \(req\.method === "POST" && SIGNED_BY_BRIDGE\.has\(req\.path\)\) return next\(\);/);
});

test('each of those routes refuses a missing or wrong token before doing anything', () => {
  assert.match(handler('/api/bridge/file-upload'), /_uploadTokens\.get\(token\);\s*if \(!tokenData \|\| Date\.now\(\) > tokenData\.expires\) \{[^}]*status\(401\)/);
  assert.match(handler('/api/bridge/thumb-upload'), /_thumbTokens\.get\(token\);\s*if \(!pending \|\| pending\.expires < Date\.now\(\)\) return res\.status\(401\)/);
  const sync = handler('/api/bridge/sync-cache');
  assert.match(sync, /if \(!token\) return res\.status\(401\)/);
  assert.match(sync, /\.eq\("token", token\)[\s\S]*if \(bridgeErr \|\| !bridge\) return res\.status\(403\)/);
  const remove = handler('/api/bridge/disconnect');
  assert.match(remove, /if \(!token\) return res\.status\(401\)/);
  assert.match(remove, /if \(!bridge\) return res\.status\(403\)/);
  assert.ok(remove.indexOf('status(403)') < remove.indexOf('.delete()'), 'nothing is deleted before the token is checked');
});

test('Remove deletes only what the Bridge synced, then the pairing', () => {
  const remove = handler('/api/bridge/disconnect');
  assert.match(remove, /from\("data_cache"\)\.delete\(\)\.eq\("user_id", userId\)\.in\("source", \["mac_calendar", "bridge"\]\)/);
  assert.match(remove, /from\("user_bridges"\)\.delete\(\)\.eq\("user_id", userId\)/);
});

test('the Bridge app and README describe this version: no ClosedHand servers, no end-to-end claim', () => {
  for (const file of ['bridge-app/Sources/OnboardingView.swift', 'bridge-app/Sources/SettingsView.swift']) {
    const text = read(file);
    assert.doesNotMatch(text, /ClosedHand's servers|end to end|ClosedHand account/, file);
  }
  assert.doesNotMatch(read('README.md'), /never transits anyone's infrastructure/);
  assert.match(read('README.md'), /relay on Cloudflare, encrypted on the way and not kept/);
});
