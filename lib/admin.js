// lib/admin.js — Single-tenant admin identity.
//
// The self-host edition is strictly one user (the owner). Rather than editing the
// ~130 sites that consume a userId, identity funnels through three seams
// (getUserIdFromRequest, getUserByPlatform, createAnonymousUser) that all resolve
// to the single admin id returned here.
//
// ensureAdmin() is idempotent, memoised, and race-safe across the two processes:
// it adopts an existing sole profile (so pointing at an existing DB just works),
// else creates one with a fixed sentinel id via ON CONFLICT DO NOTHING, so the bot
// and webapp converge on the same id even booting simultaneously against a fresh
// DB. Override the id with ADMIN_USER_ID.
//
// Vendored duplicate: webapp/admin.js must be kept byte-identical.

const { supabase } = require("./db");

const ADMIN_SENTINEL_ID = "00000000-0000-0000-0000-0000000000ad";

let _cachedId = null;
let _bootstrap = null;

async function _doEnsure() {
  const envId = process.env.ADMIN_USER_ID;
  if (envId) {
    await supabase.from("profiles").upsert({ id: envId }, { onConflict: "id" });
    _cachedId = envId;
    return _cachedId;
  }

  // Adopt the existing sole/first profile if the DB already has one.
  const { data: existing } = await supabase
    .from("profiles")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existing && existing.id) {
    _cachedId = existing.id;
    return _cachedId;
  }

  // Fresh install: create the admin with a fixed id so both processes converge.
  // No placeholder name: onboarding reads the profile name as the person's
  // own and would greet them as "Admin" instead of asking.
  await supabase
    .from("profiles")
    .upsert({ id: ADMIN_SENTINEL_ID }, { onConflict: "id" });
  _cachedId = ADMIN_SENTINEL_ID;
  return _cachedId;
}

// Idempotent + memoised: concurrent callers (module-load kick, boot await, first
// request) share one bootstrap.
function ensureAdmin() {
  if (_cachedId) return Promise.resolve(_cachedId);
  if (!_bootstrap) _bootstrap = _doEnsure().catch((e) => { _bootstrap = null; throw e; });
  return _bootstrap;
}

// Synchronous accessor for the identity seams. Boot awaits ensureAdmin() before
// serving, so this is warm in practice; the fallback keeps it deterministic and
// never-throwing for any cold edge (the sentinel is what a fresh install creates).
function getAdminUserId() {
  return _cachedId || process.env.ADMIN_USER_ID || ADMIN_SENTINEL_ID;
}

module.exports = { ensureAdmin, getAdminUserId, ADMIN_SENTINEL_ID };
