// The second step of signing in over the internet. Through the personal URL
// a right password is not enough: Closedhand sends a six-digit code to the
// chat apps it already talks to the person on (lib/sign-in-code.js), and the
// browser has to give that code back. A Closedhand on a host (SETUP_CODE)
// signs in this way at the host's own web address too, and asks for the setup
// code when there is nowhere to send one. On the computer running Closedhand
// (localhost) the password alone still signs in, since nobody else can reach
// that address.
//
// A code is random (crypto.randomInt), lasts ten minutes, works once and
// allows five tries; wrong codes also count towards the address's sign-in
// lockout in server.js. At most five codes go out an hour, so a stolen
// password can't be used to flood the person's chat or to guess codes fast.
// Codes and the browser's challenge id are kept only as hashes, in memory: a
// restart forgets them, and the person signs in again.
const crypto = require("crypto");

const KIND = "password+code"; // the session kind a code sign-in makes (dashboard-sessions.js)
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_TRIES = 5;
const MAX_CODES_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;

const digest = (value) => crypto.createHash("sha256").update(String(value)).digest();

function createChallenges({ now = () => Date.now() } = {}) {
  const open = new Map(); // hash of the challenge id -> { codeHash, expires, tries }
  const issued = []; // when each code was made, for the hourly cap

  function sweep() {
    for (const [key, c] of open) if (c.expires <= now()) open.delete(key);
    while (issued.length && issued[0] <= now() - HOUR_MS) issued.shift();
  }
  function canIssue() {
    sweep();
    return issued.length < MAX_CODES_PER_HOUR;
  }
  // A new challenge: the id goes to the browser in a cookie, the code to the
  // person's chat. Only hashes of both are kept.
  function issue() {
    sweep();
    const id = crypto.randomBytes(32).toString("base64url");
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    open.set(digest(id).toString("hex"), { codeHash: digest(`${id}:${code}`), expires: now() + CODE_TTL_MS, tries: 0 });
    issued.push(now());
    return { id, code };
  }
  // A challenge answered with the setup code instead (setup-code.js), for a
  // Closedhand on a host with no chat app or email to send a code to. Only
  // the person's account at the host shows that code. Nothing is sent, so it
  // is not counted towards the hourly cap.
  function issueForSetupCode() {
    sweep();
    const id = crypto.randomBytes(32).toString("base64url");
    open.set(digest(id).toString("hex"), { setupCode: true, expires: now() + CODE_TTL_MS, tries: 0 });
    return { id };
  }
  function asksForSetupCode(id) {
    const c = open.get(digest(String(id || "")).toString("hex"));
    return !!(c && c.setupCode);
  }
  // A code that could not be sent is withdrawn at once.
  function withdraw(id) {
    open.delete(digest(String(id || "")).toString("hex"));
  }
  // "ok" (signed in; the code is spent), "wrong", "used-up" (that was the
  // last try) or "gone" (no such challenge: run out, used, or never made).
  // isSetupCode checks the answer to a setup code challenge.
  function verify(id, code, isSetupCode = () => false) {
    sweep();
    const key = digest(String(id || "")).toString("hex");
    const c = open.get(key);
    if (!c) return "gone";
    const given = String(code || "").replace(/\s+/g, "");
    const right = c.setupCode
      ? isSetupCode(given)
      : /^\d{6}$/.test(given) && crypto.timingSafeEqual(digest(`${id}:${given}`), c.codeHash);
    if (right) {
      open.delete(key);
      return "ok";
    }
    c.tries += 1;
    if (c.tries >= MAX_TRIES) {
      open.delete(key);
      return "used-up";
    }
    return "wrong";
  }
  return { canIssue, issue, issueForSetupCode, asksForSetupCode, withdraw, verify };
}

module.exports = { createChallenges, KIND, CODE_TTL_MS, MAX_TRIES, MAX_CODES_PER_HOUR };
