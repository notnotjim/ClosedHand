const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const dashboard = fs.readFileSync(path.join(root, 'webapp/views/dashboard.html'), 'utf8');
const index = fs.readFileSync(path.join(root, 'webapp/views/index.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'webapp/server.js'), 'utf8');
function section(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, end);
  return source.slice(from, to);
}
function ui(data, ok = true) {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, {
      innerHTML: '', textContent: '', style: {}, value: '',
      classList: { contains: () => false, add() {}, remove() {} },
    });
    return nodes.get(id);
  };
  const context = vm.createContext({
    window: {}, document: { getElementById: get, querySelector: () => null },
    fetch: async () => ({ ok, json: async () => data }),
  });
  vm.runInContext(section(dashboard, '    async function loadBridgeStatus()', '    function toggleBridgeUnfurl()'), context);
  vm.runInContext(section(dashboard, '    async function openAppleModal()', '    function closeAppleModal()'), context);
  vm.runInContext(section(index, 'async function readMacAccessStatus()', 'function checkBridgeStatus()'), context);
  return { context, get };
}

test('Mac app uses built-in access for connected, reconnecting and unpaired states', async () => {
  for (const status of ['connected', 'reconnecting', 'not_paired']) {
    const { context, get } = ui({ desktop: true, status });
    await context.loadBridgeStatus();
    const html = get('bridge-standalone-card').innerHTML;
    assert.match(html, /Built into Closedhand for Mac/);
    assert.doesNotMatch(html, /disconnectBridge|>Shared<|Set up &#/);
    if (status !== 'connected') assert.doesNotMatch(html, />Connected</);
    await context.openAppleModal();
    assert.equal(get('apple-step-desktop').style.display, 'block');
    assert.equal(get('apple-step-setup').style.display, 'none');
  }
});

test('Docker keeps Bridge setup and disconnect, without invented permission states', async () => {
  for (const desktop of [false, undefined]) {
    const setup = ui({ desktop, status: 'not_paired' });
    await setup.context.loadBridgeStatus();
    assert.match(setup.get('bridge-standalone-card').innerHTML, /Set up &#/);
    await setup.context.openAppleModal();
    assert.equal(setup.get('apple-step-setup').style.display, 'block');
    const paired = ui({ desktop, status: 'reconnecting' });
    await paired.context.loadBridgeStatus();
    const html = paired.get('bridge-standalone-card').innerHTML;
    assert.match(html, /Reconnecting/);
    assert.match(html, /disconnectBridge/);
    assert.doesNotMatch(html, />Connected<|>Shared</);
  }
});

test('a failed status check never opens the Bridge installation steps', async () => {
  const { context, get } = ui({ desktop: true, status: 'unavailable' }, false);
  await context.openAppleModal();
  assert.equal(get('apple-step-setup').style.display, 'none');
  assert.match(get('apple-error').textContent, /Could not check/);
  const state = await context.readMacAccessStatus();
  assert.equal(state.desktop, true);
  assert.equal(context.macAccessHelp(state).setup, undefined);
});

test('file errors show recovery for existing access and setup only for an unpaired Bridge', async () => {
  for (const data of [
    { desktop: true, status: 'not_paired' },
    { desktop: true, status: 'connected' },
    { desktop: false, status: 'connected' },
    { desktop: false, status: 'reconnecting' },
    { desktop: false, status: 'not_paired' },
    { status: 'unavailable' },
  ]) {
    const { context, get } = ui(data);
    Object.assign(context, {
      navigator: { userAgent: 'Macintosh' },
      _monLocalPath: '~', monLocalCrumb() {}, _monSnapshotState() {},
      fetch: async url => ({ ok: url === '/api/bridge/status', json: async () => data }),
    });
    vm.runInContext(section(index, '  async function monLoadLocal()', '  async function monLoadStorage()'), context);
    await context.monLoadLocal();
    const html = get('monLocalFiles').innerHTML;
    if (!data.desktop && data.status === 'not_paired') {
      assert.match(html, /Download Closedhand Bridge/);
      assert.match(html, /Enter pairing code/);
    } else {
      assert.match(html, /Try again/);
      assert.doesNotMatch(html, /ClosedHandBridge.dmg|Enter pairing code/);
    }
  }
});

test('status distinguishes live connections, missing pairings and database failures', async () => {
  const source = section(server, 'app.get("/api/bridge/status",', '// Disconnect bridge');
  for (const desktop of [false, true]) {
    for (const scenario of ['missing', 'live', 'reconnecting', 'error']) {
      let handler, body, code = 200;
      const query = {
        select() { return this; }, eq() { return this; },
        async single() {
          if (scenario === 'error') return { error: { code: '08006' } };
          if (scenario === 'missing') return { data: null, error: { code: 'PGRST116' } };
          return { data: { status: 'connected' } };
        },
      };
      vm.runInNewContext(source, {
        app: { get(_route, fn) { handler = fn; } },
        process: { env: desktop ? { CLOSEDHAND_DESKTOP: '1' } : {} },
        getUserIdFromRequest: () => 'test',
        supabase: { from: () => query },
        bridgeConnections: new Map(scenario === 'live' ? [['user:test', { readyState: 1 }]] : []),
      });
      await handler({}, { status(n) { code = n; return this; }, json(value) { body = value; } });
      assert.equal(body.status, { missing: 'not_paired', live: 'connected', reconnecting: 'reconnecting', error: 'unavailable' }[scenario]);
      assert.equal(code, scenario === 'error' ? 503 : 200);
      if (source.includes('CLOSEDHAND_DESKTOP')) assert.equal(body.desktop, desktop);
    }
  }
});

test('a Bridge pairing code lasts ten minutes on the Mac and on the dashboard', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'webapp', 'server.js'), 'utf8');
  assert.match(server, /const BRIDGE_PAIR_CODE_MS = 10 \* 60 \* 1000;/);
  assert.match(server, /ws\.bridgeCodeAt = Date\.now\(\);/, 'when the Mac offered its code');
  assert.match(server, /if \(key\.startsWith\("user:"\) \|\| !ws\.bridgeCodeAt \|\| Date\.now\(\) - ws\.bridgeCodeAt <= BRIDGE_PAIR_CODE_MS\) continue;\n\s*bridgeConnections\.delete\(key\);/, 'a code shown too long stops working');
  assert.match(server, /ws\.send\(JSON\.stringify\(\{ type: "error", message: "That pairing code ran out\. Pair again for a new one\." \}\)\)/, 'and the Bridge app starts over');
  assert.match(server, /if \(Date\.now\(\) - Date\.parse\(row\.paired_at \|\| 0\) > BRIDGE_PAIR_CODE_MS\) \{\n\s*const \{ error: expireError \} = await supabase\.from\("user_bridges"\)\.delete\(\)\.eq\("user_id", row\.user_id\)\.eq\("status", "pending_pair"\);/, 'a request typed on the dashboard waits ten minutes, not forever');
  const swift = fs.readFileSync(path.join(__dirname, '..', 'bridge-app', 'Sources', 'BridgeManager.swift'), 'utf8');
  assert.match(swift, /case "error":[\s\S]{0,200}pairingCode = ""/, 'the Mac app clears its code on "error"');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'lib', 'bridge-server.js'), 'utf8'), /Date\.now\(\) - entry\.timestamp <= 10 \* 60 \* 1000/);
});
