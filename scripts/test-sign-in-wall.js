// A sign-in page in the sandbox browser: the tool's own result tells the
// model to ask the person to sign in there, with the link, before anything else.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cfgPath = require.resolve('../lib/config');
require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: { dashboardBase: async () => 'https://bright-river-12.closedhand.ai' } };
const { isSignInPage, signInNote } = require('../lib/sign-in-wall');

test('sign-in pages are recognised, ordinary pages are not', () => {
  assert.equal(isSignInPage({ url: 'https://accounts.google.com/v3/signin/identifier?continue=https://www.google.com/maps/reserve/bookings', title: 'Sign in - Google Accounts' }), true);
  assert.equal(isSignInPage({ url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize' }), true);
  assert.equal(isSignInPage({ url: 'https://shop.example.com/account/login?next=/orders' }), true);
  assert.equal(isSignInPage({ url: 'https://example.com/', title: 'Log in to Example' }), true);
  assert.equal(isSignInPage({ url: 'https://www.google.com/maps/reserve/dine?m=x', title: 'Reserve with Google' }), false);
  assert.equal(isSignInPage({ url: 'https://blog.example.com/how-to-login-safely', title: 'Ten tips' }), false);
  assert.equal(isSignInPage({}), false);
});

test('the note asks the person to sign in, links where, and rules out the workarounds', async () => {
  const note = await signInNote({ url: 'https://accounts.google.com/v3/signin/identifier' });
  assert.match(note, /accounts\.google\.com/);
  assert.match(note, /https:\/\/bright-river-12\.closedhand\.ai\/#computers/);
  assert.match(note, /Offer this before any other way round it/);
  assert.match(note, /Never type their details, and never look for another way past the sign-in/);
});

test('the browser tool attaches the note on both of its return paths, and says so up front', () => {
  const handlers = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tools', 'handlers.js'), 'utf8');
  assert.equal((handlers.match(/sign_in_needed/g) || []).length, 2);
  const defs = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tools', 'definitions.js'), 'utf8');
  assert.match(defs, /A page that asks to sign in means the person signs in there themselves, once, on the Computers tab of the web chat/);
  const agents = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agents.js'), 'utf8');
  assert.match(agents, /ask them to, as the first way forward, and carry on once they have/);
});

// The agent once read "today" off the server's clock (UTC) while the person's
// day had already turned, and called the booking page's correct "Today" a trap.
test('every prompt that tells a model the date uses the person\'s own clock', () => {
  const lib = path.join(__dirname, '..', 'lib');
  const files = fs.readdirSync(lib).filter((f) => f.endsWith('.js')).map((f) => [f, fs.readFileSync(path.join(lib, f), 'utf8')]);
  for (const [f, src] of files) {
    assert.doesNotMatch(src, /Today is \$\{new Date\(/, f);
    assert.doesNotMatch(src, /Today is \$\{today\}/, f);
  }
  for (const f of ['agents.js', 'matters.js', 'onboarding.js']) {
    assert.match(fs.readFileSync(path.join(lib, f), 'utf8'), /currentTimeContext\(/, f);
  }
});
