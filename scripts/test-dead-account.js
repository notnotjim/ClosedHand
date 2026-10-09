// An account Google or Microsoft stopped accepting is never shown or reported
// as working, the person is told once, and signing in again renews it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const sent = [];
stub('../lib/db', { supabase: { from: () => ({ select: () => ({ eq: async () => ({ data: [{ platform: 'telegram', platform_user_id: '42' }] }) }) }) } });
stub('../lib/proactive', { getProactiveTargets: async (u, s, links) => links });
stub('../lib/messaging', { sendToPlatform: async (...a) => { sent.push(a); } });
stub('../lib/dashboard-links', { dashboardUrl: async (p, section) => `https://fixture.example/dashboard#${section}` });
const alert = require('../lib/connection-alert');

test('the person is told once, where they get updates, with the way back', async () => {
  const store = { connections: { google_extra_work: { metadata: { email: 'sam.work@example.com' } } } };
  assert.equal(await alert.tellOwner('u', store, 'google_extra_work'), true);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].slice(0, 2), ['telegram', '42']);
  assert.match(sent[0][2], /^Google stopped accepting Closedhand's sign-in for sam\.work@example\.com, so its mail and calendar are no longer updating/);
  assert.match(sent[0][2], /https:\/\/fixture\.example\/dashboard#connections/);
  assert.equal(await alert.tellOwner('u', store, 'shopify'), false, 'only sign-ins that can die this way');
  assert.equal(alert.providerOf('microsoft_extra_home'), 'Microsoft');
});

test('flagging an account sends the alert, and only the first time', () => {
  const us = fs.readFileSync(path.join(root, 'user-store.js'), 'utf8');
  const body = us.slice(us.indexOf('async markConnectionReconnectRequired'), us.indexOf('async deleteConnection'));
  assert.match(body, /if \(!conn \|\| conn\.metadata\?\.reconnect_required\) return;/);
  assert.match(body, /require\("\.\/lib\/connection-alert"\)\.tellOwner\(this\.userId, this, service\)/);
});

test('the dashboard, setup, chat and lookup all say it stopped working', () => {
  const dash = fs.readFileSync(path.join(root, 'webapp', 'views', 'dashboard.html'), 'utf8');
  assert.match(dash, /function extraAccountActions\(ex, exEmail, signInUrl\)/);
  assert.match(dash, /if \(!ex\.metadata\?\.reconnect_required\) return remove;/);
  assert.match(dash, /acctRow\(exEmail, extraAccountActions\(ex, exEmail, '\/auth\/google\?extra=1'\)\)/);
  assert.match(dash, /msRow\(exEmail, extraAccountActions\(ex, exEmail, '\/auth\/microsoft\?extra=1'\)\)/);
  assert.match(dash, /\$\{again \|\| extrasAgain \? `<span class="int-badge problem"/, 'a red mark in place of the tick when any account on the card stopped');
  assert.match(dash, /connTab\.classList\.toggle\('has-attn', signInAgain\.length > 0\)/, 'and a dot on the Connections tab');
  const setup = fs.readFileSync(path.join(root, 'webapp', 'views', 'setup.html'), 'utf8');
  assert.match(setup, /stopped\.join\(", "\) \+ " needs signing in again on the dashboard"/);
  assert.match(fs.readFileSync(path.join(root, 'webapp', 'setup-state.js'), 'utf8'), /addedSignInAgain,/);
  const engine = fs.readFileSync(path.join(root, 'lib', 'engine.js'), 'utf8');
  assert.match(engine, /NEEDS SIGNING IN AGAIN: \$\{dead\.join\(", "\)\}\. .*Never call it connected or synced\./);
  for (const f of ['google.js', 'microsoft.js']) {
    const src = fs.readFileSync(path.join(root, 'lib', 'services', f), 'utf8');
    assert.equal((src.match(/needsSignIn: !!/g) || []).length, 2, f);
  }
});

test('signing in again as an added Google account renews it instead of refusing', () => {
  const server = fs.readFileSync(path.join(root, 'webapp', 'server.js'), 'utf8');
  const body = server.slice(server.indexOf('async function handleExtraGoogleAccount'), server.indexOf('async function handleExtraMicrosoftAccount'));
  const renew = body.indexOf('await saveConnection(userId, same.service, tokens, svc, metadata);');
  assert.ok(renew > 0 && renew < body.indexOf('is already connected'), 'renew comes before the refusal');
  assert.match(server, /connectedAt: c\.connected_at \|\| c\.updated_at,/);
});
