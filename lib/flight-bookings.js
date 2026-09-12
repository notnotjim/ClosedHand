// Reconcile email evidence with a user's tracked flights. No network or writes.
const { preserveOffset } = require('./flight-time');
const compact = value => String(value || '').toUpperCase().replace(/[\s-]+/g, '');
const dateMs = value => Date.parse(value) || 0;
function mergePoint(previous, incoming) {
  const point = { ...previous, ...incoming };
  if (/[+-]\d{2}:\d{2}$/.test(incoming?.dateTime || '')) delete point.utcOffsetMinutes;
  return preserveOffset(point);
}
function evidenceTime(flight) {
  return Math.max(dateMs(flight?.sourceEmailAt), dateMs(flight?.supersededAt));
}
function read(value) {
  try {
    let f = typeof value === 'string' ? JSON.parse(value) : value;
    if (typeof f?.value === 'string') f = JSON.parse(f.value);
    return f?.flightNumber ? f : null;
  } catch (_) { return null; }
}
function sameLeg(flight, leg) {
  if (compact(flight.flightNumber) !== compact(leg.flightNumber)) return false;
  const a = dateMs(flight.departure?.dateTime), b = dateMs(leg.departure?.dateTime);
  if (!a || !b || Math.abs(a - b) > 18 * 3600000) return false;
  for (const end of ['departure', 'arrival']) {
    const one = flight[end]?.airport, two = leg[end]?.airport;
    if (one && two && compact(one) !== compact(two)) return false;
  }
  return true;
}
function verifiedChange(flight, email) {
  const old = flight.replaces;
  if (!old?.flightNumber || !old.departure?.dateTime || !flight.changeEvidence) return false;
  const text = compact(`${email?.subject || ''} ${email?.body || ''}`);
  const quote = compact(flight.changeEvidence);
  if (quote.length < 12 || !text.includes(quote) || !/chang|rebook|replac|reschedul|newflight/i.test(quote)) return false;
  return text.includes(compact(old.flightNumber)) && text.includes(compact(flight.flightNumber));
}
function reconcileFlights(facts, parsed, emails, now = Date.now()) {
  const records = new Map(Object.entries(facts).filter(([k]) => k.startsWith('flight-')).map(([key, value]) => [key, read(value)]).filter(([, f]) => f));
  const patches = new Map(), announced = new Map();
  const entries = parsed.filter(f => f && f.flightNumber && dateMs(f.departure?.dateTime)).map(f => ({ f, email: emails[f.emailIndex] }));
  entries.sort((a, b) => dateMs(a.email?.date) - dateMs(b.email?.date) || Number(verifiedChange(b.f, b.email)) - Number(verifiedChange(a.f, a.email)));
  function put(key, value) { records.set(key, value); patches.set(key, value); }
  for (const { f, email } of entries) {
    if (!email || dateMs(f.departure.dateTime) < now - 6 * 3600000) continue;
    const text = compact(`${email.subject || ''} ${email.body || ''}`);
    const number = compact(f.flightNumber);
    if (!text.includes(number)) continue;
    const replacement = verifiedChange(f, email);
    const matches = [...records].filter(([, record]) => sameLeg(record, f));
    if (matches.length > 1) continue; // Ambiguous bookings need more evidence.
    const [key, previous] = matches[0] || [`flight-${number}-${f.departure.dateTime.slice(0, 10)}`, null];
    const sourceAt = dateMs(email.date);
    if (previous?.supersededBy && !replacement) continue;
    if (evidenceTime(previous) && (!sourceAt || sourceAt < evidenceTime(previous))) continue;
    // Re-reading the same mail must not overwrite newer live schedule data.
    const repeated = previous?.emailId === email.id && previous?.sourceEmailAt;
    const next = repeated ? { ...previous } : {
      ...previous,
      airline: f.airline || previous?.airline || '', flightNumber: number,
      departure: mergePoint(previous?.departure, f.departure),
      arrival: mergePoint(previous?.arrival, f.arrival),
      confirmationCode: f.confirmationCode && text.includes(compact(f.confirmationCode)) ? String(f.confirmationCode).trim() : previous?.confirmationCode || '',
      passengerName: f.passengerName || previous?.passengerName || '',
      pending: !!f.pending, emailId: email.id, source: 'email',
      sourceEmailAt: sourceAt ? new Date(sourceAt).toISOString() : previous?.sourceEmailAt || null,
      detected: previous?.detected || new Date(now).toISOString(),
      landed: previous?.landed || false, pinMessageIds: previous?.pinMessageIds || {},
    };
    if (!repeated && previous && ['departure', 'arrival'].some(end =>
      f[end]?.dateTime && dateMs(f[end].dateTime) !== dateMs(previous[end]?.dateTime))) {
      // A newer booking must not render the previous itinerary's live clocks.
      delete next.liveStatus;
      delete next.lastScheduleCheck;
    }
    let replacedNumber = null;
    if (replacement) {
      const old = f.replaces;
      const oldMatches = [...records].filter(([oldKey, record]) => oldKey !== key && sameLeg(record, old));
      if (oldMatches.length <= 1) {
        const [oldKey, oldRecord] = oldMatches[0] || [`flight-${compact(old.flightNumber)}-${old.departure.dateTime.slice(0, 10)}`, null];
        const refConflict = oldRecord?.confirmationCode && next.confirmationCode && compact(oldRecord.confirmationCode) !== compact(next.confirmationCode);
        const passengerConflict = oldRecord?.passengerName && next.passengerName && compact(oldRecord.passengerName) !== compact(next.passengerName);
        const staleChange = evidenceTime(oldRecord) && (!sourceAt || sourceAt < evidenceTime(oldRecord));
        if (!refConflict && !passengerConflict && !staleChange) {
          if (oldKey === key) {
            // The same flight number can be retimed without being replaced.
            next.retimedFrom = old.departure.dateTime;
          } else {
            const wasReplaced = oldRecord?.supersededBy === key;
            put(oldKey, { ...oldRecord, flightNumber: compact(old.flightNumber),
              departure: mergePoint(oldRecord?.departure, old.departure),
              arrival: mergePoint(oldRecord?.arrival, old.arrival),
              confirmationCode: oldRecord?.confirmationCode || next.confirmationCode,
              supersededBy: key, supersededAt: sourceAt ? new Date(sourceAt).toISOString() : new Date(now).toISOString(),
              changeEmailId: email.id, changeEvidence: f.changeEvidence });
            delete next.supersededBy;
            delete next.supersededAt;
            next.replaces = { ...old, flightNumber: compact(old.flightNumber) };
            next.changeEvidence = f.changeEvidence;
            if (!wasReplaced) replacedNumber = compact(old.flightNumber);
          }
        }
      }
    }
    if (JSON.stringify(next) !== JSON.stringify(previous)) put(key, next);
    if (!previous || replacedNumber) announced.set(key, { key, ...next, ...(replacedNumber ? { replacesFlightNumber: replacedNumber } : {}) });
  }
  // The original can have appeared earlier in this same batch.
  return { patches: [...patches], flights: [...announced.values()].filter(f => !records.get(f.key)?.supersededBy) };
}
module.exports = { reconcileFlights, sameLeg, verifiedChange };
