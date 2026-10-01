// Trusted host controller. All browser/code/package execution happens in Linux.
// This process only installs a pinned disk, manages the VM and forwards traffic.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { installRuntime } = require('./runtime');
const { importLegacy } = require('./migrate');

function redactLogs(stream, token, write) {
  let line = '', dropping = false;
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    for (const part of chunk.match(/[^\n]*\n|[^\n]+$/g) || []) {
      if (!dropping) line += part;
      if (line.length > 65536) { line = ''; dropping = true; }
      if (part.endsWith('\n')) {
        write(dropping ? '[Workspace log line omitted]\n' : line.replaceAll(token, '[Workspace token]'));
        line = ''; dropping = false;
      }
    }
  });
  stream.on('end', () => { if (line && !dropping) write(line.replaceAll(token, '[Workspace token]')); });
}

function authorised(request, token) {
  const actual = Buffer.from(String(request.headers['x-sandbox-token'] || ''));
  const expected = Buffer.from(token);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}
function guestJSON(socketPath, token, route, method = 'GET', body, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: route, method, timeout,
      headers: { 'X-Sandbox-Token': token, 'Content-Type': 'application/json' } }, response => {
      let text = '';
      response.on('error', reject);
      response.on('data', chunk => { text += chunk; if (text.length > 1024 * 1024) request.destroy(new Error('Workspace response is too large.')); });
      response.on('end', () => {
        try { const value = JSON.parse(text); if (response.statusCode >= 400) throw new Error(value.error || 'Workspace request failed.'); resolve(value); }
        catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('Workspace did not answer.')));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

class Workspace {
  constructor(options) {
    this.options = options;
    this.state = 'sleeping';
    this.progress = 0;
    this.error = '';
    this.pending = null;
    this.child = null;
    this.active = 0;
    this.lastUse = Date.now();
    this.stopping = false;
  }
  status() {
    return { status: this.state, isolation: 'virtual-machine', progress: this.progress,
      error: this.error || undefined, message: this.error || (this.state === 'downloading'
        ? `Preparing Workspace, ${this.progress}%. You can keep using ClosedHand.`
        : this.state === 'starting' ? 'Starting Workspace…' : this.state === 'running' ? 'Ready' : 'Workspace starts when you need it.') };
  }
  start() {
    this.lastUse = Date.now();
    if (this.state === 'running') return Promise.resolve();
    if (this.pending) return this.pending;
    if (this.stopping) return Promise.reject(new Error('Workspace is closing. Try again in a moment.'));
    this.error = '';
    this.pending = this.boot().catch(async error => {
      this.error = error.message;
      this.state = 'error';
      await this.stopMachine();
      throw error;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
  async boot() {
    await this.stopMachine();
    this.state = 'downloading';
    const manifest = JSON.parse(await fsp.readFile(this.options.manifest, 'utf8'));
    const directory = await installRuntime(manifest, path.join(this.options.directory, 'runtime'), value => { this.progress = value; });
    if (this.stopping) throw new Error('Workspace is closing.');
    this.state = 'starting';
    const disk = path.join(this.options.directory, 'workspace.ext4');
    try {
      const fd = await fsp.open(disk, 'wx', 0o600);
      try { await fd.truncate(16 * 1024 ** 3); } finally { await fd.close(); }
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await fsp.lstat(disk);
    if (!stat.isFile() || stat.size < 1024 ** 3) throw new Error('The Workspace disk could not be opened. Your files have been kept.');
    this.sockets = await fsp.mkdtemp(path.join(os.tmpdir(), 'ch-vm-'));
    await fsp.chmod(this.sockets, 0o700);
    this.gateway = http.createServer((request, response) => this.forwardGateway(request, response));
    await new Promise((resolve, reject) => {
      this.gateway.once('error', reject);
      this.gateway.listen(path.join(this.sockets, 'gateway.sock'), resolve);
    });
    const config = path.join(this.sockets, 'config.json');
    await fsp.writeFile(config, JSON.stringify({ kernel: path.join(directory, 'kernel'), initrd: path.join(directory, 'initrd'),
      root: path.join(directory, 'root.ext4'), data: disk, sockets: this.sockets, memoryMiB: 2048 }), { mode: 0o600 });
    // An allowlist, not process.env: no provider, database or Bridge credentials.
    const child = spawn(this.options.helper, [config], {
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SANDBOX_TOKEN: this.options.token },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout.on('data', () => {});
    // Redact across chunk boundaries, including kernel argument logging.
    redactLogs(child.stderr, this.options.token, data => process.stderr.write(data));
    let exited = false;
    child.once('error', () => { exited = true; });
    child.once('exit', () => {
      exited = true;
      if (this.child === child) this.child = null;
      if (!this.stopping && this.state === 'running') {
        this.state = 'error'; this.error = 'Workspace stopped. Open it again to reconnect.';
      }
    });
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      if (exited) throw new Error('Workspace could not start. Your files have been kept.');
      let health;
      try {
        health = await guestJSON(this.agentSocket, this.options.token, '/health', 'GET', undefined, 1500);
      } catch { /* Guest kernel and browser are still starting. */ }
      if (health?.isolation === 'virtual-machine' && health.status === 'ok') {
        await importLegacy({ ...this.options, socket: this.agentSocket });
        this.state = 'running';
        this.lastUse = Date.now();
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    throw new Error('Workspace took too long to start. Your files have been kept.');
  }
  get agentSocket() { return path.join(this.sockets, 'agent.sock'); }
  forwardGateway(request, response) {
    // No arbitrary host URLs, paths or headers can cross this boundary.
    if (!authorised(request, this.options.token) || request.method !== 'POST' || !['/gateway/api', '/gateway/fetch'].includes(request.url)) {
      request.resume(); return json(response, 403, { error: 'This host request is not available to the Workspace.' });
    }
    const upstream = http.request({ hostname: '127.0.0.1', port: this.options.gatewayPort,
      path: request.url, method: 'POST', timeout: 45000,
      headers: { 'X-Sandbox-Token': this.options.token, 'Content-Type': 'application/json' } }, result => {
      response.writeHead(result.statusCode, { 'Content-Type': 'application/json' }); result.pipe(response);
      result.on('error', () => response.destroy());
    });
    upstream.on('error', () => { if (!response.headersSent) json(response, 502, { error: 'Connected services are not answering.' }); else response.destroy(); });
    upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
    request.on('aborted', () => upstream.destroy());
    let bytes = 0;
    request.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 ** 2) { upstream.destroy(); request.destroy(); } });
    request.pipe(upstream);
  }
  async request(request, response) {
    // Health polling never downloads, boots or keeps the VM alive.
    if (request.method === 'GET' && request.url === '/health') return json(response, 200, { ...this.status(), status: 'ok', workspace_status: this.state });
    if (!authorised(request, this.options.token)) { request.resume(); return json(response, 401, { error: 'Unauthorized' }); }
    if (request.url === '/runtime/start' && request.method === 'POST') {
      this.start().catch(() => {});
      return json(response, 200, this.status());
    }
    if (request.url === '/desktop/status' && request.method === 'GET' && this.state !== 'running') return json(response, 200, this.status());
    if (this.state !== 'running') {
      let timer;
      try {
        await Promise.race([this.start().catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, 12000); })]);
      } finally { clearTimeout(timer); }
      if (response.destroyed) return;
      if (this.state !== 'running') {
        request.resume();
        return json(response, 503, { ...this.status(), error: this.status().message });
      }
    }
    this.lastUse = Date.now(); this.active++;
    let finished = false;
    const finish = () => { if (!finished) { finished = true; this.active--; this.lastUse = Date.now(); } };
    response.once('close', finish);
    const upstream = http.request({ socketPath: this.agentSocket, path: request.url, method: request.method,
      headers: { ...request.headers, host: 'localhost', 'x-sandbox-token': this.options.token }, timeout: 130000 }, result => {
      response.writeHead(result.statusCode, result.headers); result.pipe(response);
      result.on('error', () => response.destroy());
    });
    upstream.on('error', () => {
      this.state = 'error'; this.error = 'Workspace disconnected. Try again.';
      if (!response.headersSent) json(response, 502, { error: this.error }); else response.destroy();
    });
    upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
    request.once('aborted', () => upstream.destroy());
    response.once('close', () => upstream.destroy());
    request.pipe(upstream);
  }
  upgrade(request, socket, head) {
    if (!authorised(request, this.options.token) || request.url !== '/desktop/vnc' || this.state !== 'running') {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
    }
    this.active++; this.lastUse = Date.now();
    const upstream = net.connect(path.join(this.sockets, 'desktop.sock'));
    upstream.once('connect', () => {
      // Forward only the WebSocket handshake, never host cookies or auth.
      const headers = ['GET / HTTP/1.1', 'Host: localhost', 'Connection: Upgrade', 'Upgrade: websocket'];
      for (const name of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol']) {
        if (request.headers[name]) headers.push(`${name}: ${request.headers[name]}`);
      }
      upstream.write(headers.join('\r\n') + '\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.once('close', () => { upstream.destroy(); this.active--; this.lastUse = Date.now(); });
    upstream.once('close', () => socket.destroy());
  }
  async idle() {
    if (this.stopping || this.pending || this.state !== 'running' || this.active || Date.now() - this.lastUse < 15 * 60 * 1000) return;
    try {
      const activity = await guestJSON(this.agentSocket, this.options.token, '/runtime/activity');
      if (activity.busy || this.active) return;
      this.state = 'stopping';
      this.pending = this.stopMachine().then(() => { this.state = 'sleeping'; }).finally(() => { this.pending = null; });
      await this.pending;
    } catch { /* Never stop work when its activity cannot be checked. */ }
  }
  async stopMachine() {
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
      });
    }
    if (this.gateway) { this.gateway.closeAllConnections(); this.gateway.close(); this.gateway = null; }
    if (this.sockets) { await fsp.rm(this.sockets, { recursive: true, force: true }); this.sockets = null; }
  }
  async close() { this.stopping = true; await this.stopMachine(); }
}

async function main() {
  const env = process.env;
  if (!/^[a-f0-9]{48}$/.test(env.SANDBOX_TOKEN || '')) throw new Error('Missing Workspace token.');
  const workspace = new Workspace({ token: env.SANDBOX_TOKEN, helper: env.WORKSPACE_VM_HELPER,
    directory: env.WORKSPACE_VM_DIRECTORY, legacy: env.WORKSPACE_LEGACY_DIRECTORY,
    manifest: path.join(__dirname, 'manifest.json'), gatewayPort: Number(env.WORKSPACE_GATEWAY_PORT) });
  await fsp.mkdir(workspace.options.directory, { recursive: true, mode: 0o700 });
  const server = http.createServer((request, response) => {
    workspace.request(request, response).catch(error => { request.resume(); if (!response.headersSent) json(response, 503, { error: error.message }); else response.destroy(); });
  });
  server.on('upgrade', (request, socket, head) => workspace.upgrade(request, socket, head));
  server.listen(Number(env.PORT), '127.0.0.1');
  const timer = setInterval(() => workspace.idle(), 60000);
  const shutdown = async () => { clearInterval(timer); server.close(); await workspace.close(); process.exit(0); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exit(1); });
module.exports = { Workspace, authorised, guestJSON, redactLogs };
