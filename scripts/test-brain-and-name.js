// Context Brain opens on the list with readable labels; projects are named
// without em dashes; the person can say what they are called.
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
  assert.equal(box.f({ key: 'person-mei', subject: 'Mei' }), 'Mei');
  assert.match(dash, />used ' \+ n\.accessCount \+ \(n\.accessCount === 1 \? ' time' : ' times'\)/);
});

test('a project the background pass names is saved without em dashes, and goals are not offered as projects', () => {
  const projects = fs.readFileSync(path.join(root, 'lib', 'projects.js'), 'utf8');
  assert.match(projects, /const name = cleanText\(t\.name, 80\);/);
  assert.match(projects, /A personal goal or habit the user is setting for themselves \(getting fit, learning a language\) is not a new one: those are kept as goals\./);
});

test('the name Closedhand uses can be changed in Preferences', () => {
  assert.match(dash, /<label for="preferred-name">Closedhand calls you<\/label>/);
  assert.match(dash, /fetch\('\/api\/settings\/preferred-name'/);
  assert.match(server, /app\.post\("\/api\/settings\/preferred-name"/);
  assert.match(server, /if \(!name \|\| name\.length > 40\)/);
});
