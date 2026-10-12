// Signing in through the personal URL takes the password and a code sent to
// the person's chat app (webapp/sign-in-code.js, lib/sign-in-code.js). On the
// computer running Closedhand the password alone still signs in.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const { createChallenges, KIND, MAX_TRIES, MAX_CODES_PER_HOUR, CODE_TTL_MS } = require("../webapp/sign-in-code");
const { deliver, register, codeText } = require("../lib/sign-in-code");
const { createSessions } = require("../webapp/dashboard-sessions");

test("a code is six random digits that works once", () => {
  const c = createChallenges();
  const { id, code } = c.issue();
  assert.match(code, /^\d{6}$/);
  assert.ok(id.length >= 40, "the browser's challenge id is long and random");
  assert.equal(c.verify(id, code), "ok");
  assert.equal(c.verify(id, code), "gone", "used once, it is gone");
  const codes = new Set(Array.from({ length: 4 }, () => createChallenges().issue().code));
  assert.ok(codes.size > 1, "codes differ");
});

test("a code runs out after ten minutes, and five wrong tries end it", () => {
  let t = 1_000_000;
  const c = createChallenges({ now: () => t });
  const a = c.issue();
  t += CODE_TTL_MS + 1;
  assert.equal(c.verify(a.id, a.code), "gone", "ten minutes on, the right code no longer works");
  const b = c.issue();
  const wrong = b.code === "000000" ? "111111" : "000000";
  for (let i = 1; i < MAX_TRIES; i++) assert.equal(c.verify(b.id, wrong), "wrong");
  assert.equal(c.verify(b.id, wrong), "used-up");
  assert.equal(c.verify(b.id, b.code), "gone", "after the last try even the right code fails");
  assert.equal(c.verify("made-up", "123456"), "gone");
  assert.equal(c.verify(undefined, undefined), "gone");
  const w = c.issue();
  c.withdraw(w.id);
  assert.equal(c.verify(w.id, w.code), "gone", "a code that could not be sent is withdrawn");
});

test("at most five codes go out an hour", () => {
  let t = 5_000_000;
  const c = createChallenges({ now: () => t });
  for (let i = 0; i < MAX_CODES_PER_HOUR; i++) { assert.equal(c.canIssue(), true); c.issue(); }
  assert.equal(c.canIssue(), false);
  t += 60 * 60 * 1000 + 1;
  assert.equal(c.canIssue(), true, "an hour later codes can go out again");
});

