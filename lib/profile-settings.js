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

// change: an object of keys to set (undefined or null removes a key), or a
// function given the current settings that changes them in place.
async function updateSettings(userId, change, { store } = {}) {
  const current = await supabase.from("profiles").select("settings").eq("id", userId).single();
  if (current.error) throw new Error(current.error.message);
  const settings = { ...((current.data && current.data.settings) || {}) };
  if (typeof change === "function") change(settings);
  else for (const [k, v] of Object.entries(change || {})) { if (v === null || v === undefined) delete settings[k]; else settings[k] = v; }
  const { error } = await supabase.from("profiles").update({ settings, updated_at: new Date().toISOString() }).eq("id", userId);
  if (error) throw new Error(error.message);
  if (store && store.profile) store.profile.settings = settings;
  return settings;
}

module.exports = { updateSettings };
