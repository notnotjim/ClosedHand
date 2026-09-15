const { test } = require('node:test');
const assert = require('node:assert/strict');
const guard = require('../lib/outbound-guard');
const fs = require('node:fs');
const path = require('node:path');
// Requiring confirmation.js starts the whole bot; read the list from its source instead.
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'confirmation.js'), 'utf8');
const ACTIONS_NEEDING_CONFIRMATION = [...src.match(/ACTIONS_NEEDING_CONFIRMATION = \[([^\]]*)\]/)[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
const store = { profile: { settings: { allowed_hosts: ['api.example.com'] } } };
const overpass = 'https://overpass-api.de/api/interpreter?data=' + encodeURIComponent('[out:json][timeout:25];(node["shop"="convenience"](around:800,35.6895,139.6917);node["shop"="supermarket"](around:800,35.6895,139.6917););out body;');
test('a long lookup of public data is a read and is not put to the person', () => {
  assert.equal(guard.outboundIntent('api_request', { url: overpass, method: 'GET' }, store), null);
  assert.equal(guard.outboundIntent('web_fetch', { url: overpass }, store), null);
  assert.equal(guard.outboundIntent('sandbox_exec', { code: 'curl "' + overpass + '"' }, store), null);
});
test('a lookup that carries an email, a number or a key is put to the person', () => {
  const r1 = guard.outboundIntent('api_request', { url: 'https://lookup.example.net/?q=james@example.com', method: 'GET' }, store);
  assert.match(r1.what, /email address/);
  const r2 = guard.outboundIntent('web_fetch', { url: 'https://lookup.example.net/?tel=%2B44%207737%20556%20907' }, store);
  assert.match(r2.what, /phone or card number/);
  const r3 = guard.outboundIntent('sandbox_exec', { code: 'curl "https://lookup.example.net/?k=sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"' }, store);
  assert.match(r3.what, /key or token/);
  assert.equal(guard.outboundIntent('api_request', { url: 'https://api.example.com/?q=james@example.com', method: 'GET' }, store), null, 'an approved host never asks');
});
test('writes still ask, and the list keeps only sends, deletes, changes and disconnects', () => {
  assert.match(guard.outboundIntent('api_request', { url: 'https://new.example.net/x', method: 'POST', body: { a: 1 } }, store).what, /POST/);
  assert.ok(!ACTIONS_NEEDING_CONFIRMATION.includes('api_request'));
  assert.ok(!ACTIONS_NEEDING_CONFIRMATION.includes('sandbox_gateway'));
  for (const name of ['gmail_send', 'gcal_delete_event', 'gcal_update_event', 'disconnect_service']) assert.ok(ACTIONS_NEEDING_CONFIRMATION.includes(name), name);
});
