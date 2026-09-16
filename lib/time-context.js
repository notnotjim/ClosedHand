// Current clocks are prompt evidence, never inferred from the server's date.
const FlightTime = require('./flight-time');
const validZone = tz => {
  if (!tz) return false;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch { return false; }
};
function currentTimeContext(store, now = new Date()) {
  const locations = [store?.location, store?.profile?.settings?.location].filter(Boolean);
  const known = locations.find(loc => validZone(loc.timezone));
  let tz = known?.timezone;
  let at = now, suffix;
  if (known) suffix = `Current time where the user is (${tz})`;
  else {
    const coordinates = locations.find(loc => Number.isFinite(loc.latitude) && Math.abs(loc.latitude) <= 90
      && Number.isFinite(loc.longitude) && Math.abs(loc.longitude) <= 180);
    if (coordinates) {
      const offset = Math.round(coordinates.longitude / 15);
      at = new Date(now.getTime() + offset * 3600000);
      tz = 'UTC';
      suffix = `Estimated local time from longitude (UTC${offset >= 0 ? '+' : ''}${offset}, timezone unconfirmed)`;
    } else {
      // Tracked flights place the person: about to depart an airport, or
      // landed at one, means they are in that airport's zone now. Leaving
      // the arithmetic to the model gave "20:00 is eight hours away" for a
      // flight leaving in eighty minutes.
      const placed = placeFromFlights(store?.facts, now);
      if (placed) {
        tz = placed.tz;
        suffix = `Current time where the user most likely is (${tz}, inferred from flight ${placed.flight} ${placed.why}; no location saved, so confirm if it matters)`;
      } else {
        tz = validZone(store?.profile?.timezone) ? store.profile.timezone : 'UTC';
        suffix = `Reference clock (${tz}); the user's current location is unknown, so this is not confirmed as their local date or time`;
      }
    }
  }
  const date = at.toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: tz });
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz });
  return { timezone: known?.timezone || null, text: `${suffix}: ${date}, ${time}. Use confirmed local time for ordinary events. For travel, use each airport or property's local date and time, including today/tomorrow. Do not copy relative dates from earlier messages.` };
}
function parseFlight(raw) {
  let f = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (f?.value !== undefined) f = typeof f.value === 'string' ? JSON.parse(f.value) : f.value;
  return f;
}
// The most recent thing a tracked flight says about where the person is: a
// departure within the next 36 hours puts them at that airport now; a landing
// within the last 30 days puts them where they landed.
function placeFromFlights(facts, now = new Date()) {
  let best = null;
  for (const [key, raw] of Object.entries(facts || {})) {
    if (!key.startsWith('flight-')) continue;
    try {
      const f = parseFlight(raw);
      if (!f || f.supersededBy) continue;
      const dep = Date.parse(f?.liveStatus?.departureTime || f?.departure?.dateTime);
      const arr = Date.parse(f?.liveStatus?.arrivalTime || f?.arrival?.dateTime);
      const t = now.getTime();
      if (Number.isFinite(arr) && arr <= t && t - arr <= 30 * 86400000 && validZone(f?.arrival?.tz)) {
        if (!best || arr > best.at) best = { at: arr, tz: f.arrival.tz, flight: f.flightNumber, why: `that landed at ${f.arrival.airport || 'its destination'}` };
      } else if (Number.isFinite(dep) && dep > t && dep - t <= 36 * 3600000 && validZone(f?.departure?.tz)) {
        if (!best || dep - 36 * 3600000 > best.at) best = { at: dep - 36 * 3600000, tz: f.departure.tz, flight: f.flightNumber, why: `departing ${f.departure.airport || 'its airport'} soon` };
      }
    } catch { /* a malformed fact places nobody */ }
  }
  return best;
}
function untilText(ms, now) {
  const diff = ms - now.getTime();
  if (diff <= 0 || diff > 86400000) return null;
  const h = Math.floor(diff / 3600000), m = Math.round((diff % 3600000) / 60000);
  return `departs in ${h ? h + ' h ' : ''}${m} min from now`;
}
function flightDateContext(facts, now = new Date()) {
  const flights = [];
  for (const [key, raw] of Object.entries(facts || {})) {
    if (!key.startsWith('flight-')) continue;
    try {
      let f = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (f?.value !== undefined) f = typeof f.value === 'string' ? JSON.parse(f.value) : f.value;
      const dep = f?.liveStatus?.departureTime || f?.departure?.dateTime;
      const ms = Date.parse(dep);
      if (f?.supersededBy || f?.landed || !Number.isFinite(ms) || (ms < now.getTime() - 86400000 || ms > now.getTime() + 14 * 86400000)) continue;
      const point = f.departure || {};
      const date = FlightTime.dateKey(dep, point);
      if (!date) continue;
      const soon = untilText(ms, now);
      flights.push({ ms, text: `${f.flightNumber}: ${date}, ${FlightTime.time(dep, point)} at ${point.airport || 'departure airport'}; ${FlightTime.daysAway(dep, point, now) || 'past departure date'} in the departure airport's timezone.${soon ? `; ${soon}` : ''}` });
    } catch { /* Malformed facts do not become date evidence. */ }
  }
  const live = !!process.env.FLIGHTAWARE_API_KEY;
  const noLive = flights.length && !live
    ? '\nThere is no live flight status source on this install. Asked whether a flight is delayed, answer at once from the booking: give the scheduled time, say live status is not available here, and point to the airline\'s app or the airport board. Do not fetch or browse flight-tracker sites; they block automated reading and take minutes to fail.'
    : '';
  return flights.length ? '\n\nFLIGHT DATES (checked now, airport-local; use these over earlier relative wording):\n'
    + flights.sort((a, b) => a.ms - b.ms).slice(0, 6).map(f => f.text).join('\n') + noLive : '';
}
module.exports = { currentTimeContext, flightDateContext, placeFromFlights };
