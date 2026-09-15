const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const assets = require('../webapp/assets');
const publicDir = path.join(__dirname, '..', 'webapp', 'public');
function hashOf(name) { return require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(publicDir, name))).digest('hex').slice(0, 12); }
function response(query) {
  const headers = {};
  return { req: { query }, set(k, v) { headers[k] = v; }, headers };
}
test('page references carry the hash of the file they point at', () => {
  const html = assets.stamp('<link href="/model-settings.css"><script src="/model-settings.js"></script>');
  assert.equal(html, '<link href="/model-settings.css?v=' + hashOf('model-settings.css') + '"><script src="/model-settings.js?v=' + hashOf('model-settings.js') + '"></script>');
});
test('outside files, missing files and other assets stay untouched', () => {
  const html = '<script src="https://cdn.example/lib.js"></script><script src="/missing.js"></script><img src="/logo.png"><a href="/dashboard.js/../x.css">';
  assert.equal(assets.stamp(html), html);
  assert.equal(assets.version('/../server.js'), null);
});
test('a changed file gets a new address', () => {
  const tmp = path.join(publicDir, 'tmp-stamp-test.js');
  try {
    fs.writeFileSync(tmp, 'one');
    const first = assets.version('/tmp-stamp-test.js');
    fs.writeFileSync(tmp, 'two!');
    const second = assets.version('/tmp-stamp-test.js');
    assert.notEqual(first, second);
    assert.equal(second, hashOf('tmp-stamp-test.js'));
  } finally { fs.rmSync(tmp, { force: true }); }
});
test('only the current hash earns a long-lived cache header', () => {
  const file = path.join(publicDir, 'model-settings.js');
  const current = response({ v: hashOf('model-settings.js') }); assets.cacheHeaders(current, file);
  assert.equal(current.headers['Cache-Control'], 'public, max-age=31536000, immutable');
  const stale = response({ v: 'abc' }); assets.cacheHeaders(stale, file);
  assert.equal(stale.headers['Cache-Control'], 'no-cache');
  const bare = response({}); assets.cacheHeaders(bare, file);
  assert.equal(bare.headers['Cache-Control'], 'no-cache');
});
test('every served page is stamped', () => {
  for (const name of fs.readdirSync(path.join(__dirname, '..', 'webapp', 'views')).filter(f => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'webapp', 'views', name), 'utf8');
    const sent = [];
    assets.sendPage({ type() { return this; }, send(body) { sent.push(body); } }, name);
    assert.equal(sent.length, 1);
    assert.doesNotMatch(sent[0], /(?:src|href)="\/[^"?#]+\.(?:js|css)"/, name + ' still has an unstamped local script or stylesheet');
    if (/(?:src|href)="\/[^"?#]+\.(?:js|css)"/.test(html)) assert.match(sent[0], /\?v=[0-9a-f]{12}"/);
  }
});
