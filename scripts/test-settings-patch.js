// Settings change only by the keys named, inside the database. A writer that
// read the settings, changed the copy and wrote the whole copy back wiped
// every setting, the dashboard password included, when its read failed during
// a database restart; with no password the dashboard opens to anyone.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const { diff, patchSettings, changeSettings } = require('../lib/settings-patch');

test('nothing writes the whole settings object to profiles', () => {
  const files = execSync('git ls-files lib webapp index.js user-store.js', { cwd: root }).toString().trim().split('\n')
    .filter((f) => f.endsWith('.js') && !f.includes('settings-patch') && !f.startsWith('webapp/public'));
  const found = [];
  for (const f of files) {
    const s = read(f);
    const re = /\.update\(\s*\{[^)]{0,200}?\bsettings\b/g;
    let m;
    while ((m = re.exec(s))) if (/profiles/.test(s.slice(Math.max(0, m.index - 160), m.index))) found.push(f + ':' + s.slice(0, m.index).split('\n').length);
  }
  assert.deepEqual(found, [], 'use settings-patch.js (patchSettings or changeSettings)');
});

test('diff names only what changed, and never self_host_config', () => {
  const before = { a: 1, b: { x: 1 }, gone: true, self_host_config: { K: 1 } };
  const after = { a: 1, b: { x: 2 }, c: 'new', self_host_config: {} };
  assert.deepEqual(diff(before, after), { set: { b: { x: 2 }, c: 'new' }, unset: ['gone'] });
});

function fakeDb({ readError = null, row = { settings: { a: 1, self_host_config: { K: 'v' } } }, rpcError = null } = {}) {
  const calls = [];
  return {
    calls,
    from() { const q = { select() { return q; }, eq() { return q; }, maybeSingle: async () => ({ data: readError ? null : row, error: readError }) }; return q; },
    async rpc(name, args) { calls.push([name, args]); return rpcError ? { data: null, error: rpcError } : { data: [{ patch_profile_settings: { saved: true } }], error: null }; },
  };
}

test('a failed or empty read writes nothing', async () => {
  const failed = fakeDb({ readError: { message: 'the database system is in recovery mode' } });
  await assert.rejects(changeSettings(failed, 'u1', (s) => { s.b = 2; }), /not read/);
  assert.equal(failed.calls.length, 0);
  const empty = fakeDb({ row: null });
  await assert.rejects(changeSettings(empty, 'u1', (s) => { s.b = 2; }), /no profile row/);
  assert.equal(empty.calls.length, 0);
});

test('only the changed keys reach the database, config keys one by one', async () => {
  const db = fakeDb();
  await changeSettings(db, 'u1', (s) => { s.b = 2; delete s.a; s.self_host_config.NEW = 'n'; delete s.self_host_config.K; });
  assert.deepEqual(db.calls, [['patch_profile_settings', { p_id: 'u1', p_set: { b: 2 }, p_unset: ['a'], p_conf_set: { NEW: 'n' }, p_conf_unset: ['K'] }]]);
  const none = fakeDb();
  await changeSettings(none, 'u1', () => {});
  assert.equal(none.calls.length, 0, 'no change, no write');
  await assert.rejects(patchSettings(fakeDb({ rpcError: { message: 'down' } }), 'u1', { set: { a: 2 } }), /not saved/);
});

test('the database function never replaces self_host_config whole', () => {
  const sql = read('migrations/057_patch_profile_settings.sql');
  assert.match(sql, /CREATE OR REPLACE FUNCTION patch_profile_settings\(/);
  assert.match(sql, /\|\| \(coalesce\(p_set, '\{\}'::jsonb\) - 'self_host_config'\)/);
  assert.match(sql, /\(coalesce\(settings->'self_host_config', '\{\}'::jsonb\) - coalesce\(p_conf_unset, '\{\}'::text\[\]\)\)\s*\|\| coalesce\(p_conf_set, '\{\}'::jsonb\)/);
});

test('unreadable settings lock the dashboard rather than open it', () => {
  const server = read('webapp/server.js');
  assert.match(server, /return !!\(await require\("\.\/config"\)\.getConfStrict\("DASHBOARD_PASSWORD_HASH"\)\);\n\s*\} catch \(_\) \{\n\s*return true;/);
  const config = read('webapp/config.js');
  assert.match(config, /if \(error\) throw new Error\(error\.message\);/);
  assert.match(config, /_failed = true;\n\s*return _cache \|\| \{\};/);
  assert.match(config, /if \(_failed\) throw new Error\("settings could not be read"\);/);
});