test("the code goes to every linked chat app, else to the person's email", async () => {
  const db = (links) => ({ from: () => ({ select: () => ({ eq: async () => ({ data: links, error: null }) }) }) });
  const sent = [];
  const sendToPlatform = async (platform, id, text) => { if (platform === "whatsapp" && id === "dead") throw new Error("closed"); sent.push([platform, text]); };
  let mailed = null;
  const sendToOwner = async (u, subject, text) => { mailed = { subject, text }; };
  const both = await deliver("u1", "482915", "203.0.113.x", { db: db([{ platform: "telegram", platform_user_id: "1" }, { platform: "whatsapp", platform_user_id: "2" }, { platform: "web", platform_user_id: "3" }]), sendToPlatform, sendToOwner });
  assert.deepEqual(both, ["your Telegram", "your WhatsApp"]);
  assert.equal(sent.length, 2, "the web chat is not a place to send a sign-in code");
  assert.match(sent[0][1], /Your Closedhand sign-in code is 482915\. It works once, for 10 minutes\./);
  assert.match(sent[0][1], /If you didn't just sign in, someone has your dashboard password \(they signed in from 203\.0\.113\.x\)\./);
  assert.equal(mailed, null, "no email when a chat app took it");
  const fallback = await deliver("u1", "482915", "", { db: db([{ platform: "whatsapp", platform_user_id: "dead" }]), sendToPlatform, sendToOwner });
  assert.deepEqual(fallback, ["your email"]);
  assert.match(mailed.text, /482915/);
  const none = await deliver("u1", "482915", "", { db: db([]), sendToPlatform, sendToOwner: async () => { throw new Error("off"); } });
  assert.deepEqual(none, []);
  assert.doesNotMatch(codeText("123456", ""), /—/);
});

test("the bot sends a code only for the webapp, and says when it has nowhere to send it", async () => {
  let handler;
  const app = { post: (p, fn) => { assert.equal(p, "/internal/sign-in-code"); handler = fn; } };
  const links = [];
  register(app, {
    verifyToken: (t) => (t === "good" ? "u1" : null),
    db: { from: () => ({ select: () => ({ eq: async () => ({ data: links, error: null }) }) }) },
    sendToPlatform: async () => {},
    sendToOwner: async () => { throw new Error("off"); },
  });
  const call = async (token, body) => {
    const out = { status: 200 };
    const res = { status(s) { out.status = s; return res; }, json(j) { out.body = j; return res; } };
    await handler({ get: () => token, body }, res);
    return out;
  };
  assert.equal((await call("bad", { code: "123456" })).status, 401);
  assert.equal((await call("good", { code: "12ab" })).status, 400);
  const nowhere = await call("good", { code: "123456" });
  assert.equal(nowhere.status, 409);
  assert.match(nowhere.body.error, /no chat app or email to send a sign-in code to/);
  links.push({ platform: "telegram", platform_user_id: "9" });
  assert.deepEqual((await call("good", { code: "123456" })).body, { sentTo: ["your Telegram"] });
  assert.match(read("index.js"), /require\("\.\/lib\/sign-in-code"\)\.register\(ctx\.expressApp\);/);
});

test("sessions report their kind, and code sign-ins stay signed in like password ones", async () => {
  const rows = [];
  const db = {
    from: () => {
      const f = {};
      const q = {
        insert: async (r) => { rows.push(r); return { error: null }; },
        select: () => q, eq: (k, v) => { f[k] = v; return q; }, lt: () => q, neq: () => q,
        maybeSingle: async () => ({ data: rows.find((r) => r.token_hash === f.token_hash) || null, error: null }),
        update: (patch) => ({ eq: async (k, v) => { Object.assign(rows.find((r) => r[k] === v) || {}, patch); return { error: null }; } }),
        delete: () => q, then: (ok) => Promise.resolve({ error: null }).then(ok),
      };
      return q;
    },
  };
  let t = Date.UTC(2026, 0, 1);
  const s = createSessions({ db, password: async () => ({ storedHash: "x" }), now: () => t });
  const { token } = await s.start({ kind: KIND });
  assert.deepEqual(await s.check(token), { ok: true, kind: KIND });
  t += 3 * 24 * 60 * 60 * 1000;
  const later = await s.check(token);
  assert.equal(later.kind, KIND);
  assert.ok(later.refreshSec, "a code sign-in is stretched on use, like a password one");
});

test("through the personal URL only a password-and-code session counts, and no door takes a password alone", () => {
  const server = read("webapp/server.js");
  assert.match(server, /if \(r\.ok && viaTunnel\(req\) && r\.kind !== signInCode\.KIND\) return false;/, "old password-only and Telegram sessions sign in again");
  const login = server.slice(server.indexOf('app.post("/api/login",'), server.indexOf('// --- Reach the dashboard from your phone'));
  assert.ok(login.indexOf("if (viaTunnel(req)) return sendSignInCode(req, res);") < login.indexOf("_loginFails.delete(ip);"), "the password is only the first step, and the lockout count stays until the code is right");
  assert.match(login, /await startAdminSession\(req, res, \{ kind: signInCode\.KIND \}\);/);
  assert.match(login, /signInRecord\("wrong sign-in code", req\);\n    noteWrongPassword\(ip, req\);/, "wrong codes count towards the lockout");
  assert.match(login, /Path=\/api\/login; HttpOnly; SameSite=Strict/);
  assert.match(server, /if \(viaTunnel\(req\)\) return res\.status\(403\)\.json\(\{ error: "Sign in with your password and the code Closedhand sends you\." \}\);/, "Telegram's one tap is a single step");
  assert.match(server, /if \(viaTunnel\(req\)\) return res\.status\(401\)\.json\(\{ error: "Through your personal URL, sign in on the sign-in page\./, "Basic auth is refused through the personal URL");
  assert.match(server, /await startAdminSession\(req, res, viaTunnel\(req\) \? \{ kind: signInCode\.KIND \} : undefined\);/, "a password changed through the personal URL keeps that browser signed in");
  const page = read("webapp/views/login.html");
  assert.match(page, /autocomplete="one-time-code"/);
  assert.match(page, /"Closedhand sent a 6-digit code to " \+ sentTo\.join\(" and "\)/);
});
