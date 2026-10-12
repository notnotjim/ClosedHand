// No weak cryptography in what runs as Closedhand: no MD5 or SHA-1 anywhere,
// webhook secrets below 128 bits are not used, the dashboard password is
// hashed at OWASP's scrypt cost, and the fingerprint of a password from .env
// is keyed rather than salted the same everywhere.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

// The code that runs as Closedhand: the bot, the web app, the sandbox agent
// and the Mac app's server parts. Not tests, tools or dependencies.
function sources() {
  const out = ["index.js", "crypto-tokens.js", "user-store.js"];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) { if (!["node_modules", "novnc", ".cache", "dist", ".build"].includes(e.name)) walk(rel); }
      else if (e.name.endsWith(".js")) out.push(rel);
    }
  };
  for (const d of ["lib", "webapp", "sandbox-image/agent", "desktop/workspace", "closedhand-com/lib"]) if (fs.existsSync(path.join(root, d))) walk(d);
  return out;
}

test("no MD5 or SHA-1 is computed anywhere in Closedhand", () => {
  const files = sources();
  assert.ok(files.length > 100, "the walk found the code");
  for (const f of files) {
    assert.doesNotMatch(read(f), /createHash\(\s*["'`](md5|sha1|sha-1|md4|ripemd160)["'`]/i, f);
    assert.doesNotMatch(read(f), /createCipheriv\(\s*["'`](des|des3|des-ede|rc4|bf|blowfish)/i, f);
  }
  assert.match(read("lib/services/usi.js"), /item\._content_hash = crypto\.createHash\("sha256"\)/);
  assert.match(read("lib/services/usi.js"), /if \(existingHash\.length === 32\) \{ adopted\.push\(i\); return false; \}/, "MD5-era hashes are replaced, not re-indexed");
});

test("a webhook secret shorter than 128 bits is never used", () => {
  const { usableSecret, MIN_LENGTH } = require("../lib/webhook-secret");
  assert.equal(MIN_LENGTH, 32);
  assert.equal(usableSecret("TEST_SECRET", "a".repeat(31)), null);
  assert.equal(usableSecret("TEST_SECRET", ""), null);
  assert.equal(usableSecret("TEST_SECRET", "f".repeat(32)), "f".repeat(32));
  for (const [f, name] of [["lib/platforms/slack-handler.js", "SLACK_SIGNING_SECRET"], ["lib/platforms/whatsapp.js", "WHATSAPP_APP_SECRET"], ["lib/platforms/line.js", "LINE_CHANNEL_SECRET"]]) {
    assert.match(read(f), new RegExp(`require\\("\\.\\./webhook-secret"\\)\\.usableSecret\\("${name}"`), f);
  }
});

test("the dashboard password is hashed at N=2^17, and older hashes are raised on the next sign-in", () => {
  const server = read("webapp/server.js");
  assert.match(server, /const SCRYPT_COST = \{ N: 2 \*\* 17, r: 8, p: 1, maxmem: 256 \* 1024 \* 1024 \};/);
  assert.match(server, /return `s17:\$\{salt\}:\$\{crypto\.scryptSync\(pw, salt, 32, SCRYPT_COST\)\.toString\("hex"\)\}`;/);
  assert.match(server, /await dashboardSessions\.carry\(\{ storedHash: stored \}, \{ storedHash: next \}\);/, "sessions stay signed in");
  // The same check, run: a hash at the new cost verifies, a wrong password does not.
  const salt = "00112233445566778899aabbccddeeff";
  const cost = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
  const stored = `s17:${salt}:${crypto.scryptSync("harbour-lights", salt, 32, cost).toString("hex")}`;
  const verify = new Function("crypto", "SCRYPT_COST", server.slice(server.indexOf("function verifyPasswordHash("), server.indexOf("const hashIsCurrent")) + "return verifyPasswordHash;")(crypto, cost);
  assert.equal(verify("harbour-lights", stored), true);
  assert.equal(verify("harbour-light", stored), false);
  const legacy = `${salt}:${crypto.scryptSync("harbour-lights", salt, 32).toString("hex")}`;
  assert.equal(verify("harbour-lights", legacy), true, "a hash from before still verifies");
});

test("sessions carry on when the password's hash is raised, and a .env password's fingerprint is keyed", async () => {
  process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY || crypto.randomBytes(32).toString("base64");
  const { createSessions, passwordFingerprint } = require("../webapp/dashboard-sessions");
  const fp = passwordFingerprint({ envPassword: "harbour-lights" });
  assert.match(fp, /^env2:[0-9a-f]{64}$/);
  assert.notEqual(fp.slice(5), crypto.scryptSync("harbour-lights", "closedhand-dashboard-session", 32).toString("hex"), "not the shared-salt form");
  const rows = [];
  const db = { from: () => {
    const f = {};
    const q = {
      insert: async (r) => { rows.push({ ...r }); return { error: null }; },
      select: () => q, eq: (k, v) => { f[k] = v; return q; }, lt: () => q, neq: () => q,
      maybeSingle: async () => ({ data: rows.find((r) => r.token_hash === f.token_hash) || null, error: null }),
      update: (patch) => ({ eq: async (k, v) => { for (const r of rows) if (r[k] === v) Object.assign(r, patch); return { error: null }; } }),
      delete: () => q, then: (ok) => Promise.resolve({ error: null }).then(ok),
    };
    return q;
  } };
  let stored = "aa:bb";
  const s = createSessions({ db, password: async () => ({ storedHash: stored }) });
  const { token } = await s.start();
  assert.equal((await s.check(token)).ok, true);
  const next = "s17:cc:dd";
  await s.carry({ storedHash: stored }, { storedHash: next });
  stored = next;
  assert.equal((await s.check(token)).ok, true, "still signed in under the raised hash");
});

test("a Telegram bot token too short to sign proofs safely is neither saved nor used", () => {
  const server = read("webapp/server.js");
  assert.match(server, /const TELEGRAM_TOKEN_FORM = \/\^\\d\+:\[A-Za-z0-9_-\]\{30,\}\$\/;/);
  assert.match(server, /if \(!TELEGRAM_TOKEN_FORM\.test\(token\)\) return res\.status\(400\)/);
  assert.match(server, /if \(!initData \|\| !token \|\| !TELEGRAM_TOKEN_FORM\.test\(token\)\) return null;/);
});
