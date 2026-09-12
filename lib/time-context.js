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
      tz = validZone(store?.profile?.timezone) ? store.profile.timezone : 'UTC';
      suffix = `Reference clock (${tz}); the user's current location is unknown, so this is not confirmed as their local date or time`;
    }
  }
  const date = at.toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: tz });
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz });
  return { timezone: known?.timezone || null, text: `${suffix}: ${date}, ${time}. Use confirmed local time for ordinary events. For travel, use each airport or property's local date and time, including today/tomorrow. Do not copy relative dates from earlier messages.` };
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
      flights.push({ ms, text: `${f.flightNumber}: ${date}, ${FlightTime.time(dep, point)} at ${point.airport || 'departure airport'}; ${FlightTime.daysAway(dep, point, now) || 'past departure date'} in the departure airport's timezone.` });
    } catch { /* Malformed facts do not become date evidence. */ }
  }
  return flights.length ? '\n\nFLIGHT DATES (checked now, airport-local; use these over earlier relative wording):\n'
    + flights.sort((a, b) => a.ms - b.ms).slice(0, 6).map(f => f.text).join('\n') : '';
}
module.exports = { currentTimeContext, flightDateContext };
