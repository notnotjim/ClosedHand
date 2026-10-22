// The phone's clock as a sign someone has moved: the web chat sends a
// phone's time zone when it opens, and when it changed after the saved place
// and runs on a different clock, the clock, quiet hours and reminders follow
// it, and Closedhand is told the place is probably out of date. Places and
// flights are invented; the zones are real, since clocks are checked.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zone = require('../lib/phone-zone');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const now = new Date('2026-09-12T07:00:00Z');
const saved = { name: 'Kestrel Bay', latitude: 13.75, longitude: 100.5, timezone: 'Asia/Bangkok', updated: '2026-09-08T09:00:00Z', source: 'browser' };
const phoneAt = (timezone, at) => ({ ...saved, deviceZone: { timezone, at } });

test('a phone on another clock since the place was saved has moved on; the same clock, an older change or no phone has not', () => {
  assert.equal(zone.movedZone(phoneAt('Asia/Tokyo', '2026-09-11T23:40:00Z'), now), 'Asia/Tokyo');
  assert.equal(zone.zoneOf(phoneAt('Asia/Tokyo', '2026-09-11T23:40:00Z'), now), 'Asia/Tokyo');
  assert.equal(zone.movedZone(phoneAt('Asia/Ho_Chi_Minh', '2026-09-11T23:40:00Z'), now), null, 'another name for the same clock');
  assert.equal(zone.movedZone(phoneAt('Asia/Tokyo', '2026-09-07T09:00:00Z'), now), null, 'changed before the place was saved');
  assert.equal(zone.movedZone(saved, now), null);
  assert.equal(zone.zoneOf(saved, now), 'Asia/Bangkok');
  assert.equal(zone.zoneOf(null, now), null);
  assert.equal(zone.movedZone(phoneAt('Not/AZone', '2026-09-11T23:40:00Z'), now), null);
});

test('the phone zone is written only when it changes, keeping when it first changed', () => {
  const first = zone.noteZone(saved, 'Asia/Tokyo', now);
  assert.deepEqual(first.deviceZone, { timezone: 'Asia/Tokyo', at: now.toISOString() });
  assert.equal(first.name, 'Kestrel Bay', 'the place itself stays');
  assert.equal(zone.noteZone(first, 'Asia/Tokyo', new Date('2026-09-13T07:00:00Z')), null);
  assert.equal(zone.noteZone(null, 'Asia/Tokyo', now), null, 'nothing saved to note it on');
  assert.equal(zone.noteZone(saved, 'Not/AZone', now), null);
});

test('quiet hours, reminders and the prompt clock follow a moved phone, and the newer of a landing and the phone wins', () => {
  const { getUserTimezone } = require('../lib/timezone');
  const { currentTimeContext } = require('../lib/time-context');
  assert.equal(getUserTimezone({ location: phoneAt('Asia/Tokyo', '2026-09-11T23:40:00Z') }), 'Asia/Tokyo');
  assert.equal(getUserTimezone({ location: saved }), 'Asia/Bangkok');
  const clock = currentTimeContext({ location: phoneAt('Asia/Tokyo', '2026-09-11T23:40:00Z') }, now);
  assert.equal(clock.timezone, 'Asia/Tokyo');
  assert.match(clock.text, /Asia\/Tokyo, from their phone's clock, which changed after their saved location of Kestrel Bay\): Saturday, 12 September 2026, 16:00/);
  const flight = { flightNumber: 'XY902', departure: { airport: 'BKK', tz: 'Asia/Bangkok', dateTime: '2026-09-12T01:00:00+07:00' }, arrival: { airport: 'ICN', tz: 'Asia/Seoul', dateTime: '2026-09-12T08:30:00+09:00' } };
  const facts = { 'flight-XY902-2026-09-12': { value: JSON.stringify(flight) } };
  const phoneLater = currentTimeContext({ facts, location: phoneAt('Asia/Singapore', '2026-09-12T02:00:00Z') }, now);
  assert.equal(phoneLater.timezone, 'Asia/Singapore', 'the phone changed after the landing');
  const landingLater = currentTimeContext({ facts, location: phoneAt('Asia/Singapore', '2026-09-11T20:00:00Z') }, now);
  assert.equal(landingLater.timezone, 'Asia/Seoul', 'the landing came after the phone changed');
});

test('the web chat sends the zone from phones only, before the weather loads, and the server keeps it and stops showing the old place', () => {
  const page = read('webapp/views/index.html');
  assert.match(page, /window\.matchMedia\('\(hover: none\) and \(pointer: coarse\)'\)\.matches/);
  assert.match(page, /fetch\('\/api\/here\/zone', \{ method: 'POST'/);
  assert.match(page, /noteZone\(\)\.then\(load, load\);/);
  const server = read('webapp/server.js');
  const route = server.slice(server.indexOf('app.post("/api/here/zone"'), server.indexOf('app.post("/api/here/unit"'));
  assert.match(route, /if \(!_validTz\(tz\)\) return res\.status\(400\)/);
  assert.match(route, /phoneZone\.noteZone\(data\?\.settings\?\.location, tz\);\n\s+if \(noted\) await patchSettings\(supabase, userId, \{ set: \{ location: noted \} \}\);/);
  assert.match(server, /if \(phoneZone\.movedZone\(loc\)\) return res\.json\(\{ location: null \}\);/);
  assert.equal((server.match(/phoneZone\.zoneOf\(/g) || []).length, 3, 'today, usage and goals follow it too');
  assert.match(read('lib/location.js'), /their phone's clock changed to \$\{moved\} after it was saved/);
  assert.equal(read('lib/phone-zone.js'), read('webapp/phone-zone.js'));
});
