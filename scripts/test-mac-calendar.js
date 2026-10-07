// The Mac's calendar comes from Bridge's calendar.list: the calendar store
// itself when Bridge has Calendar access (EventKit), the Calendar app when it
// hasn't. The sync and live lookups once sent their own AppleScript through
// shell.run, launching Calendar and waiting most of a minute, or ran an
// icalBuddy binary nothing built. And macOS refuses Calendar access to an app
// that doesn't say why, which is why EventKit never worked.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function withBridge(answer, run) {
  const relay = require.resolve('../lib/services/bridge-relay');
  const calls = [];
  require.cache[relay] = { id: relay, filename: relay, loaded: true, exports: { bridgeRequest: async (...args) => { calls.push(args); return answer; } } };
  delete require.cache[require.resolve('../lib/services/mac-calendar')];
  try { return run(require('../lib/services/mac-calendar'), calls); }
  finally { delete require.cache[relay]; delete require.cache[require.resolve('../lib/services/mac-calendar')]; }
}

test('events from the calendar store keep their own id, exact times and attendees', async () => {
  await withBridge([{ id: 'ABC@2026-10-09T19:00:00+08:00', title: 'Dinner with Sam', start: '2026-10-09T19:00:00+08:00', end: '2026-10-09T21:00:00+08:00', all_day: false, location: "Rosa's", calendar: 'Home', notes: 'Table\nby the window', attendees: ['Sam Example'] }], async (cal, calls) => {
    const [e] = await cal.readMacCalendar('u1', { daysBack: 90, daysAhead: 180 });
    assert.deepEqual(calls[0].slice(1, 3), ['calendar.list', { days_back: 90, days_ahead: 180 }], 'asks Bridge, not the shell');
    assert.equal(e.id, 'ABC@2026-10-09T19:00:00+08:00');
    assert.equal(e.start, '2026-10-09T19:00:00+08:00');
    assert.equal(e.description, 'Table by the window');
    assert.deepEqual(e.attendees, ['Sam Example']);
  });
});

test('the Calendar app fallback still gives every event an id', async () => {
  await withBridge([{ title: 'Dentist', start: 'Thursday, 8 October 2026 at 10:00:00', end: 'Thursday, 8 October 2026 at 10:30:00', calendar: 'Work' }], async (cal) => {
    const [e] = await cal.readMacCalendar('u1');
    assert.match(e.id, /^mac_0_Dentist/);
    assert.equal(e.end, 'Thursday, 8 October 2026 at 10:30:00');
  });
});

test('a Bridge that cannot answer is an error, not an empty calendar', async () => {
  await withBridge({ error: 'not connected' }, async (cal) => {
    await assert.rejects(cal.readMacCalendar('u1'), /not connected/);
  });
});

test('no calendar reading through shell scripts or icalBuddy is left', () => {
  for (const f of ['lib/services/data-sync.js', 'lib/services/data-access.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /icalBuddy/, f);
    assert.doesNotMatch(src, /tell application "Calendar"/, f);
    assert.match(src, /readMacCalendar/, f);
  }
});

test('both Mac apps say why they ask for Calendar, Reminders and Contacts', () => {
  for (const f of ['desktop/Info.plist', 'bridge-app/Info.plist']) {
    const plist = read(f);
    for (const key of ['NSCalendarsFullAccessUsageDescription', 'NSRemindersFullAccessUsageDescription', 'NSContactsUsageDescription']) assert.match(plist, new RegExp(`<key>${key}</key><string>[^<]{20,}</string>`), `${f}: ${key}`);
  }
  assert.match(read('bridge-app/Sources/Bridges/CalendarBridge.swift'), /EKEventStore\.authorizationStatus\(for: \.event\) == \.fullAccess/);
});

test('the Bridge download is built by a script, not by hand', () => {
  const script = read('bridge-app/build.sh');
  assert.match(script, /bridge-app\/build\.sh/);
  assert.match(script, /"\$HERE\/Info\.plist"/);
  assert.match(script, /webapp\/public\/download\/ClosedHandBridge\.dmg/);
});
