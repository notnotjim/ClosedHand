const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stuckNote, failureSign } = require('../lib/stuck-tools');
const r = (s) => [{ type: 'tool_result', tool_use_id: 'x', content: s }];
test('the same failure three times running earns a stop note, six earns an answer-now note', () => {
  const streak = { sign: null, count: 0 };
  assert.equal(stuckNote(r('{"stdout":"status 429\\nToo Many Requests"}'), streak), null);
  assert.equal(stuckNote(r('{"stdout":"","exit_code":-1,"duration_ms":30056}'), streak), null, 'a different failure resets the streak');
  assert.equal(stuckNote(r('{"stdout":"","exit_code":-1}'), streak), null);
  assert.match(stuckNote(r('{"stdout":"","exit_code":-1}'), streak), /timing out, for the third iteration running/);
  assert.equal(stuckNote(r('{"stdout":"","exit_code":-1}'), streak), null);
  assert.equal(stuckNote(r('{"stdout":"","exit_code":-1}'), streak), null);
  assert.match(stuckNote(r('{"stdout":"","exit_code":-1}'), streak), /Make no more tool calls/);
  assert.equal(stuckNote(r('{"stdout":"CHRISTMAS PLACE -> 81"}'), streak), null, 'a success clears it');
  assert.equal(streak.count, 0);
});
test('signs are recognised in plain and JSON results', () => {
  assert.equal(failureSign(r('<h1>429 Too Many Requests</h1>')), 'the source is rate-limiting you');
  assert.equal(failureSign(r('{"error":"Request timed out after 20s"}')), 'the run is timing out');
  assert.equal(failureSign(r('{"stdout":"done 81 rows"}')), null);
});
