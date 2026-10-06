// Pulse knows what ClosedHand already did and which reminders are set, so it
// never contradicts the first or repeats the second.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pc = require('../lib/pulse-context');
function db(tables) {
  return { from(t) { const rows = tables[t] || []; let out = rows; const q = {
    select() { return q; }, eq(k, v) { out = out.filter((r) => r[k] === v); return q; }, in(k, v) { out = out.filter((r) => v.includes(r[k])); return q; },
    gte(k, v) { out = out.filter((r) => r[k] >= v); return q; }, order() { return q; }, limit() { return q; },
    then(res) { return Promise.resolve({ data: out, error: null }).then(res); } }; return q; } };
}
const now = Date.parse('2026-10-08T22:30:00Z'); // 05:30 on the 9th in Fixture Town (UTC+7)

test('reminders in the next day are found from their schedule, and cover their event', async () => {
  const d = db({ schedules: [
    { user_id: 'u', name: 'dentist-fixture', cron_expression: '30 7 9 10 *', timezone: 'Asia/Bangkok', run_once: true, enabled: true, event_at: '2026-10-09T02:00:00Z' },
    { user_id: 'u', name: 'far-off', cron_expression: '0 9 20 10 *', timezone: 'Asia/Bangkok', run_once: true, enabled: true },
    { user_id: 'u', name: 'archived', cron_expression: '0 8 9 10 *', timezone: 'Asia/Bangkok', enabled: true, archived_at: '2026-10-01' },
  ] });
  const r = await pc.remindersAhead(d, 'u', now);
  assert.deepEqual(r.map((x) => x.name), ['dentist-fixture']);
  assert.equal(r[0].at.toISOString(), '2026-10-09T00:30:00.000Z');
  assert.deepEqual(pc.reminderLines(r, 'Asia/Bangkok'), ['dentist-fixture: reminder at 07:30, for 09:00']);
  assert.equal(pc.coveredByReminder('2026-10-09T02:00:00Z', r), true);
  assert.equal(pc.coveredByReminder('2026-10-09T05:00:00Z', r), false);
});

test("what ClosedHand did lately comes from its finished jobs", async () => {
  const d = db({ agent_tasks: [
    { user_id: 'u', title: 'Move table to 7pm', result: 'Done. Your table at Harbour Grill is now 7:00 PM.[[next]]More.', status: 'completed', completed_at: '2026-10-08T20:00:00Z' },
    { user_id: 'u', title: 'Old', result: 'x', status: 'completed', completed_at: '2026-10-01T00:00:00Z' },
    { user_id: 'u', title: 'Running', result: null, status: 'running', completed_at: null },
  ] });
  const lines = await pc.recentActions(d, 'u', now);
  assert.deepEqual(lines, ['Move table to 7pm: Done. Your table at Harbour Grill is now 7:00 PM. More.']);
});

test('the screen and the writer are both given it', async () => {
  const { triage } = require('../lib/pulse-triage');
  let message = '';
  await triage({ items: ['EMAIL from a@example.test: x'], level: 'medium', known: ['Reminder already set: dentist-fixture: reminder at 07:30, for 09:00'], fallback: async (s, m) => { message = m; return '{"pulse":false}'; } });
  assert.match(message, /Already known \(an item these cover adds nothing unless it changes them\):\nReminder already set: dentist-fixture/);
  const pulse = fs.readFileSync(path.join(__dirname, '..', 'lib', 'pulse.js'), 'utf8');
  assert.match(pulse, /const upcomingEvents = \(soonEvents \|\| \[\]\)\.filter\(\(ev\) => !pulseContext\.coveredByReminder\(ev\.received_at, reminders\)\);/);
  assert.match(pulse, /WHAT CLOSEDHAND HAS ALREADY DONE for \$\{userName\} \(current, and newer than any email, draft or record that says otherwise/);
  assert.match(pulse, /REMINDERS ALREADY SET/);
  assert.match(pulse, /never call the entry wrong or "an hour off"/);
});
