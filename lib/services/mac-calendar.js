// lib/services/mac-calendar.js: the Mac's own calendar, read through Bridge.
//
// Bridge's calendar.list reads the calendar store directly (EventKit) when it
// has Calendar access, and falls back to asking the Calendar app through
// AppleScript when it doesn't. The sync and live lookups used to send their
// own AppleScript through shell.run instead, which launched Calendar and could
// take most of a minute, or a bundled icalBuddy binary that nothing built.

const { bridgeRequest } = require("./bridge-relay");

// Events from now - daysBack to now + daysAhead, normalised:
// { id, summary, start, end, all_day, location, calendar, description, attendees: [names] }.
// start and end are ISO with offset from EventKit, or the Calendar app's own
// date text from the AppleScript fallback. Throws when Bridge can't answer.
async function readMacCalendar(userId, { daysBack = 0, daysAhead = 7, timeoutMs = 45000 } = {}) {
  const rows = await bridgeRequest(userId, "calendar.list", { days_back: daysBack, days_ahead: daysAhead }, timeoutMs);
  if (!Array.isArray(rows)) throw new Error(rows?.error || "Bridge returned no calendar");
  return rows.map((row, i) => {
    const summary = String(row.title || "");
    const start = String(row.start || "");
    return {
      // EventKit gives a stable id; the AppleScript fallback gives none.
      id: row.id ? String(row.id) : ("mac_" + i + "_" + summary).replace(/[^a-zA-Z0-9]/g, "_").substring(0, 100),
      summary,
      start,
      end: String(row.end || start),
      all_day: row.all_day === true,
      location: String(row.location || ""),
      calendar: String(row.calendar || "Mac Calendar"),
      description: String(row.notes || "").replace(/[\r\n]+/g, " ").substring(0, 1000),
      attendees: Array.isArray(row.attendees) ? row.attendees.map(String).filter(Boolean) : [],
    };
  });
}

module.exports = { readMacCalendar };
