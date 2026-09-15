const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const calls = [];
const httpPath = require.resolve('../lib/http');
require.cache[httpPath] = { id: httpPath, filename: httpPath, loaded: true, exports: { httpGet: async (url, headers) => {
  calls.push({ url, headers });
  if (url.includes('/reverse')) return { statusCode: 200, body: JSON.stringify({ lat: '10.78', lon: '106.69', display_name: 'Cộng Cà Phê, 274, Hai Bà Trưng' }) };
  if (url.includes('bounded=1')) return { statusCode: 200, body: '[]' };
  return { statusCode: 200, body: JSON.stringify([{ name: 'Matcha The Club', display_name: 'Matcha The Club, 87 Trương Định', lat: '10.789', lon: '106.688', category: 'amenity', type: 'cafe', extratags: { opening_hours: 'Mo-Su 08:00-22:00' } }]) };
} } };
const maps = require('../lib/maps-fallback');
const { INTERNAL_TOOLS, usable } = require('../lib/tools/definitions');
test('places come back in the same shape as Google, with a name, links and hours', async () => {
  const out = await maps.searchPlaces('matcha cafe', [10.7888, 106.6907], 800);
  assert.equal(out.count, 1);
  const p = out.places[0];
  assert.equal(p.name, 'Matcha The Club');
  assert.equal(p.hours, 'Mo-Su 08:00-22:00');
  assert.equal(p.rating, null);
  assert.match(p.apple_maps, /ll=10\.789,106\.688/);
  assert.equal(calls.length, 2, 'a box search that finds nothing widens once');
  assert.match(calls[0].url, /viewbox=.*&bounded=1/);
  assert.match(calls[0].headers['User-Agent'], /ClosedHand/);
});
test('coordinates reverse to an address and an address forwards to coordinates', async () => {
  const back = await maps.geocode('10.78, 106.69');
  assert.match(back.formatted_address, /Cộng Cà Phê/);
  const fwd = await maps.geocode('87 Trương Định');
  assert.equal(fwd.latitude, 10.789);
  assert.equal(fwd.source, 'OpenStreetMap');
});
test('a tool that needs a key the install lacks is not offered', () => {
  const directions = INTERNAL_TOOLS.find(t => t.name === 'maps_directions');
  const search = INTERNAL_TOOLS.find(t => t.name === 'maps_search_places');
  const saved = process.env.GOOGLE_MAPS_API_KEY;
  delete process.env.GOOGLE_MAPS_API_KEY;
  assert.equal(usable(directions), false);
  assert.equal(usable(search), true, 'search has a keyless fallback and stays');
  process.env.GOOGLE_MAPS_API_KEY = 'k';
  assert.equal(usable(directions), true);
  if (saved === undefined) delete process.env.GOOGLE_MAPS_API_KEY; else process.env.GOOGLE_MAPS_API_KEY = saved;
});
