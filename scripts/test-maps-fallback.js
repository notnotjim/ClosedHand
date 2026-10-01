const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const calls = [];
const httpPath = require.resolve('../lib/http');
require.cache[httpPath] = { id: httpPath, filename: httpPath, loaded: true, exports: { httpGet: async (url, headers) => {
  calls.push({ url, headers });
  if (url.includes('/reverse')) return { statusCode: 200, body: JSON.stringify({ lat: '52.52', lon: '13.40', display_name: 'Example Café, 274, Beispielstraße' }) };
  if (url.includes('bounded=1')) return { statusCode: 200, body: '[]' };
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
