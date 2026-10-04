// lib/email-dates.js — which year a date in a confirmation email means.
//
// A booking email that gives a date without its year means the first such
// date after the email was sent: a booking is for something ahead of its
// confirmation. "The current year" is the wrong anchor. An email sent in
// December 2022 about a flight on "21 Dec" describes a 2022 trip, and dating
// it this December put a four-year-old flight on the dashboard as upcoming.
// Pure functions, no database.

const DAY = 86400000;
// Airlines sell about a year ahead; a date further than this after its own
// confirmation email is a year that was guessed rather than read.
const PLAUSIBLE_AHEAD_DAYS = 370;

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
// made on the day.
function yearsToAnchor(iso, sentAt) {
  const sent = Date.parse(sentAt), when = Date.parse(iso);
  if (!Number.isFinite(sent) || !Number.isFinite(when)) return 0;
  const sentYear = new Date(sent).getUTCFullYear(), year = Number(iso.slice(0, 4));
  for (const y of [sentYear - 1, sentYear, sentYear + 1, sentYear + 2]) {
    const candidate = Date.parse(withYear(iso, y));
    if (Number.isFinite(candidate) && candidate >= sent - 2 * DAY) return y - year;
  }
  return 0;
}

function implausiblyLate(iso, sentAt) {
  const sent = Date.parse(sentAt), when = Date.parse(iso);
  return Number.isFinite(sent) && Number.isFinite(when) && when - sent > PLAUSIBLE_AHEAD_DAYS * DAY;
}

// The years to move an extracted date by. The reader says whether the email
// wrote the year; a year it supplied itself is anchored to the email's date.
// When it does not say, only a date implausibly long after the email is moved.
function yearCorrection(iso, sentAt, yearStated) {
  if (yearStated === true) return 0;
  if (yearStated === false || implausiblyLate(iso, sentAt)) return yearsToAnchor(iso, sentAt);
  return 0;
}

module.exports = { shiftYears, yearsToAnchor, implausiblyLate, yearCorrection, PLAUSIBLE_AHEAD_DAYS };
