// A sign-in page in the sandbox browser: the tool's own result tells the
// model to ask the person to sign in there, with the link, before anything else.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cfgPath = require.resolve('../lib/config');
require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: { dashboardBase: async () => 'https://bright-river-12.closedhand.ai' } };
const vm = require('node:vm');
const { isSignInPage, signInNote, signInQuestion, signInAnswer } = require('../lib/sign-in-wall');

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
  assert.equal((handlers.match(/await signInFound\(/g) || []).length, 2);
  assert.match(handlers, /if \(engine === "headless"\) await sandboxBrowse\(userId, \{ op: "step", engine: "visible", step: \{ action: "goto", url: page\.url \} \}, 20000\)/, "the page waits in the visible browser, where the person signs in");
  const defs = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tools', 'definitions.js'), 'utf8');
  assert.match(defs, /A page that asks to sign in means the person signs in there themselves, once, on the Computers tab of the web chat/);
  const agents = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agents.js'), 'utf8');
  assert.match(agents, /the job stops and asks them to, as the first way forward, and you carry on once they have/);
});

test('a job stopped on a sign-in page asks with the link, and understands done, no and not yet', async () => {
  const q = await signInQuestion('shop.example.com');
  assert.match(q, /^shop\.example\.com needs you signed in before I can carry on\. Sign in on Closedhand's sandbox computer: https:\/\/bright-river-12\.closedhand\.ai\/#computers\./);
  assert.match(q, /Reply done when you have, and I'll pick up where I left off\.$/);
  for (const t of ['done', 'Done!', 'signed in', "I've logged in now", 'ok']) assert.equal(signInAnswer(t), 'done', t);
  for (const t of ['no', 'skip it', "I can't", 'not now']) assert.equal(signInAnswer(t), 'no', t);
  for (const t of ['not yet', 'one sec', 'hold on, still signing in']) assert.equal(signInAnswer(t), 'wait', t);
  for (const t of ['what time is it in Testford?', 'thanks']) assert.equal(signInAnswer(t), null, t);
});

function loadConfirmation(pendings) {
  const conversation = [], resumed = [], ctx = { pendingConfirmations: pendings };
  const stub = new Proxy({}, { get: () => () => {} });
  const deps = {
    './context': ctx, './storage': { saveStore() {} }, './conversation': { getConversation: () => conversation },
    './tools/handlers': stub, './mcp': stub, './spend-guard': { ledgerUpdate: async () => {} }, './messaging': { sendTyping() {} },
    './confirmation-lifetime': require('../lib/confirmation-lifetime'), './sign-in-wall': require('../lib/sign-in-wall'),
    './agents': { resumeAgentAfterConfirmation: async (p, approved) => { resumed.push(approved); return approved ? 'Thanks, carrying on.' : "OK, I'll carry on without it."; } },
  };
  const context = { module: { exports: {} }, console, Date, require: (name) => { if (!(name in deps)) throw Error(name); return deps[name]; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'lib', 'confirmation.js'), 'utf8'), context);
  return { ...context.module.exports, ctx, conversation, resumed };
}

test('a reply to the sign-in question carries the job on, keeps it waiting, or is a new message', async () => {
  const waiting = () => ({ u1: { isAgent: true, kind: 'sign_in', site: 'shop.example.com', taskId: 't1', pausedAt: Date.now() } });
  let c = loadConfirmation(waiting());
  assert.equal(await c.handleConfirmation('u1', 'chat', 'not yet'), "OK, I'll wait. Reply done when you've signed in.");
  assert.ok(c.ctx.pendingConfirmations.u1, 'still waiting');
  assert.equal(await c.handleConfirmation('u1', 'chat', 'signed in'), 'Thanks, carrying on.');
  assert.deepEqual(c.resumed, [true]);
  assert.equal(c.ctx.pendingConfirmations.u1, undefined);
  assert.equal(c.conversation.at(-2).content, 'signed in', "the person's own words are kept");
  c = loadConfirmation(waiting());
  assert.equal(await c.handleConfirmation('u1', 'chat', 'skip it'), "OK, I'll carry on without it.");
  assert.deepEqual(c.resumed, [false]);
  c = loadConfirmation(waiting());
  assert.equal(await c.handleConfirmation('u1', 'chat', 'what time is it in Testford?'), false, 'anything else is a new message');
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
  for (const f of ['agents.js', 'projects.js', 'onboarding.js']) {
    assert.match(fs.readFileSync(path.join(lib, f), 'utf8'), /currentTimeContext\(/, f);
  }
});
