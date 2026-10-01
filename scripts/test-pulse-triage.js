// Pulse's cheap screen: one short support-model call before the writer runs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { triage } = require('../lib/pulse-triage');
const items = ['EMAIL from alex@example.test: Please approve today\'s invoice', 'EVENT starting within 3h: Airport transfer'];

test('the support model gets the bar for the level and every item, in one short call', async () => {
  const calls = [];
  const verdict = await triage({ items, level: 'low', fallback: async (system, message, tokens) => {
    calls.push({ system, message, tokens }); return 'Sure: {"pulse": true, "flagged": ["Invoice due today"]}';
  } });
  assert.deepEqual(verdict, { pulse: true, flagged: ['Invoice due today'] });
  assert.equal(calls.length, 1);
  assert.match(calls[0].system, /Only flag genuinely urgent things/);
  assert.ok(items.every(item => calls[0].message.includes(item)));
  assert.equal(calls[0].tokens, 300);
});
test('an unreadable or empty reply means nothing to report', async () => {
  for (const raw of ['', 'no json here', '{not json', null]) {
    const verdict = await triage({ items, level: 'medium', fallback: async () => raw });
    assert.ok(!verdict.pulse && !(verdict.flagged || []).length, String(raw));
  }
});
test('an unknown level falls back to the medium bar, and nothing else is ever contacted', async () => {
  const realFetch = global.fetch; global.fetch = () => assert.fail('no network from the screen itself');
  try {
    let system = '';
    await triage({ items, level: 'loud', fallback: async s => { system = s; return '{"pulse":false,"flagged":[]}'; } });
    assert.match(system, /busy person would want a nudge/);
  } finally { global.fetch = realFetch; }
});
