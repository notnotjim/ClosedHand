// All-day events are handed to the model by their last day: calendars write
// the end as the day after, so a stay to 7 October read as "until 8 October".
// Events still going on count as part of the dates asked about, and place
// names come back in English.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const dates = require("../lib/calendar-dates");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

test("a Google all-day event ends on its last day, not the day after", () => {
  const stay = { start: { date: "2026-09-16" }, end: { date: "2026-10-08" } };
  assert.deepEqual(dates.googleEventTimes(stay), { start: "2026-09-16", end: "2026-10-07", all_day: true });
  assert.deepEqual(dates.googleEventTimes({ start: { date: "2026-10-03" }, end: { date: "2026-10-04" } }), { start: "2026-10-03", end: "2026-10-03", all_day: true });
  assert.deepEqual(dates.googleEventTimes({ start: { date: "2026-10-03" } }), { start: "2026-10-03", end: "2026-10-03", all_day: true });
  const timed = { start: { dateTime: "2026-10-09T19:00:00+08:00" }, end: { dateTime: "2026-10-09T21:00:00+08:00" } };
  assert.deepEqual(dates.googleEventTimes(timed), { start: "2026-10-09T19:00:00+08:00", end: "2026-10-09T21:00:00+08:00" });
  assert.equal(dates.dayBefore("2026-03-01"), "2026-02-28");
});

test("an Outlook all-day event ends on its last day too", () => {
  const stay = { isAllDay: true, start: { dateTime: "2026-09-16T00:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-10-08T00:00:00.0000000", timeZone: "UTC" } };
  assert.deepEqual(dates.outlookEventTimes(stay), { start: "2026-09-16", end: "2026-10-07", all_day: true });
  const timed = { start: { dateTime: "2026-10-09T11:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-10-09T12:00:00.0000000", timeZone: "UTC" } };
  assert.deepEqual(dates.outlookEventTimes(timed), { start: "2026-10-09T11:00:00.0000000Z", end: "2026-10-09T12:00:00.0000000Z" });
});

test("the calendar copy shows last days and keeps what it does not recognise", () => {
  assert.deepEqual(dates.shownTimes({ summary: "Stay", start: "2026-09-16", end: "2026-10-08" }), { summary: "Stay", start: "2026-09-16", end: "2026-10-07", all_day: true });
  const timed = { start: "2026-10-09T19:00:00+08:00", end: "2026-10-09T21:00:00+08:00" };
  assert.equal(dates.shownTimes(timed), timed);
});

test("every place events reach the model reads them through the helper", () => {
  assert.match(read("lib/services/data-access.js"), /\.\.\.require\("\.\.\/calendar-dates"\)\.googleEventTimes\(e\)/);
  assert.match(read("lib/services/data-access.js"), /\.\.\.require\("\.\.\/calendar-dates"\)\.outlookEventTimes\(e\)/);
  assert.match(read("lib/services/data-access.js"), /\$select=id,subject,start,end,isAllDay,/);
  assert.equal((read("lib/tools/handlers.js").match(/\.\.\.require\("\.\.\/calendar-dates"\)\.googleEventTimes\(result\)/g) || []).length, 2, "create and update results");
  assert.match(read("lib/onboarding.js"), /\.\.\.require\("\.\/calendar-dates"\)\.googleEventTimes\(e\)/);
  const sync = read("lib/services/data-sync.js");
  assert.match(sync, /\.map\(evt => evt\._cache_source === "mac_calendar" \? evt : shownTimes\(evt\)\)/);
  // Overlapping counts: a stay that began last month is part of this week.
  assert.match(sync, /if \(evtStart > endMs \|\| \(isNaN\(evtEnd\) \? evtStart : evtEnd\) < startMs\) return false;/);
});

test("place lookups ask OpenStreetMap for English names", () => {
  for (const f of ["lib/onboarding.js", "webapp/server.js", "webapp/views/dashboard.html", "lib/maps-fallback.js"]) {
    const src = read(f);
    if (f === "lib/maps-fallback.js") continue;
    for (const line of src.split("\n").filter((l) => /nominatim\.openstreetmap\.org\/(search|reverse)/.test(l))) {
      assert.match(line, /accept-language=en/, `${f}: ${line.trim().slice(0, 80)}`);
    }
  }
  assert.match(read("lib/maps-fallback.js"), /"Accept-Language": "en"/);
});
