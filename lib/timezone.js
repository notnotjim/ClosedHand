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

module.exports = { getUserTimezone, userHour, formatTime, formatDate, nowStamp, fetchTimezoneFor, DEFAULT_TZ };
