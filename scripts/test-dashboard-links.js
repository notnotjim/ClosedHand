const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const root = path.join(__dirname, '..');
function load(file, dependencies = {}, extras = {}) {
  const context = { module: { exports: {} }, URL, URLSearchParams, console,
    process: { env: {} }, setInterval: () => ({ unref() {} }),
    require: name => { if (!(name in dependencies)) throw Error(name); return dependencies[name]; }, ...extras };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  return context.module.exports;
}
function config(values, env = {}) {
  const query = { select() { return this; }, eq() { return this; }, async single() {
    await new Promise(resolve => setImmediate(resolve));
    return { data: { settings: { self_host_config: values } } };
  } };
  return load('lib/config.js', { './db': { isDbConfigured: () => true, supabase: { from: () => query } },
    './admin': { getAdminUserId: () => 'test' } }, { process: { env } });
}
function links(conf) { return load('lib/dashboard-links.js', { './config': conf }); }
const phone = 'https://test-phone.trycloudflare.com';
test('first chat link awaits phone config, including a cold cache', async () => {
  const conf = config({ PHONE_ACCESS: '1', PHONE_ACCESS_URL: phone });
  assert.equal(await links(conf).dashboardUrl('whatsapp'), phone + '/dashboard#agents');
  assert.equal(await links(conf).dashboardUrl('telegram'), phone + '/dashboard#agents');
});
test('web stays relative and disabled phone access never emits localhost or stale URLs', async () => {
  const client = links(config({ PHONE_ACCESS_URL: phone }, { BASE_URL: 'http://localhost:3000' }));
  assert.equal(await client.dashboardUrl('web'), '/dashboard#agents');
  assert.equal(await client.dashboardUrl('whatsapp'), null);
  assert.match(await client.agentLinkNotice('whatsapp'), /Your phone/);
});
test('configured permanent HTTPS address wins over the temporary tunnel', async () => {
  const conf = config({ PHONE_ACCESS: '1', PHONE_ACCESS_URL: phone }, { WEBAPP_URL: 'https://my.example.com/' });
  assert.equal(await links(conf).dashboardUrl('telegram'), 'https://my.example.com/dashboard#agents');
});
test('unsafe or computer-only addresses are never sent to chat', async () => {
  for (const address of ['http://example.com', 'https://localhost:3000', 'https://127.0.0.1', 'https://192.168.1.3', 'https://bot', 'https://laptop.local', 'https://user:secret@example.com', 'https://example.com/?token=secret']) {
    assert.equal(await config({}, { WEBAPP_URL: address }).dashboardBase(), null, address);
  }
});
const flush = () => new Promise(resolve => setImmediate(resolve));
function tunnel(initial = {}) {
  const values = { ...initial }, children = [];
  const api = load('webapp/phone-access.js', {
    './config': { getConf: async key => values[key], setConf: async patch => Object.assign(values, patch) },
    child_process: { spawn() { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}; children.push(child); return child; } },
  }, { setTimeout: () => 1, clearTimeout() {}, console: { log() {}, error() {} } });
  return { api, values, children };
}
test('phone access requires a password on enable and on restart', async () => {
  const t = tunnel({ PHONE_ACCESS: '1', PHONE_ACCESS_URL: phone });
  await assert.rejects(t.api.enable(), /password/);
  await t.api.boot();
  assert.equal(t.children.length, 0);
  assert.equal(t.values.PHONE_ACCESS_URL, null);
});
test('phone URL is published only after connection, clears on failure and ignores old children', async () => {
  const t = tunnel({ DASHBOARD_PASSWORD_HASH: 'fixture' });
  await t.api.enable();
  const first = t.children[0];
  first.stderr.emit('data', 'https://test-phone.trycloud');
  first.stderr.emit('data', 'flare.com\n');
  await flush();
  assert.equal(t.values.PHONE_ACCESS_URL, null);
  first.stderr.emit('data', 'Registered tunnel connection');
  await flush();
  assert.equal(t.api.status().url, phone);
  await t.api.disable();
  await t.api.enable();
  const second = t.children[1];
  second.stderr.emit('data', 'https://new-phone.trycloudflare.com\nRegistered tunnel connection');
  await flush();
  first.emit('exit', 0);
  await flush();
  assert.equal(t.api.status().url, 'https://new-phone.trycloudflare.com');
  second.emit('error', Object.assign(new Error('missing binary'), { code: 'ENOENT' }));
  await flush();
  assert.equal(t.api.status().state, 'unavailable');
  assert.equal(t.values.PHONE_ACCESS_URL, null);
});
test('successful login preserves the Agents tab and rejects external redirects', async () => {
  const html = fs.readFileSync(path.join(root, 'webapp/views/login.html'), 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  for (const [next, expected] of [['/dashboard', '/dashboard#agents'], ['/dashboard?view=1', '/dashboard?view=1#agents'], ['//evil.example', '/#agents'], ['/\\evil.example', '/#agents']]) {
    let submit;
    const location = { origin: 'https://my.example.com', search: '?next=' + encodeURIComponent(next), hash: '#agents' };
    vm.runInNewContext(script, { URL, URLSearchParams, location,
      document: { getElementById: id => id === 'login-form' ? { addEventListener: (_, fn) => { submit = fn; } } : { style: {}, value: 'fixture' } },
      fetch: async () => ({ ok: true, json: async () => ({ success: true }) }) });
    submit({ preventDefault() {} });
    await flush();
    assert.equal(location.href, expected);
  }
});
