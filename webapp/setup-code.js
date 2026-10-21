// The setup code, for a Closedhand whose computer has no localhost anyone can
// reach, like one on Railway. The host makes a random code (or the person
// chooses one) and shows it only to the account that owns it, as SETUP_CODE.
// Until a dashboard password exists, a browser elsewhere must type it before
// setup answers. After that it is the second step of signing in when
// Closedhand has no chat app or email to send a code to (server.js). Without
// SETUP_CODE, setup stays on localhost as before.
const crypto = require("crypto");

const COOKIE = "ch_setup_pass";
const PASS_SEC = 2 * 3600;
// Short codes could be guessed; the Railway template makes 24 characters.
const MIN_LENGTH = 12;
// Each wrong code waits this long before answering, so guessing gets nowhere
// without locking the owner out the way a lockout would.
const WRONG_DELAY_MS = 1000;

function equal(a, b) {
  const digest = (v) => crypto.createHash("sha256").update(String(v)).digest();
  return crypto.timingSafeEqual(digest(a), digest(b));
}

function createSetupCode({ code = process.env.SETUP_CODE, secret = process.env.COOKIE_SECRET, now = Date.now, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const value = typeof code === "string" ? code.trim() : "";
  const enabled = value.length >= MIN_LENGTH && typeof secret === "string" && secret.length > 0;
  const sign = (exp) => crypto.createHmac("sha256", secret).update("setup-pass:" + value + ":" + exp).digest("base64url");
  const matches = (typed) => enabled && typeof typed === "string" && equal(typed.trim(), value);
  return {
    enabled,
    COOKIE,
    // A pass this browser got by typing the code; it lasts two hours and ends
    // if the code changes.
    passed(cookie) {
      if (!enabled || typeof cookie !== "string") return false;
      const [exp, sig] = cookie.split(".");
      if (!/^\d+$/.test(exp || "") || Number(exp) * 1000 < now() || !sig) return false;
      return equal(sig, sign(exp));
    },
    // Whether this is the code, with no wait: as a sign-in step it has that
    // step's own tries and lockout instead.
    matches,
    // The Set-Cookie value for a right code, or null for a wrong one.
    async check(typed, secure) {
      if (matches(typed)) {
        const exp = Math.floor(now() / 1000) + PASS_SEC;
        return `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${PASS_SEC}${secure ? "; Secure" : ""}`;
      }
      await wait(WRONG_DELAY_MS);
      return null;
    },
  };
}

module.exports = { createSetupCode, MIN_LENGTH };
