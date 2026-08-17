// lib/config.js — runtime configuration for the self-host wizard.
//
// The setup wizard writes config here (the admin profile's
// settings.self_host_config) so a user never edits files or restarts
// containers; both processes read it live. Env always wins: an operator who
// sets TELEGRAM_BOT_TOKEN in the environment keeps exactly today's behaviour,
// and the DB only fills the gaps. Reads are cached briefly, so a saved key is
// live everywhere within a few seconds.
//
// Vendored duplicate: lib/config.js and webapp/config.js must stay byte-identical
// (both resolve ./db and ./admin within their own service).

const CACHE_MS = 3000;

let _cache = null;
let _cacheAt = 0;

async function _load() {
  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_MS) return _cache;
  try {
    const { supabase, isDbConfigured } = require("./db");
    if (!isDbConfigured()) { _cache = {}; _cacheAt = now; return _cache; }
    const { getAdminUserId } = require("./admin");
    const { data } = await supabase.from("profiles").select("settings").eq("id", getAdminUserId()).single();
    _cache = (data && data.settings && data.settings.self_host_config) || {};
  } catch (_) {
    _cache = _cache || {};
  }
  _cacheAt = now;
  return _cache;
}

// Env wins; DB fills the gaps. Returns undefined when neither has it.
async function getConf(key) {
  const env = process.env[key];
  if (env !== undefined && env !== "") return env;
  const conf = await _load();
  return conf[key];
}

// Merge a patch into self_host_config (the wizard's write path; webapp only in
// practice). Null values delete keys.
async function setConf(patch) {
  const { supabase } = require("./db");
  const { getAdminUserId } = require("./admin");
  const adminId = getAdminUserId();
  const { data } = await supabase.from("profiles").select("settings").eq("id", adminId).single();
  const settings = (data && data.settings) || {};
  const conf = { ...(settings.self_host_config || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete conf[k];
    else conf[k] = v;
  }
  settings.self_host_config = conf;
  const { error } = await supabase
    .from("profiles")
    .update({ settings, updated_at: new Date().toISOString() })
    .eq("id", adminId);
  if (error) throw new Error(error.message || error.code);

  // Two processes write this one settings blob: the webapp saves wizard
  // answers while the bot writes local-model download progress every few
  // seconds. Both read-modify-write the whole object, so a write landing
  // between another's read and write silently reverts it. That is how an
  // install ended up with RERANK_MODEL set and EMBED_MODEL missing, which
  // reads as "memory is on" while nothing is ever indexed. Confirm the keys
  // actually survived, and put them back if they did not.
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: after } = await supabase.from("profiles").select("settings").eq("id", adminId).single();
    const live = (after && after.settings && after.settings.self_host_config) || {};
    const lost = Object.entries(patch).filter(([k, v]) => v !== null && v !== undefined && live[k] !== v);
    if (!lost.length) break;
    const merged = { ...live };
    for (const [k, v] of lost) merged[k] = v;
    const nextSettings = { ...((after && after.settings) || {}), self_host_config: merged };
    await supabase.from("profiles").update({ settings: nextSettings, updated_at: new Date().toISOString() }).eq("id", adminId);
  }

  _cache = conf;
  _cacheAt = Date.now();
  return conf;
}

function invalidateConf() { _cache = null; _cacheAt = 0; }

// Synchronous read from the cache, for call sites that cannot await (usi.js
// hot paths, getInternalClient). A background refresh keeps the cache warm;
// until the first load completes this returns only env values, which is fine
// because everything here is also re-read on the next call.
let _refresher = null;
function getConfCached(key) {
  const env = process.env[key];
  if (env !== undefined && env !== "") return env;
  if (!_refresher) {
    _load().catch(() => {});
    _refresher = setInterval(() => { _cacheAt = 0; _load().catch(() => {}); }, 5000);
    if (_refresher.unref) _refresher.unref();
  }
  return _cache ? _cache[key] : undefined;
}

module.exports = { getConf, setConf, invalidateConf, getConfCached };
