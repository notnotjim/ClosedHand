const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const crypto = require('node:crypto');
const { Workspace, guestJSON, redactLogs } = require('../desktop/workspace/host');
const { validateManifest, verifier } = require('../desktop/workspace/runtime');
const token = 'a'.repeat(48);
const file = { file: 'kernel', bytes: 3, sha256: crypto.createHash('sha256').update('abc').digest('hex'), url: 'https://example.com/kernel' };
const manifest = () => ({ arch: process.arch, version: 'a'.repeat(16), files: ['kernel', 'initrd', 'root.ext4.gz'].map(name => ({ ...file, file: name })), root: { ...file, file: 'root.ext4' } });
const sink = () => new Writable({ write(chunk, enc, done) { done(); } });

test('guest logs cannot leak a token split across chunks', async () => {
  const stream = Readable.from(['token=' + token.slice(0, 13), token.slice(13) + '\n', 'last=' + token]);
  let output = '';
  redactLogs(stream, token, value => { output += value; });
  await new Promise(resolve => stream.on('end', resolve));
  assert.equal(output, 'token=[Workspace token]\nlast=[Workspace token]');
});

test('an interrupted guest response rejects without crashing the controller', async t => {
  const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ch-http-'));
  const socket = path.join(directory, 'api');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
    res.write('{'); setTimeout(() => res.destroy(), 20);
  });
  await new Promise(resolve => server.listen(socket, resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  await assert.rejects(guestJSON(socket, token, '/health'), /aborted|reset/i);
});

test('runtime installation requires a pinned, correctly sized HTTPS payload', async () => {
  assert.equal(validateManifest(manifest()).arch, process.arch);
  for (const alter of [m => m.files[0].url = 'http://example.com/kernel', m => m.files.push({ ...file, file: '../config.env' }), m => m.arch = 'wrong', m => m.root.sha256 = 'unknown']) {
    const value = manifest(); alter(value); assert.throws(() => validateManifest(value));
  }
  await pipeline(Readable.from(['a', 'bc']), verifier(file), sink());
  await assert.rejects(pipeline(Readable.from(['abd']), verifier(file), sink()), /integrity/);
  await assert.rejects(pipeline(Readable.from(['ab']), verifier(file), sink()), /integrity/);
  await assert.rejects(pipeline(Readable.from(['abcd']), verifier(file), sink()), /size/);
});

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}
async function request(port, route, headers = {}, method = 'GET') {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers });
  return { status: response.status, data: await response.json() };
}

test('health polling stays asleep and unauthenticated requests cannot wake the VM', async t => {
  const workspace = new Workspace({ token });
  let starts = 0;
  workspace.start = () => { starts++; return Promise.resolve(); };
  const server = http.createServer((req, res) => workspace.request(req, res));
  const port = await listen(server); t.after(() => server.close());
  assert.equal((await request(port, '/health')).data.workspace_status, 'sleeping');
  assert.equal((await request(port, '/runtime/start', {}, 'POST')).status, 401);
  assert.equal((await request(port, '/exec', { 'x-sandbox-token': 'wrong' }, 'POST')).status, 401);
  assert.equal(starts, 0);
  await request(port, '/runtime/start', { 'x-sandbox-token': token }, 'POST');
  assert.equal(starts, 1);
});

test('concurrent requests share a single boot and a failed boot is recoverable', async () => {
  const workspace = new Workspace({ token });
  workspace.stopMachine = async () => {};
  let count = 0, finish;
  workspace.boot = () => { count++; return new Promise(resolve => { finish = resolve; }); };
  const first = workspace.start(), second = workspace.start();
  assert.equal(first, second); assert.equal(count, 1);
  finish(); await first;
  workspace.boot = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(workspace.start(), /disk unavailable/);
  assert.equal(workspace.state, 'error'); assert.equal(workspace.pending, null);
  workspace.boot = async () => { workspace.state = 'running'; };
  await workspace.start(); assert.equal(workspace.state, 'running');
});

test('the guest gateway forwards only authenticated POSTs to its two explicit routes', async t => {
  const received = [];
  const bot = http.createServer((req, res) => {
    received.push({ path: req.url, headers: req.headers }); req.resume();
    res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}');
  });
  const gatewayPort = await listen(bot); t.after(() => bot.close());
  const workspace = new Workspace({ token, gatewayPort });
  const gateway = http.createServer((req, res) => workspace.forwardGateway(req, res));
  const port = await listen(gateway); t.after(() => gateway.close());
  for (const route of ['/health', '/bridge', '/gateway/api?x=1', '/gateway/api/../fetch', '/gateway/fetch']) {
    assert.equal((await request(port, route, { 'x-sandbox-token': token })).status, 403);
  }
  assert.equal((await request(port, '/gateway/api', {}, 'POST')).status, 403);
  assert.equal(received.length, 0);
  for (const route of ['/gateway/api', '/gateway/fetch']) {
    assert.equal((await request(port, route, { 'x-sandbox-token': token, 'cookie': 'must-not-cross', 'authorization': 'must-not-cross' }, 'POST')).status, 200);
  }
  assert.equal(received.length, 2);
  assert.equal(received[0].headers.cookie, undefined);
  assert.equal(received[0].headers.authorization, undefined);
});
