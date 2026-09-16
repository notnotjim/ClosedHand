const { test } = require('node:test');
const assert = require('node:assert/strict');
const sw = require('../lib/sleep-watch');
test('a clock jump longer than the gap reads as sleep; a slow step does not', () => {
  const t0 = Date.now();
  assert.equal(sw.tick(t0), 0);
  assert.equal(sw.tick(t0 + 5000), 0, 'a normal tick');
  assert.equal(sw.tick(t0 + 5000 + 20000), 0, 'a slow step under the gap');
  const gap = sw.tick(t0 + 25000 + 600000);
  assert.ok(gap >= 600000, 'ten minutes asleep');
  assert.equal(sw.wokeWithin(90000), true);
});
test('a request that died on wake is tried once more; other failures are not', async () => {
  sw.tick(Date.now());
  let calls = 0;
  const again = async () => { calls++; return 'ok'; };
  const wakeErr = Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
  assert.equal(await sw.retryAfterWake(wakeErr, again, { pause: 1 }), 'ok');
  assert.equal(calls, 1);
  await assert.rejects(sw.retryAfterWake(new Error('The model provider returned HTTP 400.'), again, { pause: 1 }), /HTTP 400/);
  assert.equal(calls, 1, 'a provider refusal is not retried');
});
