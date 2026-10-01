// Explicit Mac integration test. Uses its own disk, token and synthetic data,
// never launches the app, Bridge, a real account or the user's database.
// node scripts/test-workspace-vm.js PATH_TO_HOST_CHECK_OPTIONS
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Workspace, guestJSON } = require('../desktop/workspace/host');

(async () => {
  const options = JSON.parse(await fsp.readFile(process.argv[2], 'utf8'));
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'ch-vm-integration-'));
  const outside = path.join(fixture, 'host-only.txt');
  await fsp.writeFile(outside, 'host unchanged');
  const legacy = path.join(fixture, 'legacy');
  const imported = 'imported-' + path.basename(fixture) + '.txt';
  await fsp.mkdir(legacy);
  await fsp.writeFile(path.join(legacy, imported), 'existing Workspace file');
  const large = crypto.randomBytes(4 * 1024 * 1024);
  const largeHash = crypto.createHash('sha256').update(large).digest('hex');
  await fsp.writeFile(path.join(legacy, imported + '.bin'), large);
  await fsp.symlink(outside, path.join(legacy, 'must-not-follow.txt'));
  options.legacy = legacy;
  // Ensure this run exercises import again, into a separate test disk only.
  await fsp.rm(path.join(options.directory, 'legacy-imported.json'), { force: true });
  let forwarded = 0;
  const gateway = http.createServer((req, res) => {
    assert.equal(req.url, '/gateway/api');
    assert.equal(req.headers['x-sandbox-token'], options.token);
    forwarded++; req.resume(); res.setHeader('Content-Type', 'application/json'); res.end('{"fixture":"connected service"}');
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  options.gatewayPort = gateway.address().port;
  const workspace = new Workspace(options);
  const api = http.createServer((req, res) => workspace.request(req, res).catch(error => { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }));
  api.on('upgrade', (req, socket, head) => workspace.upgrade(req, socket, head));
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${api.address().port}`;
  const call = (route, method = 'GET', body) => guestJSON(workspace.agentSocket, options.token, route, method, body, 30000);
  const run = async (language, code) => {
    const result = await call('/exec', 'POST', { language, code });
    assert.equal(result.exit_code, 0, result.stderr);
    return result.stdout;
  };
  try {
    const start = Date.now();
    await workspace.start();
    console.log('VM ready in', Date.now() - start, 'ms');
    assert.equal(workspace.state, 'running');
    assert.equal((await fetch(base + '/exec', { method: 'POST' })).status, 401);
    const checks = await run('python', `import os,pathlib,socket,urllib.request,json
assert os.uname().sysname == 'Linux'
assert os.getuid() == 1000
assert not pathlib.Path('/Users').exists()
assert not pathlib.Path(${JSON.stringify(outside)}).exists()
assert not any(k in os.environ for k in ['DATABASE_URL','BRIDGE_TOKEN','COOKIE_SECRET','WS_AUTH_SECRET','TOKEN_ENCRYPTION_KEY'])
assert pathlib.Path('/workspace/' + ${JSON.stringify(imported)}).read_text() == 'existing Workspace file'
assert not pathlib.Path('/workspace/must-not-follow.txt').exists()
assert urllib.request.urlopen('https://example.com',timeout=10).status == 200
try:
 socket.create_connection(('192.168.64.1',3000),2)
 raise AssertionError('Host network was reachable')
except OSError: pass
try:
 pathlib.Path('/app/cannot-write').write_text('no')
 raise AssertionError('The system disk was writable')
except OSError: pass
print('Filesystem, environment, network and migration boundaries passed')`);
    console.log(checks.trim());
    console.log((await run('python', `import requests
headers={'x-sandbox-token':${JSON.stringify(options.token)}}
r=requests.post('http://127.0.0.1:9001/gateway/api',json={},headers=headers,timeout=5)
assert r.json()['fixture']=='connected service'
assert requests.get('http://127.0.0.1:9001/health',headers=headers,timeout=5).status_code==403
assert requests.post('http://127.0.0.1:9001/bridge',json={},headers=headers,timeout=5).status_code==403
print('Guest gateway restricted to approved routes')`)).trim());
    assert.equal(forwarded, 1);
    console.log((await run('python', `from playwright.sync_api import sync_playwright
import pathlib,time
with sync_playwright() as p:
 browser=p.chromium.connect_over_cdp('http://127.0.0.1:9222')
 context=browser.contexts[0]
 context.add_cookies([{'name':'vm_test_cookie','value':'persists','domain':'vm-test.example','path':'/','expires':int(time.time())+86400}])
 page=context.new_page()
 page.goto('chrome://sandbox')
 report=page.inner_text('body')
 assert 'PID namespaces\\tYes' in report and 'Seccomp-BPF sandbox\\tYes' in report,report
 page.close()
 pathlib.Path('/workspace/vm-test-file.txt').write_text('persists')
print('Chromium namespace/seccomp sandbox active')`)).trim());

    // An npm lifecycle script gets the same boundary as ordinary code.
    await run('node', `const fs=require('fs');fs.writeFileSync('/workspace/package.json',JSON.stringify({name:'workspace-test',version:'1.0.0'}));fs.mkdirSync('/workspace/vm-test-package',{recursive:true});fs.writeFileSync('/workspace/vm-test-package/package.json',JSON.stringify({name:'workspace-isolation-fixture',version:'1.0.0',scripts:{install:'node install.js'}}));fs.writeFileSync('/workspace/vm-test-package/install.js',${JSON.stringify(`const fs=require('fs');try{fs.writeFileSync(${JSON.stringify(outside)},'escaped');process.exit(2)}catch{}fs.writeFileSync('/workspace/npm-isolated.txt','passed');`)});`);
    const install = await call('/packages/install', 'POST', { manager: 'npm', packages: ['/workspace/vm-test-package'] });
    assert.ok(install.installed?.length, JSON.stringify(install));
    await run('node', `if(require('fs').readFileSync('/workspace/npm-isolated.txt','utf8')!=='passed')process.exit(1);`);
    assert.equal(await fsp.readFile(outside, 'utf8'), 'host unchanged');
    console.log('Package install stays inside the VM');

    // Exercise the actual VNC WebSocket path through the host controller.
    const WebSocket = require('ws');
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(base.replace('http:', 'ws:') + '/desktop/vnc', { headers: { 'X-Sandbox-Token': options.token } });
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('VNC handshake timed out')); }, 10000);
      socket.once('message', data => { clearTimeout(timer); assert.match(data.toString(), /^RFB /); socket.close(); resolve(); });
      socket.once('error', error => { clearTimeout(timer); reject(error); });
    });
    console.log('Interactive browser transport passed');
    await new Promise(resolve => setTimeout(resolve, 300));

    const pid = (await run('node', `const c=require('child_process').spawn('sleep',['120'],{detached:true,stdio:'ignore'});c.unref();console.log(c.pid);`)).trim();
    workspace.lastUse = 0;
    await workspace.idle();
    assert.equal(workspace.state, 'running');
    await run('node', `process.kill(${Number(pid)},'SIGTERM')`);
    await new Promise(resolve => setTimeout(resolve, 300));
    workspace.lastUse = 0;
    await workspace.idle();
    assert.equal(workspace.state, 'sleeping');
    assert.equal(workspace.child, null);
    console.log('Idle shutdown waits for background work and releases the VM');

    const wake = Date.now();
    await workspace.start();
    console.log('VM wake in', Date.now() - wake, 'ms');
    console.log((await run('python', `from playwright.sync_api import sync_playwright
import pathlib,hashlib
assert pathlib.Path('/workspace/vm-test-file.txt').read_text()=='persists'
assert pathlib.Path('/workspace/' + ${JSON.stringify(imported)}).read_text()=='existing Workspace file'
assert hashlib.sha256(pathlib.Path('/workspace/' + ${JSON.stringify(imported + '.bin')}).read_bytes()).hexdigest()==${JSON.stringify(largeHash)}
with sync_playwright() as p:
 browser=p.chromium.connect_over_cdp('http://127.0.0.1:9222')
 assert any(c['name']=='vm_test_cookie' and c['value']=='persists' for c in browser.contexts[0].cookies('http://vm-test.example'))
print('Files and browser sign-ins survive controller idle/wake')`)).trim());
    console.log('All Workspace VM integration checks passed');
  } finally {
    await workspace.close(); api.closeAllConnections(); api.close(); gateway.closeAllConnections(); gateway.close();
    await fsp.rm(fixture, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
