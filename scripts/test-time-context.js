const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { currentTimeContext, flightDateContext } = require('../lib/time-context');
const at = new Date('2026-09-12T21:40:00Z');
const facts = { 'flight-test': { value: JSON.stringify({ flightNumber: 'XY829', departure: { airport: 'KIX', tz: 'Asia/Tokyo', dateTime: '2026-09-13T10:30:00+09:00' } }) } };
test('unknown location never presents London as the confirmed user location', () => {
  const result = currentTimeContext({ profile: { timezone: 'Europe/London' } }, at);
  assert.match(result.text, /location is unknown/);
  assert.doesNotMatch(result.text, /Today is|where the user is/);
  const known = currentTimeContext({ location: { timezone: 'Asia/Tokyo' } }, at);
  assert.match(known.text, /Sunday, 13 September 2026, 06:40/);
});
test('coordinate estimates shift the date as well as the hour, including latitude zero', () => {
  const result = currentTimeContext({ location: { latitude: 0, longitude: 135 } }, at);
  assert.match(result.text, /13 September 2026, 06:40/);
  assert.match(result.text, /timezone unconfirmed/);
  assert.match(currentTimeContext({ location: { timezone: 'invalid' } }, at).text, /location is unknown/);
});
test('flight context supplies today at the departure airport despite an unknown user location', () => {
  const block = flightDateContext(facts, at);
  assert.match(block, /XY829: 2026-09-13, 10:30 at KIX; today/);
  assert.doesNotMatch(block, /tomorrow/);
  const excluded = { ...facts, 'flight-old': JSON.stringify({ ...JSON.parse(facts['flight-test'].value), flightNumber: 'OLD', supersededBy: 'flight-test' }) };
  assert.doesNotMatch(flightDateContext(excluded, at), /OLD/);
});
test('the actual chat prompt tail includes the current airport date evidence', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/engine.js'), 'utf8');
  const body = source.match(/function buildVolatileSystemTail\([^]*?\n\}/)[0];
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [at])); } }
  const fn = vm.runInNewContext(body + '\nbuildVolatileSystemTail', {
    Date: FixedDate, ctx: { store: { facts }, activeUserStore: { profile: { timezone: 'Europe/London' } } },
    require: name => {
      if (name === './time-context') return { currentTimeContext, flightDateContext };
      if (name === './services/google') return { listGoogleAccounts: () => [] };
      throw Error(name);
    }, getSkillsForPrompt: () => '', getUserSkillsBlock: () => '', buildTravelTimezoneBlock: () => '',
    matters: { getMattersBlock: () => '' },
  });
  const text = fn();
  assert.match(text, /location is unknown/);
  assert.match(text, /XY829: 2026-09-13, 10:30 at KIX; today/);
});
