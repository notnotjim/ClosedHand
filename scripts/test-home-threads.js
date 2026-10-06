// From the home page, the open conversation is carried on only while recent,
// and a thread has one name everywhere.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'webapp', 'server.js'), 'utf8');

test('a thread without a title is named by the start of what was asked', () => {
  const start = server.indexOf('function threadDisplayTitle');
  const box = {};
  vm.runInNewContext(server.slice(start, server.indexOf('\n}\n', start) + 2) + '\nthis.f = threadDisplayTitle;', box);
  assert.equal(box.f('Trip plan', []), 'Trip plan');
  assert.equal(box.f(null, [{ role: 'assistant', content: 'Hi' }, { role: 'user', content: '[User uploaded file: a.csv] Which category costs the most?' }]), 'Which category costs the most?');
  assert.equal(box.f(null, []), 'New conversation');
  assert.ok(box.f(null, [{ role: 'user', content: 'word '.repeat(40) }]).length <= 61);
  assert.doesNotMatch(server, /"Untitled conversation"/);
});

test('the home page carries on only a recent conversation, and says so', () => {
  const page = fs.readFileSync(path.join(root, 'webapp', 'views', 'index.html'), 'utf8');
  assert.match(page, /<div class="hero-continuing" id="heroContinuing" hidden>Continuing <span id="heroContinuingName"><\/span>/);
  assert.match(page, /Date\.now\(\) - Date\.parse\(openT\.updated_at\) < 3 \* 3600000/);
  assert.match(page, /var startFresh = fromHome && window\._homeContinue === null;/);
  assert.match(page, /if \(fromHome && !startFresh\) drawEarlierMessages\(text\);/);
  assert.match(page, /if \(startFresh\) \{[\s\S]{0,200}fetch\('\/api\/threads\/new', \{ method: 'POST' \}\)/);
  assert.doesNotMatch(page, /\|\| 'Untitled'/);
  const conv = fs.readFileSync(path.join(root, 'lib', 'conversation.js'), 'utf8');
  assert.match(conv, /if \(!asked\.length && conversation\.filter\(m => m\.role === "user"\)\.length < 3\) return;/);
});
