// phone-zone.js: the phone's clock as a sign the person has moved.
//
// Vendored: lib/phone-zone.js (bot) and webapp/phone-zone.js (dashboard and
// web chat), kept byte-identical (scripts/check-vendored-identical.js).
//
// A phone sets its clock from the network wherever it is, so its time zone
// is a free, coarse sign of where its owner is, with no location permission.
// The web chat sends it from phones when it opens (a computer's clock may
// stay on home time, so computers don't), and it is kept on the saved
// location as deviceZone { timezone, at }, "at" being when it changed. When
// it changed after the place was saved and runs on a different clock, the
// person has most likely moved on: the clock, quiet hours and reminders
// follow the phone until a place is saved again (shared, told in chat, or a
// landing).

function valid(tz) {
  if (typeof tz !== "string" || !tz) return false;
  try { new Intl.DateTimeFormat("en-GB", { timeZone: tz }); return true; } catch (_) { return false; }
}

function offsetAt(tz, now) {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(now).find((p) => p.type === "timeZoneName");
  return part ? part.value : tz;
}

// The phone's zone when it says the saved place is out of date, or null.
// Two names for one clock (Asia/Saigon, Asia/Ho_Chi_Minh) are no move.
function movedZone(loc, now = new Date()) {
  const d = loc && loc.deviceZone;
  if (!d || !valid(d.timezone)) return null;
  if ((Date.parse(d.at) || 0) <= (Date.parse(loc.updated) || 0)) return null;
  if (valid(loc.timezone) && offsetAt(loc.timezone, now) === offsetAt(d.timezone, now)) return null;
  return d.timezone;
}

// The zone the person's clock runs on: the phone's when they have moved on,
// otherwise the saved place's; null when neither is known.
function zoneOf(loc, now = new Date()) {
  return movedZone(loc, now) || (loc && valid(loc.timezone) ? loc.timezone : null);
}

// The saved location with the phone's zone noted, or null when there is
// nothing to write: no saved place, an unreadable zone, or the same zone as
// last time (its "at" stays when it first changed).
function noteZone(loc, tz, now = new Date()) {
  if (!loc || !valid(tz)) return null;
  if (loc.deviceZone && loc.deviceZone.timezone === tz) return null;
  return { ...loc, deviceZone: { timezone: tz, at: now.toISOString() } };
}

module.exports = { movedZone, zoneOf, noteZone, valid };
