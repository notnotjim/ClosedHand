// The dashboard and web chat details from the walkthrough, each held in place.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const dash = read('webapp/views/dashboard.html'), page = read('webapp/views/index.html'), server = read('webapp/server.js');

test('phones: the tab row says it scrolls, and pages keep a side margin', () => {
  assert.match(dash, /\.tab-bar\.more-right \{ -webkit-mask-image/);
  assert.match(dash, /bar\.classList\.toggle\('more-right', bar\.scrollLeft \+ bar\.clientWidth < bar\.scrollWidth - 4\)/);
  assert.match(dash, /@media \(max-width: 600px\) \{\n\s*\.dashboard-container \{ padding-left: 16px !important; padding-right: 16px !important; \}/);
});

test('a skill whose service is not connected says what it needs', () => {
  assert.match(dash, /'<span class="int-tag" title="Connect it below to use this skill">Needs ' \+ escHtml\(missingNames\.join\(' and '\)\)/);
  assert.match(dash, /if \(typeof renderConnectedSkills === 'function' && typeof _builtinSkills !== 'undefined' && _builtinSkills\.length\) renderConnectedSkills\(\);/);
});

test('the Computers tab does not call this computer offline', () => {
  assert.match(page, /var BRIDGE_PITCH = 'Closedhand already runs on this computer\. Bridge lets it open your Mac\\u2019s own files and apps too, on this Mac or another one\.';/);
  assert.match(page, /<span id="monLocalStatusText">Not connected<\/span>/);
  assert.doesNotMatch(page, /Mac running Docker/);
});

test('usage shows a cost from the prices the person enters', () => {
  assert.match(server, /app\.post\("\/api\/usage\/prices"/);
  assert.match(server, /res\.json\(\{ days, rows, prices: /);
  assert.match(dash, /function usageCost\(rows\)/);
  assert.match(dash, /Add their prices below to see what it costs\./);
});

test('wallet currency starts from the browser region', () => {
  const start = dash.indexOf('var REGION_CURRENCY'); const end = dash.indexOf('    function updateSpendCurrency');
  const box = { navigator: { languages: ['en-GB', 'en'] } };
  vm.runInNewContext(dash.slice(start, end) + '\nthis.f = defaultCurrency;', box);
  assert.equal(box.f(), 'GBP');
  box.navigator = { languages: ['fr'] };
  assert.equal(box.f(), 'USD');
});

test('a bare /dashboard opens the dashboard, and a missing page has a way back', () => {
  assert.match(dash, /window\.location\.replace\("\/\?dash=" \+ encodeURIComponent\(inner \|\| "#connections"\)\);/);
  assert.match(read('webapp/report-page.js'), /function missingHtml\(\)/);
  assert.match(server, /res\.status\(404\)\.send\(require\("\.\/report-page"\)\.missingHtml\(\)\);/);
});

test('goals, file search, progress lines, today and the Google card', () => {
  const goals = read('webapp/public/goals.js');
  assert.match(goals, /No goals yet\. One might be/);
  assert.match(goals, /if \(empty\) empty\.hidden = show;/);
  assert.match(page, /It recalls by meaning, not just keywords/);
  assert.match(page, /<button class="rag-upload-btn" id="ragQuickDrive" type="button" hidden>Search your Google Drive<\/button>/);
  const defs = require('../lib/tools/definitions');
  const tool = (n) => defs.INTERNAL_TOOLS.find((t) => t.name === n);
  assert.equal(tool('web_fetch').activityDescription({ url: 'https://nominatim.openstreetmap.org/search' }), 'Looking at the map');
  assert.equal(tool('api_request').activityDescription({ url: 'https://router.project-osrm.org/route', method: 'GET' }), 'Working out the route');
  assert.equal(tool('web_fetch').activityDescription({ url: 'https://www.example.org/a' }), 'Reading www.example.org');
  assert.match(server, /const todayStart = startOfTodayIn\(/);
  assert.match(dash, /const listsAccounts = c\.service === "google" \|\| c\.service === "microsoft";/);
});
