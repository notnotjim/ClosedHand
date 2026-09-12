const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const clock = require('../lib/flight-time');
const { reconcileFlights } = require('../lib/flight-bookings');
const now = Date.parse('2026-09-12T07:00:00Z');
const old = { flightNumber: 'XY646', departure: { airport: 'SGN', dateTime: '2026-09-16T20:40:00+07:00' }, arrival: { airport: 'DAD', dateTime: '2026-09-16T22:00:00+07:00' } };
const next = { flightNumber: 'XY648', departure: { airport: 'SGN', dateTime: '2026-09-16T20:00:00+07:00' }, arrival: { airport: 'DAD', dateTime: '2026-09-16T21:20:00+07:00' }, confirmationCode: 'TEST42', emailIndex: 0, pending: false };
const oldKey = 'flight-XY646-2026-09-16', newKey = 'flight-XY648-2026-09-16';
const email = { id: 'changed', date: '2026-09-12T07:07:00Z', subject: 'Changes in your flight', body: 'Your flight has been changed. Your original flight XY646 SGN to DAD 16 Sept 20:40 to 22:00. Your new flight XY648 SGN to DAD 16 Sept 20:00 to 21:20. Booking reference TEST42.' };
const change = { ...next, replaces: old, changeEvidence: 'Your flight has been changed.' };
const wrap = f => ({ value: JSON.stringify(f), accessCount: 3 });
const facts = () => ({ [oldKey]: wrap({ ...old, departure: { airport: 'SGN', dateTime: '2026-09-16T13:40:00Z' }, source: 'calendar' }), [newKey]: wrap(next) });
const apply = (state, result) => Object.assign(state, Object.fromEntries(result.patches.map(([k,v]) => [k, wrap(v)])));
test('flight times stay airport-local on computers in Japan, London and New York', () => {
  const tz = process.env.TZ;
  try {
    for (const zone of ['Asia/Tokyo', 'Europe/London', 'America/New_York']) {
      process.env.TZ = zone;
      assert.equal(clock.time(old.departure.dateTime, old.departure), '20:40');
      assert.equal(clock.time(next.departure.dateTime, next.departure), '20:00');
      assert.equal(clock.time(next.arrival.dateTime, next.arrival), '21:20');
      assert.equal(clock.dateKey(next.departure.dateTime, next.departure), '2026-09-16');
      assert.equal(clock.daysAway(next.departure.dateTime, next.departure, new Date(now)), 'in 4 days');
    }
  } finally { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; }
});
test('UTC live updates retain booking offsets and IANA zones handle DST and separate airports', () => {
  const point = clock.preserveOffset({ ...next.departure });
  point.dateTime = '2026-09-16T13:00:00Z';
  assert.equal(clock.time('2026-09-16T13:15:00Z', point), '20:15');
  assert.equal(clock.time('2026-07-10T12:00:00Z', { tz: 'Europe/London' }), '13:00');
  assert.equal(clock.time('2026-01-10T12:00:00Z', { tz: 'Europe/London' }), '12:00');
  assert.equal(clock.time('2026-07-10T12:00:00Z', { tz: 'America/New_York' }), '08:00');
  assert.equal(clock.dateKey('2026-09-16T18:30:00Z', { tz: 'Asia/Tokyo' }), '2026-09-17');
  assert.equal(clock.time('2026-09-16T13:00:00Z', {}), '--:--');
});
test('change mail replaces an existing calendar flight even when new flight already exists', () => {
  const r = reconcileFlights(facts(), [change], [email], now);
  const saved = Object.fromEntries(r.patches);
  assert.equal(saved[oldKey].supersededBy, newKey);
  assert.equal(saved[newKey].replaces.flightNumber, old.flightNumber);
  assert.equal(r.flights.length, 1);
  assert.equal(r.flights[0].replacesFlightNumber, old.flightNumber);
  assert.equal(clock.time(saved[newKey].departure.dateTime, saved[newKey].departure), '20:00');
});
test('repeat scans are silent and stale original mail cannot restore a replaced flight', () => {
  const state = facts();
  apply(state, reconcileFlights(state, [change], [email], now));
  const repeat = reconcileFlights(state, [change], [email], now);
  assert.equal(repeat.flights.length, 0);
  const stale = { id: 'original', date: '2026-09-11T08:00:00Z', body: 'Confirmed XY646 SGN to DAD TEST42' };
  assert.equal(reconcileFlights(state, [{ ...old, emailIndex: 0 }], [stale], now).patches.length, 0);
});
test('only the replacement is announced when both old and new appear in one scan', () => {
  const r = reconcileFlights({}, [{ ...old, emailIndex: 0 }, change], [email], now);
  assert.deepEqual(r.flights.map(f => f.flightNumber), ['XY648']);
});
test('unrelated flights, invented change quotes, conflicting references and ambiguous legs are not retired', () => {
  for (const candidate of [next, { ...change, changeEvidence: 'The airline has rebooked everything' }]) {
    assert.ok(!Object.fromEntries(reconcileFlights(facts(), [candidate], [email], now).patches)[oldKey]);
  }
  const state = facts(); state[oldKey] = wrap({ ...old, confirmationCode: 'OTHER9' });
  assert.ok(!Object.fromEntries(reconcileFlights(state, [change], [email], now).patches)[oldKey]);
  state['flight-duplicate'] = wrap(old);
  assert.ok(!Object.fromEntries(reconcileFlights(state, [change], [email], now).patches)[oldKey]);
});
test('a later rebooking cannot be undone by an older change email', () => {
  const state = facts(); apply(state, reconcileFlights(state, [change], [email], now));
  const returnChange = { ...old, emailIndex: 0, replaces: next, changeEvidence: email.body.slice(0, 29) };
  const newer = { ...email, id: 'newer-change', date: '2026-09-12T10:00:00Z' };
  apply(state, reconcileFlights(state, [returnChange], [newer], now));
  assert.equal(JSON.parse(state[newKey].value).supersededBy, oldKey);
  const stale = reconcileFlights(state, [change], [email], now);
  assert.equal(stale.patches.length, 0);
});
test('same-number retiming remains one active flight and updates its offset', () => {
  const state = { [newKey]: wrap({ ...next, departure: { ...next.departure, utcOffsetMinutes: 540 } }) };
  const r = reconcileFlights(state, [{ ...change, replaces: next }], [email], now);
  const f = Object.fromEntries(r.patches)[newKey];
  assert.equal(f.supersededBy, undefined);
  assert.equal(f.departure.utcOffsetMinutes, 420);
});
function loadFlights(state, modelResponse, extra = {}) {
  let saved = 0, prompt;
  const ctx = { store: { facts: state }, bridgeConnected: true };
  const dependencies = { './context': ctx,
    './llm': { getInternalClient: () => ({ model: 'fixture', client: { messages: { create: async p => { prompt = p.messages[0].content; return { content: [{ text: JSON.stringify(modelResponse) }] }; } } } }) },
    './http': {}, './messaging': {}, './storage': { saveStore() { saved++; } },
    './services/google': { isGoogleConnected: () => false }, './services/microsoft': { isMicrosoftConnected: () => false },
    './services/imap-mail': { isImapConnected: () => false }, './services/data-access': {},
    './mail-attachments': { bodyForScan: async (_,e,n) => (e.summary || e.body).slice(0,n) },
    './flight-time': clock, './flight-bookings': require('../lib/flight-bookings'), ...extra };
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const sandbox = { module: { exports: {} }, Date: FixedDate, console, process: { env: { FLIGHTAWARE_API_KEY: 'fixture' } }, require: name => { if (!(name in dependencies)) throw Error(name); return dependencies[name]; } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'lib/flights.js'), 'utf8'), sandbox);
  return { api: sandbox.module.exports, saved: () => saved, prompt: () => prompt };
}
test('scanner uses the full change email, preserves note metadata, and briefing matches the card', async () => {
  const state = facts(); const h = loadFlights(state, [change]);
  const full = { ...email, summary: 'Your original flight XY646', body: 'x'.repeat(2500) + email.body };
  await h.api.scanEmailsForFlights('fixture-user', { emails: [full] });
  assert.match(h.prompt(), /Your new flight XY648/);
  assert.equal(state[oldKey].accessCount, 3);
  assert.equal(JSON.parse(state[oldKey].value).supersededBy, newKey);
  assert.equal(h.saved(), 1);
  assert.match(h.api.buildFlightBriefing(next), /Departs 20:00 \(SGN local\)/);
  assert.match(h.api.buildFlightBriefing(next), /Arrives 21:20 \(DAD local\)/);
});
test('live checker ignores superseded flights and saves timezone enrichment even without alerts', async () => {
  const active = { ...next, departure: { airport: 'SGN', dateTime: new Date(now + 86400000).toISOString() }, arrival: { airport: 'DAD' }, lastStatus: 'Scheduled', lastDelay: 0, digTried: true };
  const state = { [oldKey]: wrap({ ...active, flightNumber: 'XY646', supersededBy: newKey }), [newKey]: wrap(active) };
  const calls = [];
  const h = loadFlights(state, [], { './http': { httpGet: async url => { calls.push(url); return { statusCode: 200, body: JSON.stringify(url.includes('/airports/') ? { timezone: 'Asia/Ho_Chi_Minh' } : { flights: [{ status: 'Scheduled', scheduled_out: active.departure.dateTime, origin: { code_iata: 'SGN' }, destination: { code_iata: 'DAD' } }] }) }; } } });
  const updates = await h.api.checkFlightsForUpdates('fixture-user');
  assert.equal(updates.length, 0);
  assert.equal(h.saved(), 1);
  assert.ok(calls.some(url => url.includes('/flights/XY648')));
  assert.ok(!calls.some(url => url.includes('/flights/XY646')));
  assert.equal(JSON.parse(state[newKey].value).departure.tz, 'Asia/Ho_Chi_Minh');

});
test('dashboard renders airport-local clocks using the shipped browser helper', () => {
  const html = fs.readFileSync(path.join(root, 'webapp/views/dashboard.html'), 'utf8');
  const render = html.slice(html.indexOf('    function renderFlightCard('), html.indexOf('    // === Load flights ==='));
  const scope = { getFlightStatusInfo: () => ({ cls: 'scheduled', label: 'Scheduled' }), escHtml: String, fmtFlightTime: clock.time };
  vm.runInNewContext(render, scope);
  const card = scope.renderFlightCard(next);
  assert.match(card, />20:00</); assert.match(card, />21:20</);
  assert.ok(!card.includes('22:00'));
  assert.match(html, /<script src="\/flight-time.js"><\/script>/);
  assert.equal(fs.readFileSync(path.join(root, 'webapp/public/flight-time.js'), 'utf8'), fs.readFileSync(path.join(root, 'lib/flight-time.js'), 'utf8'));
});

