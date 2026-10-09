const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('../webapp/public/setup-personal-url'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(respond = () => ({ state: 'off' }), at = {}) {
  const nodes = new Map(), storage = new Map(), calls = [], copied = [], opened = [], popups = [], replaced = [];
  let now = 10000, changes = 0;
  function node(selector) {
    if (!nodes.has(selector)) nodes.set(selector, { value: '', hidden: false, handlers: {}, classList: { toggle() {} }, addEventListener(name, fn) { this.handlers[name] = fn; }, removeAttribute(name) { delete this[name]; }, focus() {}, select() {} });
    return nodes.get(selector);
  }
  const context = { window: { closed: 0, close() { this.closed++; }, open() {
    const tab = { closed: false, close() { this.closed = true; }, location: { replace(url) { opened.push(url); } } };
    popups.push(tab); return tab;
  }, location: { assign(url) { opened.push(url); }, origin: 'http://localhost:3000', hostname: at.hostname || 'localhost', pathname: '/setup', search: '', hash: at.hash || '' },
    history: { replaceState(_, __, url) { context.window.location.hash = ''; replaced.push(url); } } }, URL, URLSearchParams, AbortSignal, Date: { now: () => now },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    navigator: { clipboard: { writeText: async text => copied.push(text) } }, document: { execCommand: () => true }, setTimeout: fn => fn(),
    fetch: async (_, options) => { calls.push(options); const result = await respond(options); return { ok: !result.error, json: async () => result }; }
  };
  node('#url-rename-form').hidden = true; // as setup.html starts it
  vm.runInNewContext(source, context);
  const api = context.window.ClosedHandSetupUrl.mount({ querySelector: node }, () => changes++);
  return { api, calls, copied, storage, opened, popups, replaced, context, node: id => node('#' + id),
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
test('one click asks for a picked personal URL; only managed enrollment is requested', async () => {
  const f = fixture(o => o.method === 'POST' ? { state: 'pairing', enabled: true, pairingUrl: 'https://closedhand.com/phone-access/pair#ticket' } : { state: 'off' });
  await f.update();
  assert.equal(f.node('url-start').textContent, 'Claim your personal URL');
  await f.event('url-form', 'submit');
  assert.deepEqual(JSON.parse(f.calls.at(-1).body), { enabled: true, mode: 'managed' }, 'no name: closedhand.com picks it');
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
test('the personal URL is a step of its own after email and calendar, with the URL on its folded card', () => {
  const html = fs.readFileSync(require.resolve('../webapp/views/setup.html'), 'utf8');
  const step = name => { const at = html.indexOf(`id="step-${name}"`); return html.slice(at, html.indexOf('<li class="step"', at + 1)); };
  assert.match(step('personal_url'), /id="setup-personal-url"/);
  assert.doesNotMatch(step('accounts'), /setup-personal-url|url-saved/, 'nothing about the URL in the email card');
  // The URL and its Copy button sit between the head and the body, so they show while folded.
  assert.match(step('personal_url'), /<\/button>\n\s*<div id="url-saved" hidden>[\s\S]*<div class="card-body">/);
  assert.ok(html.indexOf('id="step-accounts"') < html.indexOf('id="step-personal_url"') && html.indexOf('id="step-personal_url"') < html.indexOf('id="step-chat"'));
  assert.match(step('personal_url'), /<span class="num">05<\/span>/); assert.match(step('chat'), /<span class="num">06<\/span>/);
  assert.match(html, /if \(s.key === "accounts"\) steps.push\(\{ key: "personal_url", label: "Personal URL", required: true, done: !!\(s.done && personalUrl.settled\(\)\) \}\);/);
  assert.match(html, /personalUrl.update\(state.installId, passwordDone && accountDone, connected\)/);
  assert.match(html, /ClosedHandSetupUrl.mount\(document.getElementById\("step-personal_url"\)/);
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
  assert.equal(f.node('url-status').textContent, '');
  assert.equal(f.node('url-code-form').hidden, false, 'the code field says what to do next');
  assert.equal(f.node('url-start').textContent, 'Open closedhand.com again');
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
test('once confirmed, setup says where Closedhand is, with Change to rename it', async () => {
  let reply = { error: 'That name is taken. Try another.' };
  const f = fixture(o => o.method === 'POST' ? reply : { enabled: true, state: 'provisioning', ownershipConfirmed: true, registrationState: 'pending', addressName: 'amber-fox-42' });
  await f.update();
  assert.equal(f.node('url-ready').hidden, false);
  assert.equal(f.node('url-where').textContent, 'amber-fox-42.closedhand.ai');
  assert.equal(f.node('url-form').hidden, true, 'nothing left to choose');
  // Change opens a rename form with a tidied preview.
  f.node('url-rename-form').hidden = true;
  f.node('url-change').handlers.click({ preventDefault() {} });
  assert.equal(f.node('url-rename-form').hidden, false);
  f.node('url-new-name').value = ' Lucy Smith! '; f.node('url-new-name').handlers.input();
  assert.equal(f.node('url-new-preview').textContent, 'lucy-smith.closedhand.ai');
  await f.event('url-rename-form', 'submit'); await tick();
  assert.equal(f.node('url-status').textContent, 'That name is taken. Try another.');
  assert.equal(f.node('url-rename-form').hidden, false, 'a refusal leaves the form open to try again');
  reply = { enabled: true, state: 'provisioning', ownershipConfirmed: true, renamedTo: 'https://lucy-smith.closedhand.ai' };
  await f.event('url-rename-form', 'submit'); await tick();
  assert.equal(f.node('url-where').textContent, 'lucy-smith.closedhand.ai');
  assert.match(f.node('url-status').textContent, /now at lucy-smith\.closedhand\.ai.*30 days/);
  assert.equal(f.node('url-rename-form').hidden, true);
  const renames = f.calls.filter(c => c.method === 'POST');
  assert.deepEqual(renames.map(c => JSON.parse(c.body)), [{ name: ' Lucy Smith! ' }, { name: ' Lucy Smith! ' }]);
});

test('approved setup replaces the confirmation form while the URL connects, then offers Copy when ready', async () => {
  let state = { state: 'pairing', enabled: true, pairingUrl: 'https://closedhand.com/phone-access/pair#ticket', addressName: 'example' };
  const f = fixture(() => state); await f.update();
  assert.equal(f.node('url-form').hidden, false);
  assert.equal(f.node('url-code-form').hidden, false, 'the code field shows while waiting');
  state = { enabled: true, state: 'provisioning', ownershipConfirmed: true, registrationState: 'pending', addressName: 'example' };
  await f.update();
  assert.equal(f.node('url-form').hidden, true);
  assert.equal(f.node('url-code-form').hidden, true, 'and goes once the code is accepted');
  assert.match(f.node('url-status').textContent, /claimed/);
  assert.equal(f.node('url-value').value, 'https://example.closedhand.ai/');
  assert.equal(f.node('url-copy').hidden, false, 'copyable as soon as it is claimed');
  assert.equal(f.node('url-continue').hidden, true, 'claimed folds the step by itself');
  assert.equal(f.api.settled(), true);
  state.registrationState = 'error'; await f.update();
  assert.match(f.node('url-status').textContent, /retry automatically/);
  state = { ...state, permanent: true, state: 'on', url: 'https://example.closedhand.ai' }; await f.update();
  assert.equal(f.node('url-copy').hidden, false);
  assert.match(f.node('url-status').textContent, /ready/);
});

test('a claimed URL completes the step once, while it connects; unclaimed, offline and unsafe URLs do not', async () => {
  let state = {savedUrl:'https://example.closedhand.ai',state:'off'};
  const f=fixture(()=>state); await f.update(); assert.equal(f.api.settled(),false);
  state={savedUrl:'https://evil.example',state:'on'};await f.update();assert.equal(f.api.settled(),false);
  state={enabled:true,ownershipConfirmed:true,addressName:'Not A Name!',state:'provisioning'};await f.update();assert.equal(f.api.settled(),false);
  state={enabled:true,ownershipConfirmed:true,registrationState:'pending',state:'provisioning',addressName:'example'};await f.update();assert.equal(f.api.settled(),true);assert.equal(f.changes(),1);
  state={savedUrl:'https://example.closedhand.ai',state:'on'};
  await f.update();assert.equal(f.changes(),1);
  await f.event('url-copy','click');assert.deepEqual(f.copied,['https://example.closedhand.ai/']);
  assert.equal(f.node('url-copy-status').textContent,'Copied.');assert.equal(f.node('url-copy-status').hidden,false);
});

test('reloading a completed setup still announces readiness once so an old step anchor can collapse', async () => {
  const f=fixture(()=>({savedUrl:'https://example.closedhand.ai',state:'on'}));
  f.storage.set('ch-setup-personal-url:first','done');
  await f.update();assert.equal(f.api.settled(),true);assert.equal(f.changes(),1);
  await f.update();assert.equal(f.changes(),1,'background polling must not close a manually reopened step');
});

test('typing the code sends it once, clears it on success and keeps a refusal readable', async () => {
  let reply = { error: 'That code does not match. Check the code on closedhand.com and try again.' };
  const f = fixture(o => o.method === 'POST' ? reply : { state: 'pairing', enabled: true, pairingUrl: 'https://closedhand.com/phone-access/pair#ticket', addressName: 'example' });
  await f.update();
  f.node('url-code').value = 'abc 234';
  await f.event('url-code-form', 'submit'); await tick();
  const sent = f.calls.filter(c => c.method === 'POST');
  assert.equal(sent.length, 1); assert.deepEqual(JSON.parse(sent[0].body), { code: 'abc 234' });
  assert.match(f.node('url-status').textContent, /does not match/);
  assert.equal(f.node('url-code').value, 'abc 234', 'a refused code stays so it can be corrected');
  reply = { state: 'pairing', enabled: true, ownershipConfirmed: true };
  await f.event('url-code-form', 'submit'); await tick();
  assert.equal(f.node('url-code').value, '');
  assert.equal(f.node('url-code-submit').disabled, false);
});

test('carrying on without a personal URL is offered only when closedhand.com cannot give one out', async () => {
  let state = { state: 'off', serviceAvailable: true };
  const f = fixture(() => state);
  await f.update();
  assert.equal(f.node('url-continue').hidden, true, 'every Closedhand gets one here');
  assert.equal(f.node('url-start').textContent, 'Claim your personal URL');
  state = { state: 'off', serviceAvailable: false }; await f.update();
  assert.equal(f.node('url-continue').hidden, false);
  assert.equal(f.node('url-continue').textContent, 'Continue without a personal URL');
  assert.match(f.node('url-status').textContent, /can’t give out personal URLs right now.*dashboard/);
  f.event('url-continue', 'click'); assert.equal(f.api.settled(), true);
  state = { enabled: true, state: 'pairing', serviceAvailable: true, pairingUrl: 'https://closedhand.com/phone-access/pair#t' }; await f.update();
  assert.equal(f.node('url-continue').hidden, true, 'not while waiting for the owner to confirm');
  state = { enabled: true, state: 'provisioning', serviceAvailable: true, ownershipConfirmed: true, addressName: 'amber-fox-42' }; await f.update();
  assert.equal(f.node('url-continue').hidden, true, 'claimed: nothing to press, the step folds by itself');
});

test('the code box is ready to paste into, and a pasted code finishes by itself', async () => {
  const f = fixture(o => o.method === 'POST' ? { state: 'pairing', enabled: true, ownershipConfirmed: true } : { state: 'pairing', enabled: true, pairingUrl: 'https://closedhand.com/phone-access/pair#ticket' });
  let focused = 0; f.node('url-code').focus = () => { focused++; };
  await f.update(); await tick();
  assert.equal(focused, 1, 'focused when the code is what is needed');
  await f.update(); assert.equal(focused, 1, 'only once, not on every check');
  f.node('url-code').value = 'js7 fd'; f.node('url-code').handlers.input(); await tick();
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0, 'five characters: not yet');
  f.node('url-code').value = 'JS7 FDD'; f.node('url-code').handlers.input(); await tick();
  const sent = f.calls.filter(c => c.method === 'POST');
  assert.equal(sent.length, 1); assert.deepEqual(JSON.parse(sent[0].body), { code: 'JS7 FDD' });
});

test('a URL that connects while a new name is being typed does not fold the step away', async () => {
  const f = fixture(() => ({ savedUrl: 'https://example.closedhand.ai', state: 'on' }));
  f.node('url-rename-form').hidden = false;
  await f.update(); assert.equal(f.api.settled(), false);
  f.node('url-rename-form').hidden = true;
  await f.update(); assert.equal(f.api.settled(), true); assert.equal(f.changes(), 1);
});

test('a link that can come back by itself tells closedhand.com where setup is; an older one is opened as it is', async () => {
  const state = 'a'.repeat(32);
  const f = fixture(o => o.method === 'POST' ? { state: 'pairing', enabled: true, pairingUrl: 'https://closedhand.com/phone-access/pair#t=tk&state=' + state } : { state: 'off' });
  await f.update();
  await f.event('url-form', 'submit');
  assert.deepEqual(f.opened, ['https://closedhand.com/phone-access/pair#t=tk&state=' + state + '&back=' + encodeURIComponent('http://localhost:3000/setup') + '&popup=1']);
  // A blocked window falls back to this tab, which has nothing to close.
  const blocked = fixture(o => o.method === 'POST' ? { state: 'pairing', enabled: true, pairingUrl: 'https://closedhand.com/phone-access/pair#t=tk&state=' + state } : { state: 'off' });
  await blocked.update(); blocked.context.window.open = () => null;
  await blocked.event('url-form', 'submit');
  assert.deepEqual(blocked.opened, ['https://closedhand.com/phone-access/pair#t=tk&state=' + state + '&back=' + encodeURIComponent('http://localhost:3000/setup')]);
});
test('a code closedhand.com hands back is sent with its state once there is a password, and leaves the address bar', async () => {
  const state = 'b'.repeat(32);
  const f = fixture(o => o.body && JSON.parse(o.body).code ? { state: 'connecting', enabled: true } : { state: 'pairing', enabled: true, pairingUrl: 'https://closedhand.com/phone-access/pair#t=tk&state=' + state },
    { hash: '#claim=ABC123&state=' + state });
  assert.deepEqual(f.replaced, ['/setup'], 'the code does not stay in the address bar');
  await f.update('first', false);
  assert.equal(f.calls.length, 0, 'nothing before a password');
  await f.update();
  const claims = f.calls.filter(c => c.method === 'POST' && JSON.parse(c.body).code);
  assert.deepEqual(claims.map(c => JSON.parse(c.body)), [{ code: 'ABC123', state }]);
  await f.update();
  assert.equal(f.calls.filter(c => c.method === 'POST' && JSON.parse(c.body).code).length, 1, 'sent once');
});
test('anything else in the address is left alone', async () => {
  for (const hash of ['#claim=ABC123', '#claim=ABC12&state=' + 'c'.repeat(32), '#claim=ABC123&state=xyz', '#step-accounts=google']) {
    const f = fixture(() => ({ state: 'off' }), { hash });
    await f.update();
    assert.equal(f.replaced.length, 0, hash);
    assert.ok(f.calls.every(c => c.method === 'GET'), hash);
  }
});
test('with an account just connected, the claim signs in with that same account: one click', async () => {
  const state = 'c'.repeat(32);
  const f = fixture(o => o.method === 'POST' ? { state: 'pairing', enabled: true, pairingUrl: 'https://closedhand.com/phone-access/pair#t=tk&state=' + state } : { state: 'off' });
  await f.update(); f.api.update('first', true, { via: 'google', hint: 'sam@example.com' });
  assert.equal(f.node('url-start').textContent, 'Claim your personal URL', 'the button names what it does');
  await f.event('url-form', 'submit');
  assert.equal(f.opened.at(-1), 'https://closedhand.com/phone-access/pair#t=tk&state=' + state + '&back=' + encodeURIComponent('http://localhost:3000/setup') + '&popup=1&via=google&hint=' + encodeURIComponent('sam@example.com'));
  // The sign-in is in a window of its own; this page says where to look.
  assert.match(f.node('url-status').textContent, /window that opened/);
  assert.equal(f.node('url-start').textContent, 'Open the sign-in again');
});

test('the sign-in window closes itself once the claim is in, and stays open to show a refusal', async () => {
  const state = 'e'.repeat(32);
  const ok = fixture(o => o.method === 'POST' ? { state: 'pairing', enabled: true, ownershipConfirmed: true, addressName: 'amber-fox-42' } : { state: 'off' }, { hash: '#claim=ABC123&state=' + state + '&close=1' });
  await ok.update(); await tick();
  assert.equal(ok.context.window.closed, 1);
  const refused = fixture(o => o.method === 'POST' ? { error: 'That code has expired.' } : { state: 'off' }, { hash: '#claim=ABC123&state=' + state + '&close=1' });
  await refused.update(); await tick();
  assert.equal(refused.context.window.closed, 0);
  assert.match(refused.node('url-status').textContent, /expired/);
  // Setup reached in the same tab, with no window to close, never tries.
  const sameTab = fixture(o => o.method === 'POST' ? { state: 'pairing', enabled: true, ownershipConfirmed: true } : { state: 'off' }, { hash: '#claim=ABC123&state=' + state });
  await sameTab.update(); await tick();
  assert.equal(sameTab.context.window.closed, 0);
});

test('the paste-a-code box shows only where the code cannot come back by itself', async () => {
  const link = 'https://closedhand.com/phone-access/pair#t=tk&state=' + 'd'.repeat(32);
  const here = fixture(() => ({ state: 'pairing', enabled: true, pairingUrl: link }));
  await here.update();
  assert.equal(here.node('url-code-form').hidden, true, 'on this computer the code comes back by itself');
  assert.equal(here.node('url-start').textContent, 'Claim your personal URL');
  const remote = fixture(() => ({ state: 'pairing', enabled: true, pairingUrl: link }), { hostname: '192.168.1.20' });
  await remote.update();
  assert.equal(remote.node('url-code-form').hidden, false, 'opened from elsewhere, the code is pasted');
  const older = fixture(() => ({ state: 'pairing', enabled: true, pairingUrl: 'https://closedhand.com/phone-access/pair#ticket' }));
  await older.update();
  assert.equal(older.node('url-code-form').hidden, false, 'an older link still shows its code to paste');
});
