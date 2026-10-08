// lib/maps-lists.js: saving places to a list in the person's own Google Maps.
//
// Google has no way for apps to write to Maps saved lists, so ClosedHand does
// it the way the person would, on maps.google.com in the sandbox computer's
// browser, where they signed in to Google themselves (lib/maps-list-sandbox.py).
// Nothing here sees their password or keeps their Google session.
const fs = require("fs");
const path = require("path");

const SCRIPT = fs.readFileSync(path.join(__dirname, "maps-list-sandbox.py"), "utf8");
// Each place takes 15 to 50 seconds. A run stops starting places after 60
// seconds and hands the rest back (lib/maps-list-sandbox.py), so one run
// never meets the sandbox's two-minute limit; the next run carries on.
const PER_RUN = 6;
const MAX_PLACES = 60;
const userFacing = (message) => Object.assign(new Error(message), { userFacing: true });

async function signInMessage() {
  let base = null;
  try { base = await require("./config").dashboardBase(); } catch { /* no public address */ }
  const where = base ? `${base}/#computers (the Computers tab of the web chat)` : "the Computers tab of the web chat";
  return `Saving to Google Maps needs the person signed in to Google in the browser on ClosedHand's sandbox computer. Ask them to sign in there once, at ${where}; it stays signed in, then ask again.`;
}

async function saveToList({ userId, list, places }) {
  const name = String(list || "").trim().slice(0, 40);
  if (!name) throw userFacing("Give the list a name.");
  const queries = [...new Set((Array.isArray(places) ? places : [])
    .map((p) => (typeof p === "string" ? p : [p?.name, p?.area].filter(Boolean).join(", ")).trim())
    .filter(Boolean))].slice(0, MAX_PLACES);
  if (!queries.length) throw userFacing("There are no places to save.");
  const sandbox = require("./sandbox");
  await sandbox.ensureSandbox(userId);
  const results = [];
  let left = queries;
  for (let runs = 0; left.length && runs < MAX_PLACES; runs++) {
    const batch = left.slice(0, PER_RUN);
    const args = Buffer.from(JSON.stringify({ list: name, places: batch, budget: 60 })).toString("base64");
    const run = await sandbox.sandboxExec(userId, "python", `import base64, json\nARGS = json.loads(base64.b64decode("${args}").decode())\n` + SCRIPT, 120000);
    const line = String(run?.stdout || "").split("\n").reverse().find((l) => l.startsWith("CLOSEDHAND_MAPS "));
    if (!line) throw new Error(run?.error || String(run?.stderr || "").trim().split("\n").pop() || "The sandbox computer didn't answer.");
    const out = JSON.parse(line.slice("CLOSEDHAND_MAPS ".length));
    if (!out.ok && out.kind === "browser") throw userFacing("The browser on ClosedHand's sandbox computer isn't responding. Open the Computers tab, close any tab that shows an error, and try again.");
    if (!out.ok) throw userFacing(await signInMessage());
    results.push(...out.results);
    // Each run is progress: a long list keeps a background task alive
    // instead of reading as stalled (lib/user-mutex.js).
    require("./user-mutex").touchMutexProgress(userId);
    if (!out.results.length) throw new Error("Google Maps didn't respond in time.");
    left = [...(out.left || []), ...left.slice(batch.length)];
  }
  const done = (r) => ["saved", "saved_new_list", "already_saved"].includes(r.status);
  return {
    list: name,
    saved: results.filter(done).map((r) => ({ asked: r.query, found: r.found, address: r.address, link: r.url, already: r.status === "already_saved" })),
    not_found: results.filter((r) => r.status === "not_found").map((r) => r.query),
    // Not saved: Google's nearest places have other names. Ask the person.
    unsure: results.filter((r) => r.status === "unsure").map((r) => ({ asked: r.query, google_has: r.google_has || [] })),
    failed: results.filter((r) => r.status === "failed").map((r) => r.query),
    where: `In Google Maps, open Saved, then the list "${name}".`,
  };
}

module.exports = { saveToList, PER_RUN };
