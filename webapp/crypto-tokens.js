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
// Missing-key behaviour:
//   NODE_ENV=production and no valid key → assertReady() throws at boot.
//   Otherwise (dev/test/unset) → warn once, encrypt no-ops (returns plaintext).
//   The write path is safe either way: boot aborts before writes can happen.
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
    console.warn("[crypto-tokens] TOKEN_ENCRYPTION_KEY not set — tokens stored in plaintext (dev only). Generate one: openssl rand -base64 32");
    _warned = true;
  }
}

/**
 * Startup gate. Call this at boot of every service that touches tokens.
 * In production, throws if the encryption key is missing so the process
 * aborts before any plaintext write can happen. In dev, prints a warning
 * and returns, allowing local work without a key.
 */
function assertReady() {
  _resolveKeys();
  if (!_current && process.env.NODE_ENV === "production") {
    throw new Error(
      "[crypto-tokens] TOKEN_ENCRYPTION_KEY is required in production. " +
      "Refusing to start — writing OAuth tokens in plaintext is not allowed. " +
      "Set the env var to a base64-encoded 32-byte key on this service."
    );
  }
}

function encryptString(plaintext) {
  if (typeof plaintext !== "string" || !plaintext) return plaintext;
  if (plaintext.startsWith(PREFIX)) return plaintext; // idempotent
  _resolveKeys();
  if (!_current) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("[crypto-tokens] Cannot encrypt: TOKEN_ENCRYPTION_KEY missing in production");
    }
    return plaintext; // dev fallback
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, _current, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}

function _tryDecrypt(buf, key) {
  const iv = buf.slice(0, 12);
  const tag = buf.slice(12, 28);
  const ct = buf.slice(28);
  const decipher = crypto.createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

function decryptString(value) {
  if (typeof value !== "string" || !value.startsWith(PREFIX)) return value; // legacy plaintext or non-string
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
// app_password covers Apple iCloud app-specific passwords (IMAP/SMTP/CalDAV).
const SECRET_FIELDS = ["access_token", "refresh_token", "app_password", "ics_url"];

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
    if (out[f] !== undefined) out[f] = decryptString(out[f]);
  }
  return out;
}

module.exports = { encryptString, decryptString, encryptTokens, decryptTokens, assertReady };

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
