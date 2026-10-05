// goals-time.js: when a goal's check-in is due, and where this week began.
// Vendored: lib/goals-time.js and webapp/goals-time.js are identical copies
// (scripts/check-vendored-identical.js), so the chat and the dashboard always
// agree on the next check-in. Self-contained: no requires.

const DEFAULT_TZ = "Europe/London";
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function validZone(tz) {
  try { new Intl.DateTimeFormat("en-GB", { timeZone: tz }); return true; } catch { return false; }
}

function offsetMinutes(tz, at) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(at).find((p) => p.type === "timeZoneName")?.value || "GMT";
  const m = name.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) : 0;
}

// A wall-clock time in tz ("2026-10-06T19:00:00"), as the instant it names.
function zonedToUtc(naive, tz) {
  const zone = validZone(tz) ? tz : DEFAULT_TZ;
  const asUtc = new Date(String(naive).trim() + "Z");
  const first = new Date(asUtc.getTime() - offsetMinutes(zone, asUtc) * 60000);
  return new Date(asUtc.getTime() - offsetMinutes(zone, first) * 60000);
}

function dayParts(at, tz) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" })
    .formatToParts(at).map((p) => [p.type, p.value]));
}

// "Sundays 7pm" as data: days of the week (0 = Sunday) and a 24-hour time.
function cleanCheckIn(input, timezone) {
  if (!input) return null;
  const days = (Array.isArray(input.days) ? input.days : [input.days]).map((d) => {
    if (typeof d === "number") return d;
    return DAYS.indexOf(String(d || "").toLowerCase().replace(/s$/, ""));
  }).filter((d) => d >= 0 && d <= 6);
  const time = /^([01]?\d|2[0-3]):([0-5]\d)$/.test(String(input.time || "")) ? String(input.time).padStart(5, "0") : null;
  if (!days.length || !time) return null;
  const tz = validZone(input.timezone) ? input.timezone : validZone(timezone) ? timezone : DEFAULT_TZ;
  return { days: [...new Set(days)].sort(), time, timezone: tz, next_at: null };
}

// The next check-in after a moment, in the person's own timezone.
function nextCheckIn(checkIn, after = new Date()) {
  if (!checkIn || !Array.isArray(checkIn.days) || !checkIn.time) return null;
  const tz = validZone(checkIn.timezone) ? checkIn.timezone : DEFAULT_TZ;
  for (let i = 0; i <= 8; i++) {
    const p = dayParts(new Date(after.getTime() + i * 86400000), tz);
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
    if (!checkIn.days.includes(weekday)) continue;
    const at = zonedToUtc(`${p.year}-${p.month}-${p.day}T${checkIn.time}:00`, tz);
    if (at > after) return at.toISOString();
  }
  return null;
}

function describeCheckIn(c) {
  if (!c || !Array.isArray(c.days)) return "";
  const names = c.days.map((d) => DAYS[d][0].toUpperCase() + DAYS[d].slice(1, 3));
  const [h, m] = String(c.time).split(":").map(Number);
  const time = `${h % 12 || 12}${m ? ":" + String(m).padStart(2, "0") : ""}${h < 12 ? "am" : "pm"}`;
  return `${c.days.length === 7 ? "Every day" : names.join(", ")}, ${time}`;
}

// Monday 00:00 of this week, in tz: "this week, 3 of 5".
function weekStart(tz, at = new Date()) {
  const zone = validZone(tz) ? tz : DEFAULT_TZ;
  const p = dayParts(at, zone);
  const back = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday);
  const midnight = zonedToUtc(`${p.year}-${p.month}-${p.day}T00:00:00`, zone);
  return new Date(midnight.getTime() - back * 86400000);
}

module.exports = { DAYS, DEFAULT_TZ, zonedToUtc, cleanCheckIn, nextCheckIn, describeCheckIn, weekStart };
