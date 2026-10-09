// Signing in on the sandbox computer unlocks a lot, so it is offered early and
// where it's used: setup's closing screen, a strip on the sandbox browser
// saying what each sign-in unlocks, and a dot on the Computers tab until any
// site is signed in. Only yes or no about a sign-in leaves the sandbox.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const server = read('webapp/server.js');

test('sign-in pages open only from the fixed list, never an address given to it', () => {
  const route = server.slice(server.indexOf('app.post("/api/sandbox/sign-in"'), server.indexOf('app.get("/api/sandbox/vnc-token"'));
  assert.match(route, /const site = SIGN_IN_SITES\.find\(\(s\) => s\.id === String\(req\.body\?\.site \|\| ""\)\);/);
  assert.match(route, /if \(!site\) return res\.status\(400\)/);
  assert.doesNotMatch(route, /req\.body\??\.url/);
  const sites = server.slice(server.indexOf('const SIGN_IN_SITES = ['), server.indexOf('];', server.indexOf('const SIGN_IN_SITES = [')));
  for (const id of ['google', 'instagram', 'tiktok', 'x', 'facebook']) assert.match(sites, new RegExp(`id: "${id}"`));
  for (const url of sites.match(/url: "([^"]+)"/g)) assert.match(url, /url: "https:\/\//);
});

test('the sign-in check reports yes or no per site, never a cookie value', () => {
  const route = server.slice(server.indexOf('app.get("/api/sandbox/sign-ins"'), server.indexOf('app.post("/api/sandbox/sign-in"'));
  assert.match(route, /c\.get\('name'\)/);
  assert.doesNotMatch(route, /c\.get\('value'\)|\['value'\]|\.value\b/);
  assert.match(route, /print\('SIGNINS ' \+ json\.dumps\(\{s\['id'\]: any\(/);
});

test('the strip sits on the sandbox browser, and the tab carries a dot until a site is signed in', () => {
  const page = read('webapp/views/index.html');
  assert.ok(page.indexOf('id="monSignins"') < page.indexOf('<div id="monDesktop"'), 'directly above the browser it is about');
  assert.match(page, /tab\.classList\.toggle\('needs-signin', known && !any\)/);
  assert.match(page, /#tabComputers\.needs-signin::after/);
  assert.match(page, /'\/api\/sandbox\/sign-in', \{ method: 'POST'/);
});

test("setup's closing screen points to signing in on the sandbox computer", () => {
  const setup = read('webapp/views/setup.html');
  assert.match(setup, /<a class="done-signins-link" href="\/#computers">Sign in on the sandbox computer<\/a>/);
  assert.match(setup, /Closedhand's sandbox computer has its own browser\./);
});
