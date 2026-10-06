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
let _failed = false;

async function _load() {
  const now = Date.now();
  if (_cache && !_failed && now - _cacheAt < CACHE_MS) return _cache;
  try {
    const { supabase, isDbConfigured } = require("./db");
    if (!isDbConfigured()) { _cache = {}; _cacheAt = now; _failed = false; return _cache; }
    const { getAdminUserId } = require("./admin");
    const { data, error } = await supabase.from("profiles").select("settings").eq("id", getAdminUserId()).maybeSingle();
    if (error) throw new Error(error.message);
    _cache = (data && data.settings && data.settings.self_host_config) || {};
    _failed = false;
  } catch (_) {
    // A failed read, as happens for a moment while the database restarts,
    // is not "no settings": keep what was known, remember that this read
    // failed (getConfStrict), and try again on the next call.
    _failed = true;
    return _cache || {};
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

// The same, but throws when the settings could not be read just now, for a
// caller that must tell "not set" from "unknown": an unreadable password must
// lock the dashboard, never open it.
async function getConfStrict(key) {
  const env = process.env[key];
  if (env !== undefined && env !== "") return env;
  const conf = await _load();
  if (_failed) throw new Error("settings could not be read");
  return conf[key];
}

// Merge a patch into self_host_config (the wizard's write path; webapp only in
// practice). Null values delete keys.
async function setConf(patch) {
  const { supabase } = require("./db");
  const { getAdminUserId } = require("./admin");
  // Only these keys change, inside the database (settings-patch.js). Writing
  // back a whole copy is how a failed read wiped every setting, and how the
  // bot's model-download progress and the setup page's answers undid each
  // other.
  const confSet = {}, confUnset = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) confUnset.push(k);
    else confSet[k] = v;
  }
  const settings = await require("./settings-patch").patchSettings(supabase, getAdminUserId(), { confSet, confUnset });
  const conf = settings.self_host_config || {};
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

// Outbound chat links need an HTTPS address reachable off this computer.
// Await the first config read; the synchronous cache can be empty at startup.
// Prefer an operator's permanent address over a temporary phone tunnel.
async function dashboardBase() {
  const candidates = [await getConf("WEBAPP_URL"), await getConf("BASE_URL")];
  if (String(await getConf("PHONE_ACCESS")) === "1") candidates.push(await getConf("PHONE_ACCESS_URL"));
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      const host = url.hostname;
      if (url.protocol !== "https:" || url.username || url.password) continue;
      if (!host.includes(".") || /(^|\.)(localhost|local|internal)$/.test(host)) continue;
      if (/^(127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) continue;
      if (url.search || url.hash) continue;
      return url.href.replace(/\/$/, "");
    } catch (_) { /* Not a usable public address. */ }
  }
  return null;
}

module.exports = { getConf, getConfStrict, setConf, invalidateConf, getConfCached, dashboardBase };
