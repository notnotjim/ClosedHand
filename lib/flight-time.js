// Flight clocks always use the airport's timezone or the booking's UTC offset.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FlightTime = factory();
})(typeof window === 'object' ? window : this, function () {
  function offset(iso) {
    const m = String(iso || '').match(/([+-])(\d{2}):(\d{2})$/);
    return m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) : null;
  }
  function clock(iso, point = {}) {
    if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(String(iso || ''))) return null;
    const date = new Date(iso);
    if (!iso || !Number.isFinite(date.getTime())) return null;
    if (point.tz) {
      try {
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone: point.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
        return Object.fromEntries(parts.map(p => [p.type, p.value]));
      } catch (_) { /* Retain the booking's explicit offset if the zone is invalid. */ }
    }
    const minutes = Number.isFinite(point.utcOffsetMinutes) ? point.utcOffsetMinutes : offset(point.dateTime) ?? offset(iso);
    if (minutes === null || Math.abs(minutes) > 840) return null;
    const local = new Date(date.getTime() + minutes * 60000).toISOString();
    return { year: local.slice(0, 4), month: local.slice(5, 7), day: local.slice(8, 10), hour: local.slice(11, 13), minute: local.slice(14, 16) };
  }
  function time(iso, point) {
    const p = clock(iso, point);
    return p ? `${p.hour}:${p.minute}` : '--:--';
  }
  function dateKey(iso, point) {
    const p = clock(iso, point);
    return p ? `${p.year}-${p.month}-${p.day}` : null;
  }
  function dateLabel(iso, point) {
    const key = dateKey(iso, point);
    return key ? new Date(key + 'T12:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : 'Date to be confirmed';
  }
  function daysAway(iso, point, now = new Date()) {
    const key = dateKey(iso, point);
    if (!key) return '';
    const today = dateKey(now.toISOString(), point);
    if (!today) return '';
    const days = Math.round((Date.parse(key + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
    return days < 0 ? '' : days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
  }
  function preserveOffset(point) {
    if (point && !Number.isFinite(point.utcOffsetMinutes)) {
      const minutes = offset(point.dateTime);
      if (minutes !== null) point.utcOffsetMinutes = minutes;
    }
    return point;
  }
  return { time, dateKey, dateLabel, daysAway, preserveOffset };
});
