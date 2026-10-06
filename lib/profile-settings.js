// lib/profile-settings.js: change the person's settings against what is saved
// now, never against a copy loaded earlier.
//
// The bot loads the profile at the start of a turn and used to write that
// whole settings copy back when it saved. The dashboard writes the same row,
// so anything changed there meanwhile (a temperature unit clicked, a Pulse
// level set, a location from the browser) was quietly undone by the next
// chat turn or Pulse check. Every bot-side settings write goes through here:
// read the row, change only what was meant, write it, and refresh the copy.

const { supabase } = require("./db");
const { changeSettings, patchSettings } = require("./settings-patch");

// change: an object of keys to set (undefined or null removes a key), or a
// function given the current settings that changes them in place. Only the
// keys that changed are written, inside the database (settings-patch.js); a
// failed read writes nothing.
async function updateSettings(userId, change, { store } = {}) {
  let settings;
  if (typeof change === "function") {
    settings = await changeSettings(supabase, userId, change);
  } else {
    const set = {}, unset = [];
    for (const [k, v] of Object.entries(change || {})) { if (v === null || v === undefined) unset.push(k); else set[k] = v; }
    settings = await patchSettings(supabase, userId, { set, unset });
  }
  if (store && store.profile) store.profile.settings = settings;
  return settings;
}

module.exports = { updateSettings };
