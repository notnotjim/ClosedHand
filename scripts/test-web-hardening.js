// The dashboard as anyone who can reach it sees it: through the personal URL,
// by a link on another site, or by a page the model wrote. Each test is a way
// in that was open and is now closed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const server = read('webapp/server.js');

test('every response says not to guess file types, not to send the address on, and not to be framed by other sites', () => {
  const top = server.slice(server.indexOf('const app = express();'), server.indexOf('app.use("/novnc"'));
  assert.match(top, /app\.disable\("x-powered-by"\);/);
  assert.match(top, /"X-Content-Type-Options": "nosniff"/);
  assert.match(top, /"Referrer-Policy": "same-origin"/);
  assert.match(top, /"Content-Security-Policy": "frame-ancestors 'self' https:\/\/web\.telegram\.org"/);
  assert.match(top, /publicHttps\(req\)\) res\.set\("Strict-Transport-Security"/);
});

test('a request that fails before its route gets a plain answer, never a stack trace or the text it sent', () => {
  const handler = server.slice(server.indexOf('app.use((err, req, res, next) => {'), server.indexOf('const server = app.listen('));
  assert.ok(handler.length > 0 && handler.length < 900, 'the error handler sits just before the listener');
  assert.doesNotMatch(handler, /err\.stack|err\.message|err\.body/);
  assert.match(handler, /console\.error\("\[http\]", req\.method, req\.path, err\.type \|\| err\.name \|\| "error"\);/);
  const after = server.slice(server.indexOf('const server = app.listen('));
  assert.doesNotMatch(after, /^app\.(get|post|put|patch|delete|use)\(/m, 'no route after it, so it catches them all');
});

test('words from the address bar reach a page as text', () => {
  const line = server.slice(server.indexOf('app.get("/line-setup-complete"'), server.indexOf('app.get("/line-setup-complete"') + 700);
  assert.match(line, /\.replace\(\/\[&<>"'\]\/g/);
  const delight = read('webapp/public/delight.js');
  const toast = delight.slice(delight.indexOf('toast: function (msg, type)'), delight.indexOf('// Auto-remove'));
  assert.match(toast, /text\.textContent = String\(msg\);/);
  assert.doesNotMatch(toast, /\+ msg \+/, 'the message is never joined into markup');
});

test('a page the model wrote runs sandboxed, with no reach into the dashboard or its sign-in', () => {
  const canvas = server.slice(server.indexOf('app.get("/canvas/:id"'), server.indexOf('app.get("/canvas/:id"') + 3000);
  assert.match(canvas, /"Content-Security-Policy", "sandbox allow-scripts /);
  assert.doesNotMatch(canvas, /allow-same-origin/);
  assert.doesNotMatch(canvas, /Cache-Control", "public/);
  const page = read('webapp/views/index.html');
  const open = page.slice(page.indexOf('function openCanvas('), page.indexOf('function openCanvas(') + 2000);
  assert.match(open, /frame\.setAttribute\('sandbox', 'allow-scripts /);
  assert.match(open, /frame\.srcdoc = /);
  assert.doesNotMatch(open, /allow-same-origin|createObjectURL|innerHTML = '<iframe/);
});

test('logos from connected services cannot run as the dashboard when opened on their own', () => {
  const logos = server.slice(server.indexOf('app.get("/storage/logos/*"'), server.indexOf('app.get("/storage/logos/*"') + 900);
  assert.match(logos, /res\.set\("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'"\);/);
});

test('every path sent to the Mac goes through macHomePath, never hand-escaped', () => {
  assert.doesNotMatch(server, /\.replace\(\/'\/g, "'\\\\''"\)[^\n]*\n[^\n]*\$HOME\//, 'no single-quote escaping feeding $HOME paths');
  assert.doesNotMatch(server, /"\$HOME\/\$\{/, 'no path pasted after $HOME');
  const uses = server.match(/const cleanPath = [^\n]+/g) || [];
  assert.ok(uses.length >= 7);
  for (const u of uses) assert.match(u, /^const cleanPath = macHomePath\(/, u);
});

test('a hostile file name reaches the shell as data, directly and inside bash -c', () => {
  const fn = server.slice(server.indexOf('function macHomePath('), server.indexOf('\n}\n', server.indexOf('function macHomePath(')) + 2);
  const macHomePath = new Function(fn + '; return macHomePath;')();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-home-'));
  try {
    fs.mkdirSync(path.join(home, 'Docs'));
    const names = ["Docs/Mum's birthday.txt", 'Docs/$(touch PWNED1).txt', 'Docs/`touch PWNED2`.txt', 'Docs/a"b.txt', 'Docs/back\\slash.txt'];
    for (const n of names) fs.writeFileSync(path.join(home, n), 'x');
    const env = { HOME: home, PATH: process.env.PATH };
    for (const n of names) {
      const direct = `test -f "${macHomePath(n)}" && echo FOUND`;
      const nested = `bash -c 'test -f "${macHomePath(n)}" && echo FOUND'`;
      assert.equal(cp.execSync(direct, { env, cwd: home, shell: '/bin/bash' }).toString().trim(), 'FOUND', n);
      assert.equal(cp.execSync(nested, { env, cwd: home, shell: '/bin/bash' }).toString().trim(), 'FOUND', n + ' (nested)');
    }
    assert.deepEqual(fs.readdirSync(home).filter((f) => f.startsWith('PWNED')), [], 'nothing in a name ran');
    assert.equal(macHomePath('~'), '$HOME');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a file from the Mac lands where the upload was asked for, never where the request says', () => {
  const upload = server.slice(server.indexOf('app.post("/api/bridge/file-upload"'), server.indexOf('app.post("/api/bridge/file-upload"') + 3000);
  assert.match(upload, /const destPath = tokenData\.destPath;/);
  assert.match(upload, /const isDir = tokenData\.isDir === true;/);
  assert.doesNotMatch(upload, /req\.body\.path/);
  assert.doesNotMatch(upload, /"\$\{destPath\}"|"\$\{parentDir\}"|"\$\{tmpTar\}"/, 'sandbox paths are single-quoted, not double');
});
