// lib/timezone.js — single authority for the user's timezone.
// The server runs on UTC; anything user-facing or user-scheduled must convert.
// Chain: saved location's IANA timezone -> Europe/London default.

const DEFAULT_TZ = "Europe/London";

function _valid(tz) {
  try { new Intl.DateTimeFormat("en-GB", { timeZone: tz }); return true; } catch { return false; }
}

/** Accepts a UserStore, ctx.store, or anything with .location / .profile.settings.location */
function getUserTimezone(store) {
  const loc = store?.location || store?.profile?.settings?.location;
  if (loc?.timezone && _valid(loc.timezone)) return loc.timezone;
  return DEFAULT_TZ;
}

/** Current hour (0-23) in the given timezone. */
function userHour(tz) {
  const h = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: _valid(tz) ? tz : DEFAULT_TZ }).format(new Date());
  return parseInt(h, 10) % 24;
}

function formatTime(date, tz) {
  return new Date(date).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: _valid(tz) ? tz : DEFAULT_TZ });
}

function formatDate(date, tz) {
  return new Date(date).toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: _valid(tz) ? tz : DEFAULT_TZ });
}

/** "Today is <date>. Current time where the user is: <HH:MM> (<tz>)." for prompts. */
function nowStamp(store) {
  const tz = getUserTimezone(store);
  return `Today is ${formatDate(new Date(), tz)}. Current time where the user is: ${formatTime(new Date(), tz)} (${tz}).`;
}

/** Resolve the IANA timezone for coordinates via open-meteo (free, no key). Null on failure. */
async function fetchTimezoneFor(latitude, longitude) {
  try {
    const resp = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&timezone=auto&forecast_days=1`);
    if (!resp.ok) return null;
    const data = await resp.json();
    return (data.timezone && _valid(data.timezone)) ? data.timezone : null;
  } catch {
    return null;
  }
}

// An event time the model gave without an offset ("2026-10-09T19:00") means
// that time where the user is. Left as it came, Google reads it in the
// calendar's own timezone (which can be a place they left months ago) and
// Microsoft by the server's clock (UTC), so it is pinned here instead.
const NAIVE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
function hasOffset(value) { return !NAIVE.test(String(value || "").trim()); }

function offsetMinutes(tz, at) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(at).find((p) => p.type === "timeZoneName")?.value || "GMT";
  const m = name.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) : 0;
}

/** A wall-clock time in tz, as the instant it names. */
function zonedToUtc(naive, tz) {
  const zone = _valid(tz) ? tz : DEFAULT_TZ;
  const asUtc = new Date(String(naive).trim() + "Z");
  const first = new Date(asUtc.getTime() - offsetMinutes(zone, asUtc) * 60000);
  // Once more at the result, for a time near a clock change.
  return new Date(asUtc.getTime() - offsetMinutes(zone, first) * 60000);
}

/** Google event time: an offset-less time gets the user's own timezone. */
function googleEventTime(value, tz) {
  return hasOffset(value) ? { dateTime: value } : { dateTime: String(value).trim(), timeZone: _valid(tz) ? tz : DEFAULT_TZ };
}

/** The instant an event time names: an offset-less time is the user's own. */
function eventInstant(value, tz) {
  return hasOffset(value) ? new Date(value) : zonedToUtc(value, tz);
}

module.exports = { getUserTimezone, userHour, formatTime, formatDate, nowStamp, fetchTimezoneFor, DEFAULT_TZ, hasOffset, zonedToUtc, googleEventTime, eventInstant };