test('flights API excludes superseded records and keeps authentication enforced', async () => {
  const source = fs.readFileSync(path.join(root, 'webapp/server.js'), 'utf8');
  const start = source.indexOf('app.get("/api/flights",');
  const end = source.indexOf('\n});', start) + 4;
  let handler, payload, status = 200, user = 'fixture-user';
  const state = facts(); apply(state, reconcileFlights(state, [change], [email], now));
  const query = { select() { return this; }, eq(column, value) { assert.equal(column, 'user_id'); assert.equal(value, user); return this; }, async like() { return { data: Object.entries(state).map(([key,value]) => ({key,value:JSON.stringify(value)})) }; } };
  class FixedDate extends Date { static now() { return now; } }
  vm.runInNewContext(source.slice(start, end), { Date: FixedDate, console, getUserIdFromRequest: () => user, supabase: { from: () => query }, app: { get: (_,fn) => { handler = fn; } } });
  const res = { json(value) { payload = value; }, status(code) { status = code; return this; } };
  await handler({}, res);
  assert.deepEqual(Array.from(payload, f => f.flightNumber), ['XY648']);
  user = null; await handler({}, res); assert.equal(status, 401);
});

test('confirmed email clears pending, while stale mail cannot reverse it', () => {
  const state = { [newKey]: wrap({ ...next, pending: true, liveStatus: { departureTime: next.departure.dateTime } }) };
  apply(state, reconcileFlights(state, [next], [email], now));
  assert.equal(JSON.parse(state[newKey].value).pending, false);
  const stale = { ...email, id: 'older', date: '2026-09-11T00:00:00Z' };
  assert.equal(reconcileFlights(state, [{ ...next, pending: true }], [stale], now).patches.length, 0);
});
test('new booking times replace stale live clocks, but rereading the same email keeps live updates', () => {
  const state = { [newKey]: wrap({ ...next, departure: old.departure, liveStatus: { departureTime: old.departure.dateTime } }) };
  apply(state, reconcileFlights(state, [next], [email], now));
  const corrected = JSON.parse(state[newKey].value);
  assert.equal(corrected.liveStatus, undefined);
  corrected.liveStatus = { departureTime: '2026-09-16T13:15:00Z' };
  state[newKey] = wrap(corrected);
  apply(state, reconcileFlights(state, [next], [email], now));
  assert.equal(JSON.parse(state[newKey].value).liveStatus.departureTime, '2026-09-16T13:15:00Z');
});
test('scanner refuses flight numbers absent from the source email', () => {
  assert.equal(reconcileFlights({}, [{ ...next, flightNumber: 'ZZ999' }], [email], now).patches.length, 0);
});
test('a UTC offset of zero is usable, while timezone-less timestamps never use the machine clock', () => {
  assert.equal(clock.time('2026-09-16T20:00:00+00:00'), '20:00');
  assert.equal(clock.time('2026-09-16T20:00:00', { tz: 'Asia/Tokyo' }), '--:--');
});

