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
  assert.match(languageRule('What is on today?'), /in English\. Reply in English, whatever language earlier messages, names in it or what you find are in\./);
  assert.match(languageRule('ok'), /reply in the language their latest message is written in/);
});

test('a name in another script does not change the language the message is written in', () => {
  // An English question naming a Japanese gym was answered all in Japanese.
  assert.equal(messageLanguage('It\u2019s called this: サクラジム 梅田駅前店\n\nDid you search that? Because I just did and see some emails from them\u2026'), 'English');
  assert.equal(messageLanguage('Is 北京 nice this time of year?'), 'English');
  assert.equal(messageLanguage('Did you read Толстой at school?'), 'English');
  assert.equal(messageLanguage('Did you book 김민준 a table?'), 'English');
  assert.equal(messageLanguage('Did you book Phở Hùng for tonight?'), 'English');
  // And the other way round: an English name in a Japanese sentence.
  assert.equal(messageLanguage('この店 Blue Bottle はどう？'), 'Japanese');
  assert.equal(messageLanguage('iPhoneの新しいモデルはいつ発売されますか'), 'Japanese');
  assert.equal(messageLanguage('Какая погода завтра?'), 'Russian');
  assert.equal(messageLanguage('내일 비 와?'), 'Korean');
  // Written in two: the plain rule.
  assert.equal(messageLanguage('what does これは何ですか mean?'), null);
});

test('the chat, the background agent and the hand-off line all carry it', () => {
  const root = path.join(__dirname, '..', 'lib');
  const engine = fs.readFileSync(path.join(root, 'engine.js'), 'utf8');
  assert.match(engine, /const languageBlock = lastUserMessage \? "\\n" \+ require\("\.\/message-language"\)\.languageRule\(lastUserMessage\) : "";/);
  assert.match(engine, /projectsBlock \+ languageBlock \+/);
  assert.match(engine, /in first person and in the language of their request/);
  assert.match(fs.readFileSync(path.join(root, 'agents.js'), 'utf8'), /require\("\.\/message-language"\)\.languageRule\(/);
});
