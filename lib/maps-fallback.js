// lib/maps-fallback.js -- places and addresses with no key.
//
// The maps tools are Google, which needs a paid key and a billing account most
// self-hosters will not have, so "what's around here" came back with a
// configuration error. A linked Google account does not help: Maps Platform
// is a separate product from the account. OpenStreetMap's Nominatim answers a
// plain GET with no key or account; this shapes its results like Google's.
// A fallback, not a replacement: Google stays first when its key is present.
// Nominatim asks for one request a second and a real User-Agent; both kept.
const { httpGet } = require("./http");

const BASE = "https://nominatim.openstreetmap.org";
const HEADERS = { "User-Agent": "ClosedHand/1.0 (self-hosted assistant; https://github.com/notnotjim/ClosedHand)", "Accept": "application/json" };
const GAP_MS = 1100;
let _last = Promise.resolve();
let _lastAt = 0;

// One request at a time, a second apart, whoever is asking.
function paced(url) {
  const run = _last.then(async () => {
    const wait = _lastAt + GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    _lastAt = Date.now();
    const { body, statusCode } = await httpGet(url, HEADERS);
    if (statusCode >= 400) throw new Error(`HTTP ${statusCode} from OpenStreetMap`);
    return JSON.parse(body);
  });
  _last = run.catch(() => {});
  return run;
}

function links(name, lat, lon) {
  return {
    google_maps: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name ? name + " " : "")}${lat},${lon}`.replace("query=%20", "query="),
    apple_maps: `https://maps.apple.com/?ll=${lat},${lon}${name ? "&q=" + encodeURIComponent(name) : ""}`,
  };
}

function shapePlace(r) {
  const lat = Number(r.lat), lon = Number(r.lon);
  const name = r.name || (r.display_name || "").split(",")[0];
  const hours = r.extratags?.opening_hours || null;
  return {
    name,
    address: r.display_name,
    latitude: lat,
    longitude: lon,
    rating: null,
    open_now: null,
    hours,
    type: [r.category, r.type].filter(Boolean).join(": "),
    ...links(name, lat, lon),
  };
}

async function geocode(address) {
  const coords = String(address || "").match(/^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/);
  const data = coords
    ? await paced(`${BASE}/reverse?lat=${coords[1]}&lon=${coords[2]}&format=jsonv2`)
    : (await paced(`${BASE}/search?q=${encodeURIComponent(address)}&format=jsonv2&limit=1`))[0];
  if (!data || data.error) throw new Error("No match for that address.");
  const lat = Number(data.lat), lon = Number(data.lon);
  return { formatted_address: data.display_name, latitude: lat, longitude: lon, ...links(null, lat, lon), source: "OpenStreetMap" };
}

// Search within a box around the centre first; if that finds nothing, widen.
async function searchPlaces(query, centre, radius = 5000) {
  const q = encodeURIComponent(query);
  let results = [];
  if (centre) {
    const [lat, lon] = centre;
    const dLat = radius / 111320, dLon = radius / (111320 * Math.cos(lat * Math.PI / 180));
    const box = `${lon - dLon},${lat + dLat},${lon + dLon},${lat - dLat}`;
    results = await paced(`${BASE}/search?q=${q}&format=jsonv2&limit=10&extratags=1&viewbox=${box}&bounded=1`);
  }
  if (!results.length) results = await paced(`${BASE}/search?q=${q}&format=jsonv2&limit=10&extratags=1`);
  const places = (results || []).map(shapePlace);
  return { places, count: places.length, query, source: "OpenStreetMap",
    note: "Names, addresses and map links from OpenStreetMap. It has no ratings or reviews; search the web if the user wants those.",
    _hint: "Call send_location for your top 1-2 picks so the user gets a tappable map pin." };
}

module.exports = { geocode, searchPlaces, shapePlace };