test('explicit change mail can reconcile agency and airline references when both are in the evidence', () => {
  const state = { [oldKey]: wrap({ ...old, confirmationCode: 'ORDER1234' }), [newKey]: wrap(next) };
  const evidence = { ...email, body: email.body + ' Agency customer reference ORDER1234.' };
  const result = reconcileFlights(state, [change], [evidence], now);
  assert.equal(Object.fromEntries(result.patches)[oldKey].supersededBy, newKey);
  assert.equal(result.flights[0].replacesFlightNumber, old.flightNumber);
});

test('a newer same-number departure email produces one change alert without inventing arrival', () => {
  const before = { ...next, departure: old.departure, emailId: 'original', sourceEmailAt: '2026-09-11T08:00:00Z' };
  const state = { [newKey]: wrap(before) };
  const departureOnly = { ...next, arrival: { airport: 'DAD', dateTime: null } };
  const r = reconcileFlights(state, [departureOnly], [email], now);
  assert.equal(r.flights.length, 1);
  assert.equal(r.flights[0].scheduleChanges.departure.from.dateTime, old.departure.dateTime);
  assert.equal(r.flights[0].scheduleChanges.departure.to.dateTime, next.departure.dateTime);
  assert.equal(r.flights[0].scheduleChanges.arrival, undefined);
  assert.equal(r.flights[0].arrival.dateTime, null);
  apply(state, r);
  assert.equal(reconcileFlights(state, [departureOnly], [email], now).flights.length, 0);
  assert.equal(reconcileFlights(state, [{ ...before, emailIndex: 0 }], [{ ...email, id: 'older', date: '2026-09-10T08:00:00Z' }], now).patches.length, 0);
});
test('equivalent instants and metadata updates never announce a schedule change', () => {
  const state = { [newKey]: wrap(next) };
  const f = { ...next, departure: { ...next.departure, dateTime: '2026-09-16T13:00:00Z' }, airline: 'Updated name' };
  assert.equal(reconcileFlights(state, [f], [email], now).flights.length, 0);
});
test('a batch announces its latest clock, or stays silent if changes cancel out', () => {
  const second = { ...next, departure: { ...next.departure, dateTime: '2026-09-16T21:00:00+07:00' }, emailIndex: 1 };
  const newer = { ...email, id: 'latest', date: '2026-09-12T08:00:00Z' };
  const fresh = reconcileFlights({}, [next, second], [email, newer], now);
  assert.equal(fresh.flights.length, 1);
  assert.equal(fresh.flights[0].departure.dateTime, second.departure.dateTime);
  assert.equal(fresh.flights[0].scheduleChanges, undefined);
  const state = { [newKey]: wrap({ ...next, departure: old.departure }) };
  const changed = reconcileFlights(state, [next, second], [email, newer], now);
  assert.equal(changed.flights[0].scheduleChanges.departure.from.dateTime, old.departure.dateTime);
  assert.equal(changed.flights[0].scheduleChanges.departure.to.dateTime, second.departure.dateTime);
  const restored = { ...second, departure: old.departure };
  assert.equal(reconcileFlights(state, [next, restored], [email, newer], now).flights.length, 0);
});
test('relative flight dates use the airport calendar across midnight and the date line', () => {
  const tz = process.env.TZ;
  try {
    for (const zone of ['UTC', 'Europe/London', 'America/Los_Angeles']) {
      process.env.TZ = zone;
      const at = new Date('2026-09-12T21:40:00Z');
      assert.equal(clock.daysAway('2026-09-13T10:30:00+09:00', { tz: 'Asia/Tokyo' }, at), 'today');
      assert.equal(clock.daysAway('2026-09-13T10:30:00-10:00', { tz: 'Pacific/Honolulu' }, at), 'tomorrow');
    }
  } finally { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; }
});

