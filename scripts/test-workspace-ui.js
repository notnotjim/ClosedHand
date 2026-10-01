const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const server = fs.readFileSync(path.join(__dirname, '../webapp/server.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '../webapp/views/index.html'), 'utf8');
function section(source, from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start); return source.slice(start, end);
}
function response() {
  return { code: 200, status(code) { this.code = code; return this; }, sendStatus(code) { this.code = code; }, json(body) { this.body = body; } };
}

test('runtime preparation requires a signed-in user and accepts only status/start', async () => {
  let handler, calls = [], user = null;
  vm.runInNewContext(section(server, 'app.all("/api/sandbox/runtime",', 'app.post("/api/sandbox/browser",'), {
    app: { all(route, callback) { handler = callback; } }, process: { env: { WORKSPACE_VM: '1' } },
    getUserIdFromRequest: () => user, getSandboxInfo: async () => ({ port: 8181 }),
    sandboxFetch: async (info, method, route) => { calls.push({ method, route }); return { status: 'starting' }; },
  });
  let res = response(); await handler({ method: 'POST' }, res); assert.equal(res.code, 401); assert.equal(calls.length, 0);
  user = 'fixture'; res = response(); await handler({ method: 'DELETE' }, res); assert.equal(res.code, 405);
  res = response(); await handler({ method: 'GET' }, res); assert.equal(calls[0].route, '/desktop/status');
  res = response(); await handler({ method: 'POST' }, res); assert.equal(calls[1].route, '/runtime/start'); assert.equal(res.body.status, 'starting');
});

test('VNC waits for readiness and retains the native controller port and auth', async () => {
  let handler, status = 'downloading';
  const globals = {};
  const from = server.indexOf('app.get("/api/sandbox/vnc-token",');
  const source = server.slice(from, server.indexOf('\n});', from) + 4);
  vm.runInNewContext(source, {
    app: { get(route, callback) { handler = callback; } }, process: { env: { WORKSPACE_VM: '1' } }, global: globals, Date,
    crypto: require('node:crypto'), getUserIdFromRequest: () => 'fixture',
    getSandboxInfo: async () => ({ hostname: '127.0.0.1', port: 8181, token: 'fixture-secret' }),
    sandboxFetch: async () => ({ status }),
  });
  let res = response(); await handler({}, res); assert.equal(res.code, 202); assert.equal(res.body.token, undefined);
  status = 'running'; res = response(); await handler({}, res); assert.equal(res.code, 200);
  const value = globals._vncTokens[res.body.token];
  assert.equal(value.port, 8181); assert.equal(value.vm, true); assert.equal(value.sandboxToken, 'fixture-secret');
});

function prepare(states, visible = true, isVM = true) {
  let calls = [], messages = [];
  const context = { window: {}, document: { body: { classList: { contains: () => visible } } },
    setTimeout(fn) { fn(); }, fetch: async (url, options) => {
      calls.push(url);
      return { ok: true, json: async () => url === '/api/sandbox' ? { workspace_vm: isVM } : states.shift() };
    },
  };
  vm.runInNewContext(section(index, '  window.monPrepareWorkspace =', '  // Data loading'), context);
  return { run: () => context.window.monPrepareWorkspace(message => messages.push(message)), calls, messages };
}
test('Computers shows preparation progress then continues, without a new setup step', async () => {
  const ui = prepare([{ status: 'downloading', message: 'Preparing Workspace, 25%.' }, { status: 'starting', message: 'Starting Workspace…' }, { status: 'running' }]);
  assert.equal(await ui.run(), true); assert.equal(ui.messages.length, 2); assert.equal(ui.calls.length, 4);
  const docker = prepare([], true, false); assert.equal(await docker.run(), true); assert.equal(docker.calls.length, 1);
});
test('preparation stops polling offscreen and reports actionable failures', async () => {
  const hidden = prepare([{ status: 'starting' }], false); assert.equal(await hidden.run(), false); assert.equal(hidden.calls.length, 2);
  const broken = prepare([{ status: 'error', error: 'Free disk space to continue.' }]);
  await assert.rejects(broken.run(), /Free disk space/);
});
