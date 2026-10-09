// Logs are kept, and shared when reporting a bug, so they say how long a
// message was, never its words: a message can hold a password or a card
// number. MCP addresses, which can carry a key, are logged by host.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('peek gives the length only, unless a preview is switched on, and the preview masks digits and keys', () => {
  const { peek } = require('../lib/log-text');
  const saved = process.env.CLOSEDHAND_LOG_TEXT;
  try {
    delete process.env.CLOSEDHAND_LOG_TEXT;
    assert.equal(peek('my password is hunter22 and card 4111 1111 1111 1111'), '(52 chars)');
    assert.equal(peek(undefined), '(0 chars)');
    process.env.CLOSEDHAND_LOG_TEXT = '1';
    const shown = peek('card 4111 1111 1111 1111 key sk-abcdefghijklmnop1234', 80);
    assert.doesNotMatch(shown, /4111|sk-abc/);
    assert.match(shown, /\[digits\].*\[key\]/);
  } finally {
    if (saved === undefined) delete process.env.CLOSEDHAND_LOG_TEXT; else process.env.CLOSEDHAND_LOG_TEXT = saved;
  }
});

test('no log line prints the words of a message, transcript, search, goal or reply', () => {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(path.join(__dirname, '..', d), { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p);
    }
  };
  walk('lib');
  const words = /(text|transcript|userMessage|userText|finalText|query|goal|task_prompt|caption|body)\W{0,4}\)?\??\.(substring|slice)\(0,/;
  const found = [];
  for (const f of files) {
    read(f).split('\n').forEach((line, i) => {
      if (/console\.(log|info|warn|error)\(/.test(line) && words.test(line) && !/(e|err|error|last)\.message|errText|raw\b|String\(r(esult)?\.error\)/.test(line)) found.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(found, []);
});

test('MCP servers are logged by host, never by their full address', () => {
  const server = read('webapp/server.js');
  assert.doesNotMatch(server, /console\.\w+\([^\n]*row\.server_url\}/);
  assert.match(server, /function mcpHost\(url\) \{/);
});

test('a script for the sandbox is never left on disk when Python is not ready, and only its owner can read one', () => {
  const agent = read('sandbox-image/agent/server.js');
  const py = agent.slice(agent.indexOf('case "python": {'), agent.indexOf('case "node": {'));
  assert.ok(py.indexOf('if (pythonState !== "ready")') < py.indexOf('fs.writeFileSync(tmpFile'));
  assert.doesNotMatch(agent, /fs\.writeFileSync\(tmpFile, code\);/);
  assert.equal((agent.match(/fs\.writeFileSync\(tmpFile, code, \{ mode: 0o600 \}\);/g) || []).length, 3);
});

test('every sign-in event is logged once, with the address masked and nothing the visitor sent', () => {
  const server = read('webapp/server.js');
  const src = server.slice(server.indexOf('function maskedIp(ip) {'), server.indexOf('function signInRecord(what, req) {'));
  const maskedIp = new Function(src + '; return maskedIp;')();
  assert.equal(maskedIp('203.0.113.77'), '203.0.113.x');
  assert.equal(maskedIp('::ffff:198.51.100.9'), '198.51.100.x');
  assert.equal(maskedIp('2001:db8:85a3:8d3:1319:8a2e:370:7348'), '2001:db8:85a3:x');
  const record = server.slice(server.indexOf('function signInRecord(what, req) {'), server.indexOf('function noteWrongPassword('));
  assert.doesNotMatch(record, /req\.body|password\b(?! or)/i);
  const calls = server.match(/signInRecord\([^)]*\)/g) || [];
  for (const c of calls) assert.doesNotMatch(c, /req\.body|pass\b|pw\b|token/, c);
  const login = server.slice(server.indexOf('app.post("/api/login"'), server.indexOf('// --- Reach the dashboard from your phone'));
  for (const what of ['refused, too many tries', 'signed in', 'wrong password']) assert.ok(login.includes(`signInRecord("${what}", req)`), what);
  assert.ok(server.includes('signInRecord("signed out", req)'));
  assert.ok(server.includes('signInRecord("wrong password (Basic auth)", req)'));
});

test('an address is logged as where it goes, never its query, fragment or sign-in part', () => {
  const { peekUrl } = require('../lib/log-text');
  assert.equal(peekUrl('https://user:pw@api.example.test/v1/items?api_key=abc123#top'), 'https://api.example.test/v1/items');
  assert.equal(peekUrl('/v1/items?token=abc123'), '/v1/items');
  assert.equal(peekUrl('data:text/html;base64,PGgxPg=='), 'data:');
  assert.equal(peekUrl(undefined), '');
});

// Every log line in the services, so a new one that prints a whole address,
// a search's words or a Bridge pairing code fails here.
function logLines() {
  const files = ['index.js', 'user-store.js'];
  const walk = (d) => {
    for (const e of fs.readdirSync(path.join(__dirname, '..', d), { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.name === 'node_modules' || p.startsWith(path.join('webapp', 'public'))) continue;
      if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p);
    }
  };
  ['lib', 'webapp', path.join('sandbox-image', 'agent')].forEach(walk);
  const lines = [];
  for (const f of files) read(f).split('\n').forEach((line, i) => { if (/console\.(log|info|warn|error|debug)\(/.test(line)) lines.push({ at: `${f}:${i + 1}`, line }); });
  return lines;
}

test('no log line prints a whole address, which can carry a token in its query', () => {
  // Our own fixed addresses, and the personal URL, which has no query.
  const allowed = new Set(['BASE_URL', 'INTAKE_URL']);
  const found = logLines().filter(({ at, line }) => {
    const m = line.match(/\$\{\s*([\w.]*(?:url|Url|URL|href|Href))\s*\}/);
    return m && !allowed.has(m[1]) && !(at.startsWith(path.join('webapp', 'phone-access.js')) && /dashboard reachable at \$\{url\}/.test(line));
  }).map(({ at }) => at);
  assert.deepEqual(found, []);
  const handlers = read('lib/tools/handlers.js'), gateway = read('lib/gateway.js');
  assert.match(handlers, /\[browse\] \$\{action\}\$\{browseUrl \? " " \+ require\("\.\.\/log-text"\)\.peekUrl\(browseUrl\)/);
  assert.match(gateway, /\[gateway\/api\] \$\{method\} \$\{require\("\.\/log-text"\)\.peekUrl\(url\)\}/);
  assert.match(gateway, /\[gateway\/fetch\] \$\{method\} \$\{require\("\.\/log-text"\)\.peekUrl\(url\)\}/);
});

test('no log line prints the words of a mail search', () => {
  const found = logLines().filter(({ line }) => /\$\{(query|q|broader|searchQuery)\}/.test(line)).map(({ at }) => at);
  assert.deepEqual(found, []);
});

test('the Bridge pairing code is never logged, only that a Mac is waiting', () => {
  const server = read('webapp/server.js');
  const bridge = logLines().filter(({ at }) => at.startsWith(path.join('webapp', 'server.js')) || at.startsWith(path.join('lib', 'bridge-server.js')));
  for (const { at, line } of bridge) assert.doesNotMatch(line, /msg\.code|bridgeCode\}|pairing_code|key=\$\{key\}|\$\{code\.|\$\{row\.token|msg\.token\}|\.keys\(\)\](?!\.map\(bridgeKeyForLog\))/, at);
  const src = server.slice(server.indexOf('const bridgeKeyForLog'), server.indexOf('\n', server.indexOf('const bridgeKeyForLog')));
  const bridgeKeyForLog = new Function(src + '; return bridgeKeyForLog;')();
  assert.equal(bridgeKeyForLog('user:00000000-0000-4000-8000-000000000001'), 'user:00000000-0000-4000-8000-000000000001');
  assert.doesNotMatch(bridgeKeyForLog('K7QX2M'), /K7QX2M/);
  assert.match(server, /console\.log\("\[Bridge\] A Mac offered a pairing code; it works until that Mac disconnects"\);/);
});
