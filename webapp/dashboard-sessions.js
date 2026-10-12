// Dashboard sign-ins. Each sign-in gets its own random session, kept in the
// database only as a hash (migrations/058_dashboard_sessions.sql), so any one
// can be ended: logging out ends that browser's, and a new password ends them
// all. Before, every sign-in got the same signed value for a year, which
// neither logging out nor changing the password could take back.
//
// A session made with the password (and, through the personal URL, the code
// sent to the person's chat app) lasts 30 days from its last use. One made
// by Telegram's in-app sign-in keeps the length it was given and does not
// stretch. check() reports the kind, so the server can ask for the code-made
// kind through the personal URL. Each session also carries a fingerprint of the password it was
// made under, so a password changed any way at all (the setup page, or
// ADMIN_PASSWORD in .env) ends every session made before it.
const crypto = require("crypto");

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_SEC = 30 * 24 * 60 * 60;
const RECHECK_MS = 60 * 1000; // trust a checked session this long before asking the database again
const TABLE = "dashboard_sessions";
const STRETCHES = new Set(["password", "password+code"]);

const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

// The stored password is already a salted scrypt hash, so a plain hash of it
// is enough. A password from .env is plain text, so its fingerprint is an
// HMAC under a key of its own derived from the encryption key: without that
// key the fingerprint in the database can't be tested against guesses, and
// it differs on every computer. It was once scrypt under a salt every
// computer shared.
const _envFp = new Map();
function passwordFingerprint({ envPassword, storedHash }) {
  if (envPassword) {
    if (!_envFp.has(envPassword)) _envFp.set(envPassword, "env2:" + crypto.createHmac("sha256", require("./crypto-tokens").subkey("dashboard-session-fingerprint")).update(envPassword).digest("hex"));
    return _envFp.get(envPassword);
  }
  if (storedHash) return "hash:" + crypto.createHash("sha256").update("closedhand-dashboard-session\0" + storedHash).digest("hex");
  return null;
}

// db: the supabase-style client. password(): resolves { envPassword, storedHash }.
// ended: optional { load(), save(map) } keeping sessions signed out while the
// database couldn't be told, so a restart still refuses them.
function createSessions({ db, password, now = () => Date.now(), ended = null, retryMs = 30 * 1000 }) {
  const known = new Map(); // token hash -> { expires, fp, kind, checkedAt }
  // Signing out deletes the session's row. If the database can't take the
  // delete just then, the session is still ended here at once: its hash is
  // refused from this list, kept on disk, and the delete is tried again until
  // it goes through. Before, a failed delete cleared only the browser's
  // cookie and left the session good until it ran out.
  const pending = new Map(); // token hash -> when the session would have run out
  for (const [hash, until] of Object.entries((ended && ended.load()) || {})) if (until > now()) pending.set(hash, until);
  let retryTimer = null;
  function savePending() {
    if (ended) ended.save(Object.fromEntries(pending));
  }
  async function retryPending() {
    retryTimer = null;
    for (const [hash, until] of pending) {
      if (until <= now()) { pending.delete(hash); continue; }
      const { error } = await db.from(TABLE).delete().eq("token_hash", hash);
      if (!error) pending.delete(hash);
    }
    savePending();
    if (pending.size) scheduleRetry();
  }
  function scheduleRetry() {
    if (retryTimer || !retryMs) return;
    retryTimer = setTimeout(() => { retryPending().catch(() => scheduleRetry()); }, retryMs);
    if (retryTimer.unref) retryTimer.unref();
  }
  if (pending.size) scheduleRetry();

  async function currentFp() {
    return passwordFingerprint(await password());
  }

  async function start({ kind = "password", lastsSec = SESSION_SEC } = {}) {
    const fp = await currentFp();
    if (!fp) throw new Error("no dashboard password is set");
    const token = crypto.randomBytes(32).toString("base64url");
    const hash = hashToken(token);
    const expires = now() + lastsSec * 1000;
    const { error } = await db.from(TABLE).insert({ token_hash: hash, kind, password_fp: fp, expires_at: new Date(expires).toISOString() });
    if (error) throw new Error(error.message);
    known.set(hash, { expires, fp, kind, checkedAt: now() });
    // Clear out sessions that ran out; nothing waits on this.
    Promise.resolve(db.from(TABLE).delete().lt("expires_at", new Date(now()).toISOString())).catch(() => {});
    return { token, maxAgeSec: lastsSec };
  }

  // { ok, kind, refreshSec }: refreshSec is set when the session was
  // stretched and the browser's cookie should be sent again with that lifetime.
  async function check(token) {
    if (!token) return { ok: false };
    const hash = hashToken(token);
    if (pending.has(hash)) return { ok: false };
    let s = known.get(hash);
    if (!s || now() - s.checkedAt > RECHECK_MS) {
      const { data, error } = await db.from(TABLE).select("kind, password_fp, expires_at").eq("token_hash", hash).maybeSingle();
      if (error) {
        // The database can't be read just now (a restart, say). A session
        // this process already checked stays good: it can only have been
        // ended here, and ending it here forgets it at once.
        if (!s) return { ok: false };
      } else if (!data) {
        known.delete(hash);
        return { ok: false };
      } else {
        s = { expires: Date.parse(data.expires_at), fp: data.password_fp, kind: data.kind, checkedAt: now() };
        known.set(hash, s);
      }
    }
    const fp = await currentFp();
    if (!fp || s.fp !== fp || s.expires <= now()) {
      known.delete(hash);
      return { ok: false };
    }
    // Stretch a password session at most once a day.
    if (STRETCHES.has(s.kind) && s.expires - now() < SESSION_SEC * 1000 - DAY_MS) {
      const expires = now() + SESSION_SEC * 1000;
      const { error } = await db.from(TABLE).update({ expires_at: new Date(expires).toISOString() }).eq("token_hash", hash);
      if (!error) {
        s.expires = expires;
        return { ok: true, kind: s.kind, refreshSec: SESSION_SEC };
      }
    }
    return { ok: true, kind: s.kind };
  }

  // { ended: true } once the row is gone; { ended: true, pending: true } when
  // the database refused the delete and the session is refused here instead.
  async function end(token) {
    if (!token) return { ended: false };
    const hash = hashToken(token);
    known.delete(hash);
    let failure = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { error } = await Promise.resolve(db.from(TABLE).delete().eq("token_hash", hash)).catch((e) => ({ error: e }));
      if (!error) return { ended: true };
      failure = error;
    }
    pending.set(hash, now() + SESSION_SEC * 1000);
    savePending();
    scheduleRetry();
    return { ended: true, pending: true, reason: failure.message };
  }

  // The stored password was hashed again at a higher cost: the same password,
  // so the sessions made with it carry on under its new fingerprint.
  async function carry(before, after) {
    const from = passwordFingerprint(before), to = passwordFingerprint(after);
    if (!from || !to || from === to) return;
    const { error } = await db.from(TABLE).update({ password_fp: to }).eq("password_fp", from);
    if (error) throw new Error(error.message);
    for (const s of known.values()) if (s.fp === from) s.fp = to;
  }

  async function endAll() {
    known.clear();
    const { error } = await db.from(TABLE).delete().neq("token_hash", "");
    if (error) throw new Error(error.message);
  }

  return { start, check, end, endAll, retryPending, carry };
}

module.exports = { createSessions, passwordFingerprint, hashToken, SESSION_SEC };
