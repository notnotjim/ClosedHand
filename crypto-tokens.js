// crypto-tokens.js — Application-layer encryption for OAuth tokens at rest.
//
// ─────────────────────────────────────────────────────────────────────────────
// SHARED FILE, DO NOT DIVERGE. An identical copy lives at webapp/crypto-tokens.js
// because the webapp is a separate Railway service that ships only its own
// directory and cannot import from the repo root. Both services MUST stay
// byte-identical: if one is patched, patch the other in the same commit, or
// tokens written by one service become undecryptable by the other.
// A test at the bottom of this file (run: node crypto-tokens.js) validates
// roundtrip and prints the file SHA so drift is easy to catch.
// ─────────────────────────────────────────────────────────────────────────────
//
// Envelope: "enc:v1:" + base64(iv || authTag || ciphertext) using AES-256-GCM.
// Keys (env vars, base64-encoded 32 bytes each):
//   TOKEN_ENCRYPTION_KEY      — current key, used for all new encryption
//   TOKEN_ENCRYPTION_KEY_OLD  — optional previous key, used only for decrypt
//                                fallback during rotation
//
// Missing-key behaviour: with no valid key, assertReady() throws at boot and
// encryptString throws, so a token is never written in plain text. Both
// installers (install.sh, the Mac app) generate a key; until 2026-10 a
// missing key only warned unless NODE_ENV=production, which nothing set.
//
// Reads: if a value starts with "enc:v1:" decrypt is attempted with current
// key, then with old key. Values without the prefix are treated as legacy
// plaintext and passed through unchanged, so existing rows stay readable.
//
// Key rotation flow:
//   1. Generate a new key locally: openssl rand -base64 32
//   2. Set TOKEN_ENCRYPTION_KEY_OLD = current key value on both services.
//   3. Set TOKEN_ENCRYPTION_KEY     = new key value on both services.
//   4. Restart both services. Reads now try new-first, fall back to old.
//      Every new write (OAuth refresh, reconnect) re-encrypts under the new
//      key naturally.
//   5. After enough time for all active tokens to have refreshed at least
//      once (Google/Microsoft ~1 hour cycle; safe margin: 24 hours), unset
//      TOKEN_ENCRYPTION_KEY_OLD. Any remaining old-encrypted rows are for
//      inactive users and will fail on next login, which forces re-auth —
//      acceptable for a compromised-key rotation.

const crypto = require("crypto");

const ALG = "aes-256-gcm";
const PREFIX = "enc:v1:";
let _current = null;
let _old = null;
let _resolved = false;
let _warned = false;

function _loadKey(varName) {
  const raw = process.env[varName];
  if (!raw) return null;
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    console.warn(`[crypto-tokens] ${varName} must decode to 32 bytes (got ${buf.length}) — ignoring.`);
    return null;
  }
  return buf;
}

function _resolveKeys() {
  if (_resolved) return;
  _current = _loadKey("TOKEN_ENCRYPTION_KEY");
  _old = _loadKey("TOKEN_ENCRYPTION_KEY_OLD");
  _resolved = true;
  if (!_current && !_warned) {
    console.error("[crypto-tokens] TOKEN_ENCRYPTION_KEY is missing or not 32 bytes. Add one to .env: openssl rand -base64 32");
    _warned = true;
  }
}

/**
 * Startup gate. Call this at boot of every service that touches tokens: with
 * no valid key the process stops before anything could be stored unencrypted.
 */
function assertReady() {
  _resolveKeys();
  if (!_current) {
    throw new Error(
      "[crypto-tokens] TOKEN_ENCRYPTION_KEY is required and must be a base64-encoded 32-byte key. " +
      "Refusing to start rather than store sign-ins unencrypted. Add one to .env (openssl rand -base64 32) and start again."
    );
  }
}

function encryptString(plaintext) {
  if (typeof plaintext !== "string" || !plaintext) return plaintext;
  if (plaintext.startsWith(PREFIX)) return plaintext; // idempotent
  _resolveKeys();
  if (!_current) throw new Error("[crypto-tokens] Cannot encrypt: TOKEN_ENCRYPTION_KEY is missing or invalid");
  return sealWith(plaintext, _current);
}

