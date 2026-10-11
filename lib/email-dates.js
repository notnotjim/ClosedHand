// lib/email-dates.js — which year a date in a confirmation email means.
//
// A booking email that gives a date without its year means the first such
// date after the email was sent: a booking is for something ahead of its
// confirmation. "The current year" is the wrong anchor. An email sent in
// December 2022 about a flight on "21 Dec" describes a 2022 trip, and dating
// it this December put a four-year-old flight on the dashboard as upcoming.
// Mail also arrives during and after a trip: a host's message in the
// reservation thread ("2 – 20 May", sent on 20 May), a review request. A
// date in one of those is the trip under way or just over, not the same days
// next year, which put a finished stay on the dashboard as almost a year away.
// Pure functions, no database.

const DAY = 86400000;
// Airlines sell about a year ahead; a date further than this after its own
// confirmation email is a year that was guessed rather than read.
const PLAUSIBLE_AHEAD_DAYS = 370;
// Mail about a trip keeps coming for a while after it: the host's last
// messages, the receipt, a review request a fortnight later.
const RECENT_PAST_DAYS = 30;

function withYear(iso, year) {
  return typeof iso === "string" && /^\d{4}-\d{2}-\d{2}/.test(iso) ? String(year).padStart(4, "0") + iso.slice(4) : null;
}

// The same moment of the year, moved by whole years: a flight's arrival or a
// stay's check-out moves with its start.
function shiftYears(iso, years) {
  if (!years || typeof iso !== "string") return iso;
  const year = Number(iso.slice(0, 4));
  return Number.isFinite(year) ? withYear(iso, year + years) || iso : iso;
}

// How many years to move a date so it falls on the first matching day on or
// after the email was sent, allowing two days for time zones and bookings
// made on the day; or, when the email was sent during the trip or within a
// month of its end, on that trip. endIso, the check-out or arrival, moves
// with the start.
function yearsToAnchor(iso, sentAt, endIso) {
  const sent = Date.parse(sentAt), when = Date.parse(iso);
  if (!Number.isFinite(sent) || !Number.isFinite(when)) return 0;
  const sentYear = new Date(sent).getUTCFullYear(), year = Number(iso.slice(0, 4));
  const span = Math.max(0, (Date.parse(endIso) || when) - when);
  for (const y of [sentYear - 1, sentYear, sentYear + 1, sentYear + 2]) {
    const start = Date.parse(withYear(iso, y));
    if (!Number.isFinite(start)) continue;
    const ahead = start >= sent - 2 * DAY;
    const underwayOrJustOver = start <= sent && start + span >= sent - RECENT_PAST_DAYS * DAY;
    if (ahead || underwayOrJustOver) return y - year;
  }
  return 0;
}

// Whether the email's own words carry the date's year. A reader can say it
// read a year that it in fact supplied; a year the text never contains was
// guessed, whatever the reader said.
function yearWritten(iso, text) {
  const year = String(iso || "").slice(0, 4);
  return /^\d{4}$/.test(year) && new RegExp(`(^|\\D)${year}(\\D|$)`).test(String(text || ""));
}

function implausiblyLate(iso, sentAt) {
  const sent = Date.parse(sentAt), when = Date.parse(iso);
  return Number.isFinite(sent) && Number.isFinite(when) && when - sent > PLAUSIBLE_AHEAD_DAYS * DAY;
}

// The years to move an extracted date by. The reader says whether the email
// wrote the year; given the email's text, a year counts as written only when
// the text contains it. A guessed year is anchored to the email's date.
// Without either, only a date implausibly long after the email is moved.
function yearCorrection(iso, sentAt, yearStated, { end, text } = {}) {
  const written = text == null ? yearStated === true : yearStated !== false && yearWritten(iso, text);
  if (written) return 0;
  if (yearStated === false || text != null || implausiblyLate(iso, sentAt)) return yearsToAnchor(iso, sentAt, end);
  return 0;
}

module.exports = { shiftYears, yearsToAnchor, yearWritten, implausiblyLate, yearCorrection, PLAUSIBLE_AHEAD_DAYS, RECENT_PAST_DAYS };
