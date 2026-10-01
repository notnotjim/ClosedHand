// webapp/db.js — Lazy Supabase client so the webapp boots with no DB configured.
//
// createClient() throws synchronously at import ("supabaseUrl is required.") when
// the URL/key are missing, which made a zero-key first-run boot impossible. This
// module defers construction to first *use*, and when the DB is not configured it
// returns a guard whose queries resolve to `{ data: null, error }` instead of
// throwing — so the webapp can serve first-run setup rather than crashing. When the
// DB is configured, every call forwards to the real client unchanged.
//
// This is a copy of lib/db.js. The webapp is a separate Railway service and cannot
// import lib/, so the two files must be kept in sync (same as crypto-tokens.js).

const { createClient } = require("@supabase/supabase-js");

// Which backend to use. Inference, not a fixed default, so a Supabase deployment
// (creds set, DB_DRIVER unset) is never silently switched: an explicit DB_DRIVER
// wins (but only if its creds are present); else Supabase if configured; else the
// vanilla-pg driver if DATABASE_URL is set (the OSS container default); else null
// = unconfigured -> setup mode.
function activeDriver() {
  const explicit = process.env.DB_DRIVER;
  const haveSupabase = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
  const havePg = !!process.env.DATABASE_URL;
  if (explicit === "supabase") return haveSupabase ? "supabase" : null;
  if (explicit === "pg") return havePg ? "pg" : null;
  if (haveSupabase) return "supabase";
  if (havePg) return "pg";
  return null;
}

function isDbConfigured() {
  return activeDriver() !== null;
}

// Storage backend for the pg path (the supabase path keeps supabase-js Storage).
// Default: local disk, with the app serving /storage/logos/* itself (one box, no
// external accounts). STORAGE_DRIVER=s3 selects an optional S3-compatible driver.
function buildStorage() {
  const which = (process.env.STORAGE_DRIVER || "local").toLowerCase();
  const baseUrl = process.env.BASE_URL || "";
  if (which === "s3") throw new Error("STORAGE_DRIVER=s3 is not implemented yet; use the default local driver (unset STORAGE_DRIVER or set 'local'). S3-compatible support is a planned optional config.");
  return require("./storage-driver-local").createLocalStorage({ dir: process.env.STORAGE_DIR || "./data/storage", baseUrl });
}

let _client = null;
let _tried = false;
function realClient() {
  if (!_tried) {
    _tried = true;
    const driver = activeDriver();
    if (driver === "supabase") {
      _client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    } else if (driver === "pg") {
      // pg is require()d lazily inside the factory, so the supabase path and the
      // not-configured guard never depend on pg being installed.
      _client = require("./db-driver-pg").createPgClient({ connectionString: process.env.DATABASE_URL });
      _client.storage = buildStorage(); // real storage instead of the data driver's stub
      const rt = require("./realtime-driver-poll").createPollRealtime(_client);
      _client.channel = rt.channel;
      _client.removeChannel = rt.removeChannel;
      _client.removeAllChannels = rt.removeAllChannels;
    }
  }
  return _client;
}

const NOT_CONFIGURED = {
  message: "Database not configured. Complete first-run setup to connect a database.",
  code: "DB_NOT_CONFIGURED",
};
const notConfiguredResult = () => Promise.resolve({ data: null, error: NOT_CONFIGURED });

// Stand-in for the PostgREST query builder: every chained method returns the same
// proxy (so `.select().eq().order().single()...` all chain), and awaiting it yields
// `{ data: null, error }`. Covers `.range()`, `.maybeSingle()`, count-head, etc.
function guardBuilder() {
  const settled = notConfiguredResult();
  const proxy = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return settled.then.bind(settled);
      if (prop === "catch") return settled.catch.bind(settled);
      if (prop === "finally") return settled.finally.bind(settled);
      return () => proxy;
    },
    apply() { return proxy; },
  });
  return proxy;
}

const guardStorageBucket = {
  upload: notConfiguredResult,
  download: notConfiguredResult,
  remove: notConfiguredResult,
  list: notConfiguredResult,
  createSignedUrl: notConfiguredResult,
  getPublicUrl: () => ({ data: { publicUrl: "" } }),
};

const guard = {
  from: () => guardBuilder(),
  rpc: () => notConfiguredResult(),
  storage: { from: () => guardStorageBucket },
  channel: () => {
    const ch = { on: () => ch, subscribe: () => ch, unsubscribe: () => ch };
    return ch;
  },
  removeChannel: () => {},
  removeAllChannels: () => {},
};

// Forward to the real client when configured, else to the guard. Property access
// is lazy, so importing this module never touches createClient.
const supabase = new Proxy({}, {
  get(_t, prop) {
    const target = realClient() || guard;
    const v = target[prop];
    return typeof v === "function" ? v.bind(target) : v;
  },
});

module.exports = { supabase, isDbConfigured };