// Sealing with a key the caller holds, for moving a Closedhand to another
// computer (webapp/move.js): the source seals each stored secret again under
// a one-time key and the other computer seals it under its own, so neither
// computer's own key ever leaves it. openWith throws on the wrong key.
function sealWith(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}
function openWith(value, key) {
  if (typeof value !== "string" || !value.startsWith(PREFIX)) return value;
  return _tryDecrypt(Buffer.from(value.slice(PREFIX.length), "base64"), key);
}

function _tryDecrypt(buf, key) {
  const iv = buf.slice(0, 12);
  const tag = buf.slice(12, 28);
  const ct = buf.slice(28);
  const decipher = crypto.createDecipheriv(ALG, key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

// Every read of a stored secret leaves an audit line in the log: which file
// read it and what kind of secret, never the value. A file's first read in
// each hour is logged, with how many reads it made in the hour before, so the
// log shows who reads secrets and how often without a line per request.
const _reads = new Map(); // "reader what" -> { hour, n, before }
function _reader() {
  const frames = String(new Error().stack || "").split("\n").slice(1);
  for (const frame of frames) {
    const m = frame.match(/\(?([^()\s]+\.js):\d+:\d+\)?\s*$/);
    if (!m || m[1] === __filename || m[1].endsWith("crypto-tokens.js")) continue;
    return require("path").relative(__dirname, m[1]) || m[1];
  }
  return "unknown";
}
function _audit(what) {
  try {
    const key = `${_reader()} ${what}`;
    const hour = Math.floor(Date.now() / 3600000);
    const r = _reads.get(key);
    if (r && r.hour === hour) { r.n += 1; return; }
    const before = r && r.hour === hour - 1 ? r.n : 0;
    _reads.set(key, { hour, n: 1 });
    console.log(`[secret-read] ${key.replace(" ", " read ")}${before ? ` (${before} reads in the hour before)` : ""}`);
  } catch (_) { /* the audit never stops a read */ }
}

function decryptString(value, what = "a stored secret") {
  if (typeof value !== "string" || !value) return value;
  _audit(what);
  if (!value.startsWith(PREFIX)) return value; // legacy plaintext, read and audited all the same
  _resolveKeys();
  if (!_current && !_old) {
    console.error("[crypto-tokens] Encrypted token found but no keys configured — cannot decrypt.");
    return null;
  }
  const buf = Buffer.from(value.slice(PREFIX.length), "base64");
  for (const key of [_current, _old].filter(Boolean)) {
    try {
      return _tryDecrypt(buf, key);
    } catch (_) { /* try next key */ }
  }
  console.error("[crypto-tokens] Decrypt failed with all available keys (auth tag mismatch).");
  return null;
}

// Every credential-bearing field that may appear in connections.tokens.
// app_password covers Apple iCloud app-specific passwords (IMAP/SMTP/CalDAV);
// access_url is SimpleFIN's Access URL, which carries its own sign-in, and
// api_key is a Lunch Flow key: each reads someone's bank data.
const SECRET_FIELDS = ["access_token", "refresh_token", "app_password", "ics_url", "client_secret", "access_url", "api_key"];

function encryptTokens(tokens) {
  if (!tokens || typeof tokens !== "object") return tokens;
  const out = { ...tokens };
  for (const f of SECRET_FIELDS) {
    if (out[f] !== undefined) out[f] = encryptString(out[f]);
  }
  return out;
}

function decryptTokens(tokens) {
  if (!tokens || typeof tokens !== "object") return tokens;
  const out = { ...tokens };
  for (const f of SECRET_FIELDS) {
    if (out[f] !== undefined) out[f] = decryptString(out[f], f);
  }
  return out;
}

// ─── Secrets a service starts with ───────────────────────────────────────
// The few secrets a service needs before it can reach the database (the
// encryption key, the database password, the keys the services share) come
// from Docker secret files in /run/secrets, from the Mac app's Keychain by way
// of its launch, or from the host's own encrypted store (Railway's variables).
// guardEnvironment(), called first thing at start, takes every one of them out
// of the process environment and holds them here. process.env still answers
// for them, so no caller changes, but every read leaves an audit line like a
// stored secret's, and they are no longer listed: a program this service
// starts inherits none of them, and no copy of process.env holds them.
// A name is a secret when it ends in KEY, TOKEN, SECRET, PASSWORD or PASS
// (or one of those plus _OLD), and the password inside DATABASE_URL is moved
// to PGPASSWORD, where the database driver reads it.
const SECRET_NAME = /(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASS)(_OLD)?$/;
const _held = new Map();
let _guarded = false;

function _urlPassword(url) {
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^:/@]*):([^@]*)@/i.exec(url);
  if (!m) return null;
  let pw = m[2];
  try { pw = decodeURIComponent(pw); } catch (_) { /* kept as written */ }
  return { password: pw, rest: m[1] + "@" + url.slice(m[0].length) };
}

