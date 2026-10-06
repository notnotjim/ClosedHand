// settings-patch.js: vendored. lib/settings-patch.js and webapp/settings-patch.js
// are byte-identical (scripts/vendored-manifest.json).
//
// The one way to change a person's settings: only the keys named change, inside
// the database (migrations/057_patch_profile_settings.sql). Writers used to read
// the settings, change the copy and write the whole copy back. When the read
// failed, during a database restart, the copy was empty, and writing it back
// wiped every setting at once, the dashboard password included; two writers
// that overlapped also undid each other. scripts/test-settings-patch.js fails
// on any whole-object write to profiles.settings outside this file.

const CONF = "self_host_config";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// What changed between two settings objects, key by key at the top level.
function diff(before, after) {
  const b = before || {}, a = after || {};
  const set = {}, unset = [];
  for (const k of Object.keys(a)) if (k !== CONF && !same(a[k], b[k])) set[k] = a[k];
  for (const k of Object.keys(b)) if (k !== CONF && !(k in a)) unset.push(k);
  return { set, unset };
}

// set/unset: top-level settings keys. confSet/confUnset: keys inside
// self_host_config. Returns the settings as saved.
async function patchSettings(db, userId, { set = {}, unset = [], confSet = {}, confUnset = [] } = {}) {
  const { data, error } = await db.rpc("patch_profile_settings", {
    p_id: userId, p_set: set, p_unset: unset, p_conf_set: confSet, p_conf_unset: confUnset,
  });
  if (error) throw new Error(`settings not saved: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  const settings = row && typeof row === "object" && "patch_profile_settings" in row ? row.patch_profile_settings : row;
  if (!settings) throw new Error("settings not saved: no profile row");
  return settings;
}

// Change settings with a function over a copy of them as saved now, writing
// only what the function changed. A failed or empty read writes nothing.
async function changeSettings(db, userId, change) {
  const { data, error } = await db.from("profiles").select("settings").eq("id", userId).maybeSingle();
  if (error) throw new Error(`settings not read: ${error.message}`);
  if (!data) throw new Error("settings not read: no profile row");
  const before = data.settings || {};
  const after = JSON.parse(JSON.stringify(before));
  change(after);
  const top = diff(before, after);
  const conf = diff(before[CONF] || {}, after[CONF] || {});
  if (!Object.keys(top.set).length && !top.unset.length && !Object.keys(conf.set).length && !conf.unset.length) return before;
  return patchSettings(db, userId, { set: top.set, unset: top.unset, confSet: conf.set, confUnset: conf.unset });
}

module.exports = { patchSettings, changeSettings, diff };
