// The answer comes first and a page link after it; a job's answer gets a
// header only for an outcome that was really not met, named.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { linkLast } = require('../lib/page-link');

test('a page link moves after the answer, once', () => {
  assert.equal(linkLast('[Open the page](/page/abc)\n\n[[next]]\n\nPack light.\n\nTwo washes.\n\n[[next]]\n\nRain due.'),
    'Pack light.\n\nTwo washes.\n\n[[next]]\n\nRain due.\n\n[Open the page](/page/abc)');
  assert.equal(linkLast('Pack light.\n\n[Open the page](/page/abc)'), 'Pack light.\n\n[Open the page](/page/abc)');
  assert.equal(linkLast('Open the page: https://x.example/page/abc\n\nAnswer.'), 'Answer.\n\nOpen the page: https://x.example/page/abc');
  assert.equal(linkLast('Nothing to move.'), 'Nothing to move.');
  const engine = fs.readFileSync(path.join(__dirname, '..', 'lib', 'engine.js'), 'utf8');
  assert.ok(engine.indexOf('require("./page-link").linkLast(finalText)') < engine.indexOf('finalText = require("./follow-on").withBreaks(finalText);'));
});

test('the header names what was not done, and only when it was really not done', () => {
  const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  for (const m of ['../lib/llm', '../lib/agent-context', '../lib/task-evidence', '../lib/response-presentation', '../lib/dashboard-links', '../lib/follow-on', '../lib/task-model', '../lib/db', '../lib/messaging', '../lib/context', '../lib/storage', '../lib/user-mutex']) { try { stub(m, {}); } catch (_) {} }
  const { partialHeader } = require('../lib/task-delivery');
  const row = (verdict, status = 'partial') => ({ status, runtime: { verification: { verdict } } });
  assert.equal(partialHeader(row(null, 'completed')), '');
  assert.equal(partialHeader(row({ status: 'unavailable' })), '', 'a check that could not run is not a gap');
  assert.equal(partialHeader(row({ status: 'failed', retry: false, criteriaResults: [{ criterion: 'Booking moved', met: false }] })), '', 'an answer asking the person explains itself');
  assert.equal(partialHeader(row({ status: 'failed', retry: true, criteriaResults: [{ criterion: 'Booking moved to 7pm', met: false }, { criterion: 'Times given', met: true }] })), 'Not done yet: booking moved to 7pm.\n\n');
  assert.equal(partialHeader({ status: 'partial', runtime: { lastVerdict: { status: 'failed', criteriaResults: [{ criterion: 'Report sent', met: false }] } } }), 'Not done yet: report sent.\n\n');
});