function guardEnvironment({ secretsDir = process.env.CLOSEDHAND_SECRETS_DIR || "/run/secrets" } = {}) {
  if (_guarded) return;
  _guarded = true;
  const fs = require("fs");
  const path = require("path");
  const real = process.env;
  let files = [];
  try { files = fs.readdirSync(secretsDir).filter((f) => !f.startsWith(".")); } catch (_) { /* none: the environment holds them */ }
  for (const f of files) {
    try {
      const value = fs.readFileSync(path.join(secretsDir, f), "utf8").trim();
      if (value) _held.set(f.toUpperCase().replace(/[^A-Z0-9_]/g, "_"), value);
    } catch (_) { /* unreadable: left to the environment */ }
  }
  if (real.DATABASE_URL) {
    const split = _urlPassword(real.DATABASE_URL);
    if (split) {
      if (!_held.has("PGPASSWORD")) _held.set("PGPASSWORD", split.password);
      real.DATABASE_URL = split.rest;
    }
  }
  for (const name of Object.keys(real)) {
    if (!SECRET_NAME.test(name)) continue;
    if (!_held.has(name)) _held.set(name, real[name]);
  }
  for (const name of _held.keys()) delete real[name];
  process.env = new Proxy(real, {
    get(t, k) {
      if (typeof k === "string" && _held.has(k)) { _audit(k); return _held.get(k); }
      return Reflect.get(t, k);
    },
    has(t, k) { return (typeof k === "string" && _held.has(k)) || Reflect.has(t, k); },
    set(t, k, v) {
      if (typeof k === "string" && (_held.has(k) || SECRET_NAME.test(k))) { _held.set(k, String(v)); Reflect.deleteProperty(t, k); return true; }
      return Reflect.set(t, k, v);
    },
    deleteProperty(t, k) { _held.delete(k); return Reflect.deleteProperty(t, k); },
  });
  console.log(`[secrets] ${_held.size} secret(s) held out of the environment${files.length ? `, ${files.length} from secret files` : ""}; every read is logged.`);
}

// A key for one purpose, derived from the encryption key (HKDF-SHA256), so
// that key itself is only ever used to encrypt.
function subkey(purpose) {
  _resolveKeys();
  if (!_current) throw new Error("[crypto-tokens] Cannot derive a key: TOKEN_ENCRYPTION_KEY is missing or invalid");
  return Buffer.from(crypto.hkdfSync("sha256", _current, Buffer.alloc(0), "closedhand:" + purpose, 32));
}

module.exports = { encryptString, decryptString, encryptTokens, decryptTokens, assertReady, guardEnvironment, subkey, sealWith, openWith, PREFIX };

// Drift check + roundtrip smoke test. Run: node crypto-tokens.js
if (require.main === module) {
  const fs = require("fs");
  const path = require("path");
  const self = fs.readFileSync(__filename, "utf8");
  const sha = crypto.createHash("sha256").update(self).digest("hex").substring(0, 16);
  console.log(`crypto-tokens.js SHA-256 (first 16): ${sha}`);
  // Roundtrip
  process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
  _resolved = false; _current = null; _old = null; _warned = false;
  const orig = { access_token: "roundtrip-test", refresh_token: "another-secret", expiry: 42 };
  const enc = encryptTokens(orig);
  const dec = decryptTokens(enc);
  if (dec.access_token !== orig.access_token || dec.refresh_token !== orig.refresh_token) {
    console.error("ROUNDTRIP FAILED");
    process.exit(1);
  }
  console.log("Roundtrip OK");
  // Compare drift with sibling copy
  const sibling = path.join(__dirname, "webapp", "crypto-tokens.js");
  const altSibling = path.join(__dirname, "..", "crypto-tokens.js");
  const other = fs.existsSync(sibling) ? sibling : fs.existsSync(altSibling) ? altSibling : null;
  if (other) {
    const otherContent = fs.readFileSync(other, "utf8");
    const match = otherContent === self;
    console.log(`Sibling ${path.relative(__dirname, other)}: ${match ? "IDENTICAL ✓" : "DRIFTED ✗ — fix immediately"}`);
    if (!match) process.exit(1);
  }
}
