// The reply follows the language of the latest message, not the conversation.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { messageLanguage, languageRule } = require('../lib/message-language');

test('clear cases are named, unclear ones get the plain rule', () => {
  assert.equal(messageLanguage('wats teh deal w my flite tmrw, wen shud i leev'), 'English');
  assert.equal(messageLanguage('Is it raining in Fixture Town right now?'), 'English');
  assert.equal(messageLanguage('Ngày mai trời có mưa không?'), 'Vietnamese');
  assert.equal(messageLanguage('明天会下雨吗'), 'Chinese');
  assert.equal(messageLanguage('ok'), null);
  assert.equal(messageLanguage('¿Va a llover mañana?'), null);
  assert.match(languageRule('What is on today?'), /in English\. Reply in English, whatever language earlier messages used\./);
  assert.match(languageRule('ok'), /reply in the language of their latest message/);
});

test('the chat, the background agent and the hand-off line all carry it', () => {
  const root = path.join(__dirname, '..', 'lib');
  const engine = fs.readFileSync(path.join(root, 'engine.js'), 'utf8');
  assert.match(engine, /const languageBlock = lastUserMessage \? "\\n" \+ require\("\.\/message-language"\)\.languageRule\(lastUserMessage\) : "";/);
  assert.match(engine, /mattersBlock \+ languageBlock \+/);
  assert.match(engine, /in first person and in the language of their request/);
  assert.match(fs.readFileSync(path.join(root, 'agents.js'), 'utf8'), /require\("\.\/message-language"\)\.languageRule\(/);
});
