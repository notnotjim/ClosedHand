const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const calls = [];
const httpPath = require.resolve('../lib/http');
require.cache[httpPath] = { id: httpPath, filename: httpPath, loaded: true, exports: { httpGet: async (url, headers) => {
  calls.push({ url, headers });
  if (url.includes('routing.openstreetmap.de')) return { statusCode: 200, body: JSON.stringify({ code: 'Ok', routes: [{ distance: 2450, duration: 1830, legs: [{ summary: 'Musterweg, Beispielstraße', steps: [
    { name: 'Musterweg', distance: 400, duration: 300, maneuver: { type: 'depart' } },
    { name: 'Beispielstraße', distance: 2050, duration: 1530, maneuver: { type: 'turn', modifier: 'left' } },
    { name: '', distance: 0, duration: 0, maneuver: { type: 'arrive' } }] }] }] }) };
  if (url.includes('air-quality-api.open-meteo.com')) return { statusCode: 200, body: JSON.stringify({ current: { european_aqi: 34, us_aqi: 41, pm2_5: 8.1, pm10: 14.2, nitrogen_dioxide: 19, ozone: 52 } }) };
  if (url.includes('/reverse')) return { statusCode: 200, body: JSON.stringify({ lat: '52.52', lon: '13.40', display_name: 'Example Café, 274, Beispielstraße' }) };
  if (url.includes('bounded=1')) return { statusCode: 200, body: '[]' };
  if (url.includes('XYZ%20airport')) return { statusCode: 200, body: JSON.stringify([{ name: 'Heron Field Airport', lat: '35.55', lon: '139.78', category: 'aeroway', type: 'aerodrome', address: { city: 'Heronton', state: 'Kestrel Prefecture' } }]) };
  if (url.includes('QQQ%20airport')) return { statusCode: 200, body: JSON.stringify([{ name: 'Qqq Street Bakery', lat: '1', lon: '2', category: 'shop', type: 'bakery', address: { city: 'Elsewhere' } }]) };
  return { statusCode: 200, body: JSON.stringify([{ name: 'Example Matcha Bar', display_name: 'Example Matcha Bar, 87 Musterweg', lat: '52.521', lon: '13.402', category: 'amenity', type: 'cafe', extratags: { opening_hours: 'Mo-Su 08:00-22:00' } }]) };
} } };
const maps = require('../lib/maps-fallback');
const { INTERNAL_TOOLS, usable } = require('../lib/tools/definitions');
test('places come back in the same shape as Google, with a name, links and hours', async () => {
  const out = await maps.searchPlaces('matcha cafe', [52.5208, 13.4049], 800);
  assert.equal(out.count, 1);
  const p = out.places[0];
  assert.equal(p.name, 'Example Matcha Bar');
  assert.equal(p.hours, 'Mo-Su 08:00-22:00');
  assert.equal(p.rating, null);
  assert.match(p.apple_maps, /ll=52\.521,13\.402/);
  assert.equal(calls.length, 2, 'a box search that finds nothing widens once');
  assert.match(calls[0].url, /viewbox=.*&bounded=1/);
  assert.match(calls[0].headers['User-Agent'], /ClosedHand/);
});
test('coordinates reverse to an address and an address forwards to coordinates', async () => {
  const back = await maps.geocode('52.52, 13.40');
  assert.match(back.formatted_address, /Example Café/);
  const fwd = await maps.geocode('87 Musterweg');
  assert.equal(fwd.latitude, 52.521);
  assert.equal(fwd.source, 'OpenStreetMap');
});
test('directions come by car, on foot or by bike with no key, shaped like Google, and public transport says it needs a maps service', async () => {
  calls.length = 0;
  const out = await maps.directions('87 Musterweg', '52.52, 13.40', 'walking');
  assert.equal(out.distance, '2.5 km');
  assert.equal(out.duration, '31 min');
  assert.deepEqual(out.steps.map((s) => s.instruction), ['Start on Musterweg', 'Turn left onto Beispielstraße', 'Arrive']);
  assert.match(calls.at(-1).url, /routing\.openstreetmap\.de\/routed-foot\/route\/v1\/foot\/13\.402,52\.521;13\.4,52\.52\?/);
  assert.match(calls.at(-1).headers['User-Agent'], /ClosedHand/);
  assert.equal(out.source, 'OpenStreetMap');
  assert.equal((await maps.directions('A', 'B', 'scooter')).mode, 'driving', 'an unknown mode drives');
  calls.length = 0;
  const transit = await maps.directions('87 Musterweg', 'Hauptbahnhof', 'transit');
  assert.match(transit.error, /Public transport routes aren't available/);
  assert.match(transit.google_maps, /travelmode=transit/);
  assert.equal(calls.length, 0, 'nothing is asked of a service that has no public transport');
});
test('air quality comes from Open-Meteo with no key', async () => {
  const out = await maps.airQuality(52.52, 13.4, 'Berlin');
  assert.equal(out.aqi, 34);
  assert.equal(out.category, 'Fair');
  assert.equal(out.source, 'Open-Meteo');
});
test('every maps tool is offered without a key, since each has a free way', () => {
  const saved = process.env.GOOGLE_MAPS_API_KEY;
  delete process.env.GOOGLE_MAPS_API_KEY;
  for (const name of ['maps_directions', 'maps_search_places', 'maps_geocode', 'air_quality']) assert.equal(usable(INTERNAL_TOOLS.find(t => t.name === name)), true, name);
  if (saved !== undefined) process.env.GOOGLE_MAPS_API_KEY = saved;
});

test('an airport code gives the airport, the town it is in and where it is, and nothing that is not an airport', async () => {
  assert.deepEqual(await maps.airport('xyz'), { name: 'Heron Field Airport', town: 'Heronton', latitude: 35.55, longitude: 139.78 });
  assert.equal(await maps.airport('QQQ'), null);
  assert.equal(await maps.airport('not a code'), null);
});
