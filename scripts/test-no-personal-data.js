// Nothing in the published code may carry a person's own details: no names,
// addresses, numbers or life details from anyone's real data. A short list of
// terms is checked here as hashes only, so this file does not itself publish
// what it guards against. Fixtures use invented people and example.com.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const GUARDED = new Set([
  '119c9ae6f9ca741b',
  'e7a4477ec945697c',
  'f9d21bf3a3148f4a',
  '2916fa2bb6128107',
  '7a48405626506b0c',
  '774cdcf33a1d33b7',
  'e7b6ed270027f972',
  '39cc87ee690c3256'
]);
const hash = term => crypto.createHash('sha256').update(term).digest('hex').slice(0, 16);
const BINARY = /\.(png|jpe?g|gif|webp|ico|icns|glb|dmg|woff2?|ttf|otf|mp3|wav|onnx|bin|zip|gz|pdf)$/i;

function terms(text) {
  const lower = text.toLowerCase();
  const found = new Set(lower.split(/[^a-z0-9]+/));
  for (const email of lower.match(/[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || []) found.add(email);
  for (const run of lower.replace(/[\s().+-]/g, '').match(/\d{10,15}/g) || []) found.add(run.slice(-10));
  return found;
}

test('no tracked file carries a guarded personal term', () => {
  const root = path.join(__dirname, '..');
  const files = execFileSync('git', ['ls-files'], { cwd: root }).toString().split('\n').filter(f => f && !BINARY.test(f));
  const hits = [];
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(path.join(root, file), 'utf8'); } catch (_) { continue; }
    if (text.includes('\u0000')) continue;
    for (const term of terms(text)) if (GUARDED.has(hash(term))) { hits.push(file); break; }
  }
  assert.deepEqual(hits, [], 'personal details found in these files');
});
