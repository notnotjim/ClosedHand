// Context Brain opens on the list with readable labels and no em dashes in its
// matters; a removed goal closes its matter; the person can say what they are called.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const dash = fs.readFileSync(path.join(root, 'webapp', 'views', 'dashboard.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'webapp', 'server.js'), 'utf8');

test('the list is the default view and profile facts are labelled by what they are', () => {
  assert.match(dash, /var _brainViewMode = 'list';/);
  assert.match(dash, /<button onclick="switchBrainView\('list'\)" class="brain-view-btn active"/);
  const labels = dash.slice(dash.indexOf('var PROFILE_LABELS'), dash.indexOf('\n', dash.indexOf('var PROFILE_LABELS')));
  const fn = dash.indexOf('function factLabel(n)');
  const box = {};
  vm.runInNewContext(labels + '\n' + dash.slice(fn, dash.indexOf('\n    }\n', fn) + 6) + '\nthis.f = factLabel;', box);
  assert.equal(box.f({ key: 'profile-name', subject: 'Sam Fixture' }), 'Name');
  assert.equal(box.f({ key: 'profile-email', subject: 'Sam Fixture' }), 'Email');
  assert.equal(box.f({ key: 'profile-location' }), 'Where you are');
  assert.equal(box.f({ key: 'person-mei', subject: 'Mei' }), 'Mei');
  assert.match(dash, />used ' \+ n\.accessCount \+ \(n\.accessCount === 1 \? ' time' : ' times'\)/);
});

test('matters are saved without em dashes, and a goal that ends closes its matter', () => {
  const matters = fs.readFileSync(path.join(root, 'lib', 'matters.js'), 'utf8');
  assert.match(matters, /const clean = \(x, n\) => noEmDashes\(String\(x\)\)\.slice\(0, n\);/);
  assert.match(matters, /t\.title = clean\(t\.title, 120\);/);
  assert.match(server, /if \(goal\) await closeGoalMatters\(userId, goal\.title\);/);
  assert.match(server, /if \(!error && \(patch\.status === "achieved" \|\| patch\.status === "dropped"\)\) await closeGoalMatters\(userId, goal\.title\);/);
});

test('the name Closedhand uses can be changed in Preferences', () => {
  assert.match(dash, /<label for="preferred-name">Closedhand calls you<\/label>/);
  assert.match(dash, /fetch\('\/api\/settings\/preferred-name'/);
  assert.match(server, /app\.post\("\/api\/settings\/preferred-name"/);
  assert.match(server, /if \(!name \|\| name\.length > 40\)/);
});
