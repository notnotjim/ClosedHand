// A message from the home page starts a new conversation; an older one is
// carried on by picking it under the box. A thread has one name everywhere.
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

test('the home page box always starts a new conversation; older ones are picked under it', () => {
  const page = fs.readFileSync(path.join(root, 'webapp', 'views', 'index.html'), 'utf8');
  assert.match(page, /var fromHome = !hasMessages;[\s\S]{0,400}var startFresh = fromHome;/);
  assert.match(page, /if \(startFresh\) \{\s*fetch\('\/api\/threads\/new', \{ method: 'POST' \}\)/);
  assert.doesNotMatch(page, /heroContinuing|_homeContinue|Start fresh|drawEarlierMessages/, 'no "Continuing" line or quiet-hours carry-on');
  assert.match(page, /or pick up where you left off/);
  assert.doesNotMatch(page, /\|\| 'Untitled'/);
  const conv = fs.readFileSync(path.join(root, 'lib', 'conversation.js'), 'utf8');
  assert.match(conv, /if \(!asked\.length && conversation\.filter\(m => m\.role === "user"\)\.length < 3\) return;/);
});
