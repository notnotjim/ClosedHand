// Dashboard sign-ins. Each sign-in gets its own random session, kept in the
// database only as a hash (migrations/058_dashboard_sessions.sql), so any one
// can be ended: logging out ends that browser's, and a new password ends them
// all. Before, every sign-in got the same signed value for a year, which
// neither logging out nor changing the password could take back.
//
// A session made with the password lasts 30 days from its last use. One made
// by Telegram's in-app sign-in keeps the length it was given and does not
// stretch. Each session also carries a fingerprint of the password it was
// made under, so a password changed any way at all (the setup page, or
// ADMIN_PASSWORD in .env) ends every session made before it.
const crypto = require("crypto");

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_SEC = 30 * 24 * 60 * 60;
const RECHECK_MS = 60 * 1000; // trust a checked session this long before asking the database again
const TABLE = "dashboard_sessions";

const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

// The stored password is already a salted scrypt hash, so a plain hash of it
// is enough. A password from .env is plain text and must not be kept in a
// quickly reversible form, so it goes through scrypt (once per value).
const _envFp = new Map();
function passwordFingerprint({ envPassword, storedHash }) {
  if (envPassword) {
    if (!_envFp.has(envPassword)) _envFp.set(envPassword, "env:" + crypto.scryptSync(envPassword, "closedhand-dashboard-session", 32).toString("hex"));
    return _envFp.get(envPassword);
  }
  if (storedHash) return "hash:" + crypto.createHash("sha256").update("closedhand-dashboard-session\0" + storedHash).digest("hex");
  return null;
}

// db: the supabase-style client. password(): resolves { envPassword, storedHash }.
function createSessions({ db, password, now = () => Date.now() }) {
  const known = new Map(); // token hash -> { expires, fp, kind, checkedAt }

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

  // { ok, refreshSec }: refreshSec is set when the session was stretched and
  // the browser's cookie should be sent again with that lifetime.
  async function check(token) {
    if (!token) return { ok: false };
    const hash = hashToken(token);
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
    if (s.kind === "password" && s.expires - now() < SESSION_SEC * 1000 - DAY_MS) {
      const expires = now() + SESSION_SEC * 1000;
      const { error } = await db.from(TABLE).update({ expires_at: new Date(expires).toISOString() }).eq("token_hash", hash);
      if (!error) {
        s.expires = expires;
        return { ok: true, refreshSec: SESSION_SEC };
      }
    }
    return { ok: true };
  }

  async function end(token) {
    if (!token) return;
    const hash = hashToken(token);
    known.delete(hash);
    const { error } = await db.from(TABLE).delete().eq("token_hash", hash);
    if (error) throw new Error(error.message);
  }

  async function endAll() {
    known.clear();
    const { error } = await db.from(TABLE).delete().neq("token_hash", "");
    if (error) throw new Error(error.message);
  }

  return { start, check, end, endAll };
}

module.exports = { createSessions, passwordFingerprint, hashToken, SESSION_SEC };
