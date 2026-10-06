// A second Google or Microsoft account is as connected as the first, and
// list_connections says so.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { accountsFor } = require('../lib/connected-accounts');

test('every account of a service is reported, the first one first', () => {
  const connections = {
    google: { tokens: { access_token: 'x' }, metadata: { email: 'sam@example.com' } },
    google_extra_work: { tokens: { access_token: 'y' }, metadata: { email: 'sam.work@example.com' } },
    google_extra_gone: { metadata: { email: 'old@example.com' } },
    google_extra_dead: { tokens: { access_token: 'v' }, metadata: { email: 'sam.old@example.com', reconnect_required: true } },
    microsoft_extra_home: { tokens: { access_token: 'z' }, metadata: { email: 'sam@example.net' } },
    shopify: { tokens: { access_token: 'w' }, metadata: { shopDomain: 'fixture.myshopify.com' } },
  };
  assert.deepEqual(accountsFor(connections, 'google'), ['sam@example.com', 'sam.work@example.com', 'sam.old@example.com (needs signing in again)']);
  assert.deepEqual(accountsFor(connections, 'shopify'), ['fixture.myshopify.com']);
  assert.deepEqual(accountsFor(connections, 'slack'), []);
  assert.deepEqual(accountsFor({}, 'google'), []);
});

test('list_connections reports them all', () => {
  const handlers = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tools', 'handlers.js'), 'utf8');
  const body = handlers.slice(handlers.indexOf('case "list_connections"'), handlers.indexOf('case "connect_service"'));
  assert.match(body, /accountsFor\(ctx\.activeUserStore\.connections, key\)/);
  assert.match(body, /accounts\.length > 1 \? \{ accounts \} : \{\}/);
});
