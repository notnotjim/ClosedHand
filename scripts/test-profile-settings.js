// The bot changes the person's settings against what is saved now, never
// against the copy it loaded at the start of a turn. That copy, written back
// whole, undid whatever the dashboard changed meanwhile: a temperature unit
// clicked during a Pulse check was gone a moment later.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

// Applies patch_profile_settings the way migrations/057 does.
function applyPatch(row, a) {
  const next = { ...row };
  for (const k of a.p_unset || []) delete next[k];
  for (const [k, v] of Object.entries(a.p_set || {})) if (k !== "self_host_config") next[k] = v;
  const conf = { ...(row.self_host_config || {}) };
  for (const k of a.p_conf_unset || []) delete conf[k];
  Object.assign(conf, a.p_conf_set || {});
  next.self_host_config = conf;
  return next;
}
function withDb(row, fn) {
  const db = { row, writes: 0, from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { settings: structuredClone(db.row) }, error: null }) }) }),
  }), rpc: async (name, args) => { db.row = applyPatch(db.row, structuredClone(args)); db.writes++; return { data: [{ patch_profile_settings: structuredClone(db.row) }], error: null }; } };
  const load = Module._load;
  Module._load = function (request, parent, ...rest) {
    if (request === "./db" && parent && /profile-settings\.js$/.test(parent.filename)) return { supabase: db };
    return load.call(this, request, parent, ...rest);
  };
  delete require.cache[require.resolve("../lib/profile-settings")];
  return Promise.resolve().then(() => fn(require("../lib/profile-settings"), db)).finally(() => {
    Module._load = load; delete require.cache[require.resolve("../lib/profile-settings")];
  });
}

test("a change made on the dashboard during a turn survives the turn's own save", async () => {
  await withDb({ location: { name: "Old town" }, pulse_settings: { proactiveLevel: "medium" } }, async ({ updateSettings }, db) => {
    // The turn loaded its copy, then the dashboard saved a choice.
    const store = { profile: { settings: structuredClone(db.row) } };
    db.row.temperature_unit = "F";
    await updateSettings("u1", { location: { name: "New town" } }, { store });
    assert.equal(db.row.temperature_unit, "F", "the dashboard's change is kept");
    assert.deepEqual(db.row.location, { name: "New town" }, "and the turn's change is made");
    assert.equal(store.profile.settings.temperature_unit, "F", "the turn's copy now matches what is saved");
    await updateSettings("u1", (s) => { delete s.temperature_unit; }, { store });
    assert.equal("temperature_unit" in db.row, false, "a change can also remove a key");
  });
});

test("the bot's settings writers all go through it", () => {
  assert.match(read("user-store.js"), /JSON\.stringify\(this\.location \|\| null\) !== JSON\.stringify\(this\.profile\?\.settings\?\.location \|\| null\)\) \{\n\s*promises\.push\(\n\s*require\("\.\/lib\/profile-settings"\)\.updateSettings\(this\.userId, \{ location: this\.location \}, \{ store: this \}\)/, "the location only when it changed, and only that key");
  for (const f of ["lib/onboarding.js", "lib/outbound-guard.js", "lib/bug-reports.js"]) {
    assert.match(read(f), /require\("\.\/profile-settings"\)\.updateSettings\(/, f);
    assert.doesNotMatch(read(f), /from\("profiles"\)\s*\.update\(/, f + " writes no settings copy of its own");
  }
});
