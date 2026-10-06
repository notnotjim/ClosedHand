// Sums and comparisons in a chat answer are checked by code, not by the model,
// and only the wrong sentences change.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
let replies = [];
stub('../lib/llm', { getInternalClient: () => ({ client: {}, model: 'fixture' }) });
stub('../lib/task-model', { modelCall: async () => ({ content: [{ type: 'text', text: replies.shift() || '{}' }] }) });
const fc = require('../lib/figures-check');
const wrong = "Food, at £37.55, is ahead of Transport (£22.00), Books (£18.99) and Leisure (£11.00) combined on its own.";
const right = "Food, at £37.55, is more than Transport (£22.00) and well ahead of Books (£18.99) and Leisure (£11.00).";

test('the arithmetic is done in code', () => {
  assert.match(fc.judge({ left: [37.55], relation: '>', right: [22, 18.99, 11] }, wrong, ''), /less than 22 \+ 18\.99 \+ 11 = 51\.99/);
  assert.equal(fc.judge({ left: [37.55], relation: '>', right: [22, 18.99, 11] }, right, ''), null, 'not combined unless the sentence says so');
  assert.equal(fc.judge({ left: [37.55], relation: '>', right: [99] }, 'Food beats rent (£22.00).', 'Food 37.55'), null, 'a number nobody stated is ignored');
  assert.match(fc.judge({ part: 37.55, whole: 89.54, percent: 50 }, '37.55 is 50% of 89.54', ''), /41\.94%/);
  assert.equal(fc.judge({ part: 37.55, whole: 89.54, percent: 41.9 }, '37.55 is 41.9% of 89.54', ''), null);
});

test('only the sentence proved wrong is replaced', async () => {
  replies = [JSON.stringify({ claims: [{ sentence: wrong, left: [37.55], relation: '>', right: [22, 18.99, 11] }] }),
    JSON.stringify({ fixes: [{ wrong, right: 'Food, at £37.55, is the biggest single category, though less than the other three combined.' }] })];
  const out = await fc.correct({ userId: 'u', answer: wrong + '\n\nChart is on the canvas.', evidence: '' });
  assert.equal(out, 'Food, at £37.55, is the biggest single category, though less than the other three combined.\n\nChart is on the canvas.');
  replies = [JSON.stringify({ claims: [{ sentence: right, left: [37.55], relation: '>', right: [22, 18.99, 11] }] })];
  assert.equal(await fc.correct({ userId: 'u', answer: right, evidence: '' }), right, 'a right answer is left alone');
  replies = ['not json'];
  assert.equal(await fc.correct({ userId: 'u', answer: wrong, evidence: '' }), wrong, 'no verdict means as written');
});

test('it runs only on answers that compare figures, before the answer is sent', () => {
  assert.equal(fc.worthChecking(wrong), true);
  assert.equal(fc.worthChecking('Your flight leaves at 11:55.'), false);
  const engine = fs.readFileSync(path.join(__dirname, '..', 'lib', 'engine.js'), 'utf8');
  const at = engine.indexOf('figures.worthChecking(finalText)');
  assert.ok(at > 0 && at < engine.indexOf('finalText = require("./follow-on").withBreaks(finalText);'));
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'lib', 'tools', 'definitions.js'), 'utf8'), /This is the one source for weather/);
});
