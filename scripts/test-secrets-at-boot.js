// ClosedHand stops at boot rather than run with secrets anyone could know:
// no encryption key means no sign-ins stored unencrypted, and a placeholder
// web chat secret means no forged tickets. The installers make real ones.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function freshCrypto(key) {
  const file = require.resolve('../crypto-tokens');
  delete require.cache[file];
  const saved = process.env.TOKEN_ENCRYPTION_KEY;
  if (key === undefined) delete process.env.TOKEN_ENCRYPTION_KEY; else process.env.TOKEN_ENCRYPTION_KEY = key;
  const mod = require('../crypto-tokens');
  return { mod, restore: () => { if (saved === undefined) delete process.env.TOKEN_ENCRYPTION_KEY; else process.env.TOKEN_ENCRYPTION_KEY = saved; delete require.cache[file]; } };
}

test('with no valid encryption key, ClosedHand refuses to start and never stores a sign-in in plain text', () => {
  for (const key of [undefined, '', 'not-a-key', crypto.randomBytes(24).toString('hex')]) {
    const { mod, restore } = freshCrypto(key);
    try {
      assert.throws(() => mod.assertReady(), /Refusing to start/, String(key));
      assert.throws(() => mod.encryptString('ya29.secret-token'), /Cannot encrypt/, String(key));
    } finally { restore(); }
  }
  assert.doesNotMatch(read('crypto-tokens.js'), /process\.env\.NODE_ENV/, 'no environment where plain text is allowed');
});

test('with a key, tokens round-trip, and a tampered value is refused, not half-read', () => {
  const { mod, restore } = freshCrypto(crypto.randomBytes(32).toString('base64'));
  try {
    mod.assertReady();
    const sealed = mod.encryptString('ya29.secret-token');
    assert.match(sealed, /^enc:v1:/);
    assert.equal(mod.decryptString(sealed), 'ya29.secret-token');
    const raw = Buffer.from(sealed.slice(7), 'base64');
    raw[raw.length - 1] ^= 1;
    assert.equal(mod.decryptString('enc:v1:' + raw.toString('base64')), null);
    const short = Buffer.concat([raw.subarray(0, 12), raw.subarray(12, 20)]);
    assert.equal(mod.decryptString('enc:v1:' + short.toString('base64')), null, 'a cut-down tag is not accepted');
  } finally { restore(); }
  for (const f of ['crypto-tokens.js', 'lib/assistant-email-protocol.js']) assert.match(read(f), /authTagLength: 16/, f);
});

test('a shared secret that is missing, short or an example value stops the start', () => {
  const { problem, requireSecret } = require('../lib/required-secrets');
  for (const bad of ['', 'fallback-dev-secret', 'change-me-dev-secret', 'change-me-sandbox-token', 'change-me-to-a-long-random-string', 'changeme', 'short-secret']) {
    assert.ok(problem('WS_AUTH_SECRET', bad), JSON.stringify(bad));
  }
  assert.equal(problem('WS_AUTH_SECRET', crypto.randomBytes(24).toString('hex')), null);
  const saved = process.env.WS_AUTH_SECRET;
  process.env.WS_AUTH_SECRET = 'change-me-dev-secret';
  try { assert.throws(() => requireSecret('WS_AUTH_SECRET'), /Refusing to start/); } finally {
    if (saved === undefined) delete process.env.WS_AUTH_SECRET; else process.env.WS_AUTH_SECRET = saved;
  }
});

test('both services check the web chat secret at boot, and no known fallback is left in the code', () => {
  assert.match(read('index.js'), /require\("\.\/crypto-tokens"\)\.assertReady\(\);\nrequire\("\.\/lib\/required-secrets"\)\.requireSecret\("WS_AUTH_SECRET"\);/);
  assert.match(read('webapp/server.js'), /require\("\.\/crypto-tokens"\)\.assertReady\(\);\nrequire\("\.\/required-secrets"\)\.requireSecret\("WS_AUTH_SECRET"\);/);
  for (const f of ['index.js', 'webapp/server.js', 'lib/web-chat-ws.js']) {
    assert.doesNotMatch(read(f), /fallback-dev-secret|change-me-sandbox-token|change-me-dev-secret/, f);
  }
  assert.match(read('lib/web-chat-ws.js'), /if \(!token \|\| !WS_AUTH_SECRET\) return null;/);
});

test('Docker will not start without the generated secrets', () => {
  const compose = read('docker-compose.yml');
  assert.doesNotMatch(compose, /\$\{(WS_AUTH_SECRET|SANDBOX_TOKEN|POSTGRES_PASSWORD):-/);
  for (const k of ['WS_AUTH_SECRET', 'SANDBOX_TOKEN', 'POSTGRES_PASSWORD']) assert.match(compose, new RegExp('\\$\\{' + k + ':\\?'));
});

test('the installer makes a real key even without openssl, and keeps .env to its owner', () => {
  const install = read('install.sh');
  assert.match(install, /setkey TOKEN_ENCRYPTION_KEY "\$\(openssl rand -base64 32 2>\/dev\/null \|\| head -c 32 \/dev\/urandom \| base64 \| tr -d '\\n'\)"/);
  assert.equal((install.match(/chmod 600 \.env/g) || []).length, 2, 'on first run and on every re-run');
});

test('the web chat socket needs the signed-in session as well as its ticket', () => {
  const server = read('webapp/server.js');
  const upgrade = server.slice(server.indexOf('if (url.pathname === "/chat") {'), server.indexOf('if (url.pathname === "/bridge") {'));
  assert.ok(upgrade.indexOf('hasAdminSession(req)') > 0 && upgrade.indexOf('hasAdminSession(req)') < upgrade.indexOf('proxyChatUpgrade('));
  assert.match(upgrade, /HTTP\/1\.1 401 Unauthorized/);
});
