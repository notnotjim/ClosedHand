const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('../webapp/public/setup-personal-url'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(respond = () => ({ state: 'off' })) {
  const nodes = new Map(), storage = new Map(), calls = [], copied = [], opened = [], popups = [];
  let now = 10000, changes = 0;
  function node(selector) {
    if (!nodes.has(selector)) nodes.set(selector, { value: '', hidden: false, handlers: {}, classList: { toggle() {} }, addEventListener(name, fn) { this.handlers[name] = fn; }, removeAttribute(name) { delete this[name]; }, focus() {}, select() {} });
    return nodes.get(selector);
  }
  const context = { window: { open() {
    const tab = { closed: false, close() { this.closed = true; }, location: { replace(url) { opened.push(url); } } };
    popups.push(tab); return tab;
  }, location: { assign(url) { opened.push(url); } } }, URL, AbortSignal, Date: { now: () => now },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    navigator: { clipboard: { writeText: async text => copied.push(text) } }, document: { execCommand: () => true },
    fetch: async (_, options) => { calls.push(options); const result = await respond(options); return { ok: !result.error, json: async () => result }; }
  };
  vm.runInNewContext(source, context);
  const api = context.window.ClosedHandSetupUrl.mount({ querySelector: node }, () => changes++);
  return { api, calls, copied, storage, opened, popups, context, node: id => node('#' + id),
    event: (id, type) => node('#' + id).handlers[type]({ preventDefault() {} }),
    async update(id = 'first', password = true) { now += 5000; api.update(id, password); await tick(); },
    changes: () => changes };
}
test('no remote request or enrollment is possible before a password', async () => {
  const f = fixture(); await f.update('first', false);
  f.node('url-name').value = 'example'; await f.event('url-form', 'submit'); f.event('url-continue', 'click');
  assert.equal(f.calls.length, 0); assert.equal(f.api.settled(), false); assert.equal(f.node('url-controls').hidden, true);
});
test('saving a password leaves an explicit optional URL choice; skip survives reload only for this install', async () => {
  const f = fixture(); await f.update(); assert.equal(f.api.settled(), false);
  f.event('url-continue', 'click'); assert.equal(f.api.settled(), true); assert.equal(f.changes(), 1);
  await f.update('other'); assert.equal(f.api.settled(), false);
  await f.update('first'); assert.equal(f.api.settled(), true);
  assert.ok(f.calls.every(c => c.method === 'GET'));
});
test('URL validation and preview precede owner confirmation; only managed enrollment is requested', async () => {
  const f = fixture(o => o.method === 'POST' ? { state: 'pairing', enabled: true, pairingUrl: 'https://closedhand.com/phone-access/pair#ticket' } : { state: 'off' });
  await f.update(); f.node('url-name').value = 'Example'; f.event('url-name', 'input');
  assert.equal(f.node('url-preview').textContent, 'https://example.closedhand.ai');
  await f.event('url-form', 'submit');
  assert.deepEqual(JSON.parse(f.calls.at(-1).body), { enabled: true, mode: 'managed', addressName: 'example' });
  assert.deepEqual(f.opened, ['https://closedhand.com/phone-access/pair#ticket']); assert.equal(f.api.settled(), false);
  f.event('url-continue', 'click'); assert.equal(f.api.settled(), true);
  assert.ok(f.calls.every(c => !c.body || JSON.parse(c.body).enabled));
});
test('unavailable service or full pilot never prevents continuing locally', async () => {
  const f = fixture(() => ({ error: 'The pilot is full.' })); await f.update();
  assert.match(f.node('url-status').textContent, /pilot is full/);
  f.event('url-continue', 'click'); assert.equal(f.api.settled(), true);
});
test('a registered URL is reusable and copyable even while disconnected', async () => {
  const f = fixture(() => ({ savedUrl: 'https://example.closedhand.ai', state: 'off' })); await f.update();
  assert.equal(f.node('url-saved').hidden, false); assert.match(f.node('url-status').textContent, /not connected/);
  await f.event('url-copy', 'click'); assert.deepEqual(f.copied, ['https://example.closedhand.ai/']);
  assert.equal(f.node('url-form').hidden, true);
});
test('stale responses from a different installation cannot replace current URL state', async () => {
  let resolve;
  const f = fixture(() => new Promise(r => { resolve = r; }));
  await f.update(); const old = resolve; await f.update('other');
  old({ state: 'on', permanent: true, url: 'https://old.closedhand.ai' }); await tick();
  assert.equal(f.node('url-saved').hidden, true);
  resolve({ state: 'off' }); await tick(); assert.equal(f.node('url-value').value, '');
});
test('unsafe returned URLs are never rendered as navigation targets', async () => {
  const f = fixture(() => ({ savedUrl: 'https://evil.example', pairingUrl: 'javascript:alert(1)' })); await f.update();
  assert.equal(f.opened.length, 0); assert.equal(f.node('url-saved').hidden, true);
});
test('setup keeps the combined step pending after password save and includes versioned client code', () => {
  const html = fs.readFileSync(require.resolve('../webapp/views/setup.html'), 'utf8');
  assert.match(html, /s.done = s.done && personalUrl.settled\(\)/);
  assert.match(html, /personalUrl.update\(state.installId, passwordDone\)/);
  assert.match(require('../webapp/assets').stamp(html), /setup-personal-url.js\?v=[a-f0-9]+/);
});
test('enrollment errors remain readable across background status checks', async () => {
  const f = fixture(o => o.method === 'POST' ? { error: 'That personal URL is already taken.' } : { state: 'off' });
  await f.update(); f.node('url-name').value = 'example'; await f.event('url-form', 'submit');
  await f.update(); assert.match(f.node('url-status').textContent, /already taken/);
  f.event('url-continue', 'click'); assert.equal(f.api.settled(), true);
});
test('background polling cannot silently swallow an enrollment click or overwrite its result', async () => {
  let finishPoll;
  const f = fixture(o => o.method === 'GET' ? new Promise(resolve => { finishPoll = resolve; }) :
    { state: 'pairing', enabled: true, pairingUrl: 'https://closedhand.com/phone-access/pair#new-ticket' });
  await f.update(); f.node('url-name').value = 'example'; await f.event('url-form', 'submit');
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  finishPoll({ state: 'off' }); await tick();
  assert.deepEqual(f.opened, ['https://closedhand.com/phone-access/pair#new-ticket']);
  assert.equal(f.node('url-status').textContent, 'Waiting for Google confirmation.');
  assert.equal(f.node('url-start').disabled, false);
});
test('a pending confirmation can be refreshed after reload without retyping the URL name', async () => {
  const f = fixture(() => ({ state: 'pairing', enabled: true, pairingUrl: 'https://closedhand.com/phone-access/pair#ticket' }));
  await f.update(); assert.equal(f.node('url-name').value, '');
  assert.equal(f.node('url-start').formNoValidate, true);
  await f.event('url-form', 'submit');
  assert.deepEqual(JSON.parse(f.calls.at(-1).body), { enabled: true, mode: 'managed' });
  assert.equal(f.opened.length, 1);
});

test('one click opens a fresh Google confirmation, with same-tab fallback when popups are blocked', async () => {
  const f = fixture(o => o.method === 'POST' ? { state: 'pairing', pairingUrl: 'https://closedhand.com/phone-access/pair#fresh' } : { state: 'off' });
  await f.update(); f.context.window.open = () => null;
  f.node('url-name').value = 'example'; await f.event('url-form', 'submit');
  assert.deepEqual(f.opened, ['https://closedhand.com/phone-access/pair#fresh']);
});
test('failed or unsafe confirmations close the blank tab and remain retryable', async () => {
  const f = fixture(o => o.method === 'POST' ? { pairingUrl: 'https://evil.example' } : { state: 'off' });
  await f.update(); f.node('url-name').value = 'example'; await f.event('url-form', 'submit');
  assert.equal(f.popups[0].closed, true); assert.equal(f.opened.length, 0);
  assert.match(f.node('url-status').textContent, /try again/);
  assert.equal(f.node('url-start').disabled, false);
});
test('the chosen URL remains visible after reloading setup', async () => {
  const f = fixture(() => ({ state: 'pairing', addressName: 'example' }));
  await f.update(); assert.equal(f.node('url-name').value, 'example');
  assert.equal(f.node('url-preview').textContent, 'https://example.closedhand.ai');
});

test('approved setup replaces the confirmation form while the URL connects, then offers Copy when ready', async () => {
  let state = { state: 'pairing', enabled: true, pairingUrl: 'https://closedhand.com/phone-access/pair#ticket', addressName: 'example' };
  const f = fixture(() => state); await f.update();
  assert.equal(f.node('url-form').hidden, false);
  assert.match(f.node('url-status').textContent, /Waiting for Google/);
  state = { enabled: true, state: 'provisioning', ownershipConfirmed: true, registrationState: 'pending', addressName: 'example' };
  await f.update();
  assert.equal(f.node('url-form').hidden, true);
  assert.match(f.node('url-status').textContent, /confirmed/);
  assert.equal(f.node('url-value').value, 'https://example.closedhand.ai/');
  assert.equal(f.node('url-copy').hidden, true);
  assert.equal(f.node('url-continue').textContent, 'Continue setup');
  state.registrationState = 'error'; await f.update();
  assert.match(f.node('url-status').textContent, /retry automatically/);
  state = { ...state, permanent: true, state: 'on', url: 'https://example.closedhand.ai' }; await f.update();
  assert.equal(f.node('url-copy').hidden, false);
  assert.match(f.node('url-status').textContent, /ready/);
});
