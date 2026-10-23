// lib/maps-fallback.js -- places, addresses, directions and air quality with
// no key.
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
// Place names in English: OpenStreetMap otherwise answers in the local
// language, so "Vietnam" came back as "Việt Nam".
const HEADERS = { "User-Agent": "ClosedHand/1.0 (self-hosted assistant; https://github.com/notnotjim/Closedhand)", "Accept": "application/json", "Accept-Language": "en" };
const GAP_MS = 1100;

// One request at a time to a service, a second apart, whoever is asking:
// both free services ask for no more than one a second.
function pacer(label) {
  let last = Promise.resolve();
  let lastAt = 0;
  return function (url) {
    const run = last.then(async () => {
      const wait = lastAt + GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastAt = Date.now();
      const { body, statusCode } = await httpGet(url, HEADERS);
      if (statusCode >= 400) throw new Error(`HTTP ${statusCode} from ${label}`);
      return JSON.parse(body);
    });
    last = run.catch(() => {});
    return run;
  };
}
const paced = pacer("OpenStreetMap");
// Routes: FOSSGIS's OSRM server, the one openstreetmap.org's own directions
// use. Free for reasonable, non-commercial use, at most one request a second,
// with no promise of uptime, which suits a fallback.
const ROUTER = "https://routing.openstreetmap.de";
const routed = pacer("the route service");
const PROFILES = { driving: "routed-car/route/v1/driving", walking: "routed-foot/route/v1/foot", bicycling: "routed-bike/route/v1/bike" };

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

function distanceText(m) {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}
function durationText(s) {
  const mins = Math.max(1, Math.round(s / 60));
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

// A step in words, from OSRM's manoeuvre: "turn left onto Rua Augusta".
function stepText(step) {
  const m = step.maneuver || {};
  const onto = step.name ? ` onto ${step.name}` : "";
  const way = m.modifier && m.modifier !== "straight" ? ` ${m.modifier}` : "";
  if (m.type === "depart") return `Start${step.name ? ` on ${step.name}` : ""}`;
  if (m.type === "arrive") return "Arrive";
  if (m.type === "roundabout" || m.type === "rotary") return `At the roundabout, take exit ${m.exit || 1}${onto}`;
  if (m.type === "continue" || m.type === "new name") return `Continue${way}${onto}`;
  if (m.type === "fork") return `Keep${way}${onto}`;
  if (m.type === "merge") return `Merge${way}${onto}`;
  if (m.type === "on ramp" || m.type === "off ramp") return `Take the ramp${way}${onto}`;
  return `Turn${way}${onto}`;
}

// Directions with no key: each end found on OpenStreetMap, then the route
// from OSRM, by car, on foot or by bike, shaped like Google's. It has no
// public transport, so asked for transit it says so and gives the map apps'
// links, which can.
async function directions(origin, destination, mode) {
  const how = (PROFILES[mode] || mode === "transit") ? mode : "driving";
  const o = encodeURIComponent(origin), d = encodeURIComponent(destination);
  const apps = {
    google_maps: `https://www.google.com/maps/dir/?api=1&origin=${o}&destination=${d}&travelmode=${how || "driving"}`,
    apple_maps: `https://maps.apple.com/?saddr=${o}&daddr=${d}&dirflg=${how === "walking" ? "w" : how === "transit" ? "r" : "d"}`,
  };
  if (how === "transit") {
    return { ...apps, source: "OpenStreetMap", error: "Public transport routes aren't available without a maps service. Give the user these map links, which open public transport directions; in London, the TfL tools can plan it." };
  }
  const from = await geocode(origin);
  const to = await geocode(destination);
  const data = await routed(`${ROUTER}/${PROFILES[how]}/${from.longitude},${from.latitude};${to.longitude},${to.latitude}?overview=false&steps=true`);
  const route = data && data.code === "Ok" && data.routes && data.routes[0];
  if (!route) throw new Error("No route found between those places.");
  const leg = route.legs[0];
  return {
    summary: leg.summary || null,
    distance: distanceText(route.distance),
    duration: durationText(route.duration),
    departure_time: null,
    arrival_time: null,
    mode: how,
    steps: leg.steps.slice(0, 40).map((s) => ({ instruction: stepText(s), distance: distanceText(s.distance), duration: durationText(s.duration), mode: how, transit: null })),
    from: from.formatted_address,
    to: to.formatted_address,
    ...apps,
    source: "OpenStreetMap",
    note: how === "driving" ? "Route and time from OpenStreetMap. The time doesn't count live traffic." : "Route and time from OpenStreetMap.",
  };
}

// An airport by its IATA code: its name, the town it is in, named as a
// shared browser position is, and where it is. For placing someone who has
// just landed there.
async function airport(code) {
  const iata = String(code || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(iata)) return null;
  const found = (await paced(`${BASE}/search?q=${encodeURIComponent(iata + " airport")}&format=jsonv2&limit=1&addressdetails=1&accept-language=en`))[0];
  if (!found || !/aerodrome|airport/i.test(`${found.type} ${found.category} ${found.name}`)) return null;
  const a = found.address || {};
  return {
    name: found.name || String(found.display_name || "").split(",")[0],
    town: a.city || a.town || a.village || a.municipality || a.county || a.state || null,
    latitude: Number(found.lat),
    longitude: Number(found.lon),
  };
}

// Air quality with no key, from Open-Meteo: free with no account, and where
// the weather comes from. The European index runs from 0 (good) upward.
const AQI_BANDS = [[20, "Good"], [40, "Fair"], [60, "Moderate"], [80, "Poor"], [100, "Very poor"], [Infinity, "Extremely poor"]];
async function airQuality(lat, lng, location) {
  const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lng}&current=european_aqi,us_aqi,pm2_5,pm10,nitrogen_dioxide,ozone&timezone=auto`;
  const { body, statusCode } = await httpGet(url, HEADERS);
  if (statusCode >= 400) throw new Error(`HTTP ${statusCode} from Open-Meteo`);
  const c = JSON.parse(body).current || {};
  const aqi = typeof c.european_aqi === "number" ? c.european_aqi : null;
  return {
    location,
    aqi,
    scale: "European air quality index: 0 to 20 good, 20 to 40 fair, 40 to 60 moderate, 60 to 80 poor, 80 to 100 very poor, above that extremely poor",
    category: aqi === null ? null : AQI_BANDS.find(([top]) => aqi <= top)[1],
    us_aqi: c.us_aqi ?? null,
    pollutants: { pm2_5: c.pm2_5 ?? null, pm10: c.pm10 ?? null, nitrogen_dioxide: c.nitrogen_dioxide ?? null, ozone: c.ozone ?? null, unit: "\u00b5g/m\u00b3" },
    source: "Open-Meteo",
  };
}

module.exports = { geocode, searchPlaces, shapePlace, directions, stepText, airQuality, airport };
