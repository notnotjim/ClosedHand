// Calendars write an all-day event's end as the day after its last day: a
// stay from 16 September to 7 October ends on 8 October. Read as it comes,
// every all-day event runs a day too long ("until 8 October"), so events
// handed to the model carry their last day, and say they are all-day.

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function dayBefore(ymd) {
  const d = new Date(ymd + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// A last day never before the first: a one-day event ends the day it starts.
function lastDay(first, endExclusive) {
  if (!endExclusive) return first;
  const last = dayBefore(endExclusive);
  return last < first ? first : last;
}

// A Google Calendar event: { start, end } for timed events, as Google gives
// them; for all-day events the first and last days and all_day: true.
function googleEventTimes(e) {
  if (e?.start?.date && !e.start.dateTime) {
    return { start: e.start.date, end: lastDay(e.start.date, e.end?.date || null), all_day: true };
  }
  return { start: e?.start?.dateTime || null, end: e?.end?.dateTime || null };
}

// A Microsoft Graph event, which marks all-day events with isAllDay and gives
// them midnight-to-midnight times.
function outlookEventTimes(e) {
  const at = (t) => (t?.dateTime ? t.dateTime + (t.timeZone === "UTC" ? "Z" : "") : "");
  if (e?.isAllDay && e.start?.dateTime) {
    const first = e.start.dateTime.slice(0, 10);
    return { start: first, end: lastDay(first, e.end?.dateTime ? e.end.dateTime.slice(0, 10) : null), all_day: true };
  }
  return { start: at(e?.start), end: at(e?.end) };
}

// An event already flattened to { start, end } strings from Google's form
// (the calendar copy): date-only start and end mean all-day.
function shownTimes(evt) {
  if (evt && DAY.test(evt.start || "") && DAY.test(evt.end || "")) {
    return { ...evt, end: lastDay(evt.start, evt.end), all_day: true };
  }
  return evt;
}

module.exports = { dayBefore, googleEventTimes, outlookEventTimes, shownTimes };
