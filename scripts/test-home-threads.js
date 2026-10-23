// The web chat has Chat, one general conversation, and each project's own,
// picked in the sidebar or under the home page's box. A message carries on
// the one that is open; nothing is split into threads by hand.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');

test('the home page box carries on Chat, or the project that is open; older ones are picked under it', () => {
  const page = fs.readFileSync(path.join(root, 'webapp', 'views', 'index.html'), 'utf8');
  assert.doesNotMatch(page, /startFresh|\/api\/threads|startNewThread|switchToThread/, 'no new thread from the home page, and no threads to switch');
  assert.match(page, /if \(_openProject\) payload\.project = _openProject\.id;/, 'a message sent in a project is in it');
  assert.doesNotMatch(page, /heroContinuing|_homeContinue|Start fresh|drawEarlierMessages/, 'no "Continuing" line or quiet-hours carry-on');
  assert.match(page, /<span>Pick up where you left off<\/span>/);
  assert.match(page, /fetch\('\/api\/conversations'\)[\s\S]{0,400}\[\{ id: null, name: 'Chat', updated_at: data\.chat\.updated_at, message_count: data\.chat\.message_count \}\]\.concat\(data\.projects \|\| \[\]\)/, 'Chat and the projects, most recent first');
  assert.match(page, /openConversation\(a\.getAttribute\('data-conv'\) \|\| null\);/);
  assert.match(page, /: _openProject && document\.body\.classList\.contains\('chat-active'\) \? 'Message ' \+ _openProject\.emoji \+ ' ' \+ _openProject\.name/, 'the box says which project it writes to');
  const conv = fs.readFileSync(path.join(root, 'lib', 'conversation.js'), 'utf8');
  assert.match(conv, /if \(!asked\.length && conversation\.filter\(m => m\.role === "user"\)\.length < 3\) return;/);
  const ws = fs.readFileSync(path.join(root, 'lib', 'web-chat-ws.js'), 'utf8');
  assert.match(ws, /const project = typeof msg\.project === "string" && \/\^\[0-9a-f-\]\{36\}\$\/i\.test\(msg\.project\) \? msg\.project : null;/);
});