function loadAnnouncements(targets, options = {}) {
  const sends = [], conversation = [], errors = [];
  const source = fs.readFileSync(path.join(root, 'lib/flights-scheduler.js'), 'utf8');
  const body = source.match(/async function announceNewFlights\([^]*?\n\}/)[0];
  const announce = vm.runInNewContext(body + '\nannounceNewFlights', {
    FlightTime: clock, LIVE: false, flightIntervals: {}, ctx: {},
    _getNoteValue: n => n?.value || n,
    dashboardUrl: async (platform, section) => { assert.equal(section, 'schedules'); if (options.noUrl) throw Error('unavailable'); return 'https://phone.example/dashboard#schedules'; },
    deliveryTargets: async () => targets,
    sendToPlatform: async (...args) => { if (options.fail) throw Error('offline'); sends.push(args); return { id: 'captured' }; },
    getConversation: () => conversation, saveStore() {}, console: { error: text => errors.push(text) },
  });
  return { announce: f => announce('fixture-user', { notes: {} }, [f], targets), sends, conversation, errors };
}
test('the real announcement sends old/new local clocks and a phone link without live tracking', async () => {
  const target = [{ platform: 'whatsapp_linked', platform_user_id: 'self' }];
  const h = loadAnnouncements(target);
  const f = { key: newKey, ...next, scheduleChanges: { departure: { from: old.departure, to: next.departure } } };
  await h.announce(f);
  assert.equal(h.sends.length, 1);
  assert.match(h.sends[0][2], /schedule has changed/);
  assert.match(h.sends[0][2], /20:00.*was 20:40.*SGN local time/);
  assert.match(h.sends[0][2], /https:\/\/phone.example\/dashboard#schedules/);
  assert.equal(h.conversation.length, 1);
  const disabled = loadAnnouncements([]); await disabled.announce(f);
  assert.equal(disabled.sends.length, 0); assert.equal(disabled.conversation.length, 0);
  const noUrl = loadAnnouncements(target, { noUrl: true }); await noUrl.announce(f);
  assert.equal(noUrl.sends.length, 1); assert.doesNotMatch(noUrl.sends[0][2], /localhost/);
  const failed = loadAnnouncements(target, { fail: true }); await failed.announce(f);
  assert.equal(failed.conversation.length, 0); assert.equal(failed.errors.length, 1);
});
test('departure notices without the word booking still enter mail noticing', () => {
  const source = fs.readFileSync(path.join(root, 'lib/mail-noticing.js'), 'utf8');
  const re = vm.runInNewContext(source.match(/const CONFIRMATION_RE = ([^\n]+);/)[1]);
  assert.ok(re.test('XY829 flight delayed'));
  assert.ok(re.test('Flight schedule notification'));
  assert.ok(!re.test('Save 20% on your next summer holiday'));
});
