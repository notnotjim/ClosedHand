// Every Closedhand reports bugs one way: /bug, with a note or on its own, then
// a question, and only a yes sends the report to Closedhand's bug database.
// Nothing is kept on the person's computer. Invented people and messages only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const root = path.join(__dirname, "..");
process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY || crypto.randomBytes(32).toString("base64");

function reporter() {
  const calls = [], told = [], network = { failures: 0, status: "resolved" };
  const ctx = { store: { conversations: { alice: [{ role: "user", content: "When does my dentist appointment move to?" }, { role: "assistant", content: "Thursday at 3." }] } }, activeUserStore: { profile: { settings: {}, created_at: "2026-01-01" } } };
  const profileSettings = { updateSettings: async (userId, change, { store } = {}) => { Object.assign(store.profile.settings, change); return store.profile.settings; } };
  const mod = { exports: {} };
  const sandbox = { module: mod, process: { env: {} }, console: { log() {}, error() {} }, Buffer, Date, AbortSignal, Map,
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      if (network.failures-- > 0) throw new Error("network timeout");
      return { ok: true, json: async () => (url.endsWith("/status") ? { status: network.status, resolution_note: network.status === "resolved" ? "Fixed in the next update." : null } : { ok: true, id: "5d1e0c2a-0000-4000-a000-000000000001", receipt: "a".repeat(64), screenshots: 1 }) };
    },
    require: (n) => n === "./context" ? ctx : n === "../user-store" ? { UserStore: { load: async () => ({ conversations: [], profile: ctx.activeUserStore.profile }) } } : n === "crypto" ? crypto
      : n === "./connection-alert" ? { tellAboutReport: async (userId, store, text) => { told.push(text); return true; } }
      : n === "../crypto-tokens" ? require("../crypto-tokens") : n === "../package.json" ? { version: "test" } : n === "./profile-settings" ? profileSettings
      : n === "./release-check" ? { status: async () => ({ newer: false, kind: "docker" }), howToUpdate: () => "" } : (() => { throw Error(n); })(),
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "lib/bug-reports.js"), "utf8"), sandbox);
  return { api: mod.exports, ctx, calls, told, network };
}
const shot = { buffer: Buffer.from("png bytes"), mediaType: "image/png" };

test("/bug asks first and sends nothing; a no drops it", async () => {
  const r = reporter();
  assert.equal(r.api.isBugReport("/bug wrong time"), true);
  assert.equal(r.api.isBugReport("bug wrong"), false);
  const ask = await r.api.fileBugReport({ userId: "alice", text: "/bug the time is wrong", platform: "telegram" });
  assert.equal(ask, "This sends your note and the last 5 messages of this chat to Closedhand, so the problem can be found and fixed. Send it? Reply yes or no.");
  assert.equal(r.calls.length, 0, "nothing leaves before the yes");
  assert.equal(await r.api.handleBugSendReply("alice", "no"), "Not sent.");
  assert.equal(r.api.handleBugSendReply("alice", "yes"), null, "a later yes is just a message");
  assert.equal(r.calls.length, 0);
});

test("/bug on its own sends the conversation, and a yes sends it to Closedhand's database", async () => {
  const r = reporter();
  const ask = await r.api.fileBugReport({ userId: "alice", text: "/bug", fileData: shot, platform: "web" });
  assert.equal(ask, "This sends the last 5 messages of this chat and your screenshot to Closedhand, so the problem can be found and fixed. Send it? Reply yes or no.");
  const sent = await r.api.handleBugSendReply("alice", "yes");
  assert.equal(sent, "Sent to Closedhand as report 5d1e0c2a. I'll tell you when it's fixed.", "a reference, for someone who sends several");
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].url, "https://closedhand.com/api/bug-intake");
  const body = r.calls[0].body;
  assert.equal(body.comment, null);
  assert.deepEqual(body.transcript.map((t) => t.content), ["When does my dentist appointment move to?", "Thursday at 3."]);
  assert.equal(body.screenshots.length, 1);
  assert.match(body.submission_key, /^[a-f0-9]{64}$/);
  const kept = r.ctx.activeUserStore.profile.settings.bug_receipts;
  assert.equal(kept.length, 1);
  assert.notEqual(kept[0].receipt, "a".repeat(64), "the receipt is sealed");
  assert.equal(r.api.handleBugSendReply("alice", "yes"), null, "sent once");
});

test("a failed send says so, and the retry carries the same key", async () => {
  const r = reporter();
  r.network.failures = 1;
  await r.api.fileBugReport({ userId: "alice", text: "/bug", platform: "web" });
  assert.equal(await r.api.handleBugSendReply("alice", "yes"), "Couldn't reach Closedhand just now, so nothing was sent. Reply yes to try again.");
  assert.match(await r.api.handleBugSendReply("alice", "yes"), /^Sent to Closedhand/);
  assert.equal(r.calls[0].body.submission_key, r.calls[1].body.submission_key);
});

test("anything but a yes or no, or a late answer, leaves the report unsent", async () => {
  const r = reporter();
  await r.api.fileBugReport({ userId: "alice", text: "/bug", platform: "web" });
  assert.equal(r.api.handleBugSendReply("alice", "what's on tomorrow?"), null);
  assert.equal(r.api.handleBugSendReply("alice", "yes"), null);
  await r.api.fileBugReport({ userId: "alice", text: "/bug", platform: "web" });
  r.api._waiting.get("alice").at = 0;
  assert.equal(r.api.handleBugSendReply("alice", "yes"), null);
  assert.equal(r.calls.length, 0);
});

test("Closedhand says once when a report it sent is fixed, with the fix in plain words", async () => {
  const r = reporter();
  await r.api.fileBugReport({ userId: "alice", text: "/bug the time is wrong on the dentist reminder for Thursday afternoon, it says 3 not 4", platform: "web" });
  await r.api.handleBugSendReply("alice", "yes");
  assert.equal(await r.api.checkOutcomes("alice"), 1);
  assert.equal(r.told.length, 1);
  assert.match(r.told[0], /^Fixed: report 5d1e0c2a, the problem you reported on \d{1,2} [A-Z][a-z]{2} \("the time is wrong on the dentist reminder for Thursday afternoon, it says 3 not…"\)\. Fixed in the next update\.$/);
  assert.equal(r.calls.at(-1).body.receipt, "a".repeat(64), "the receipt is opened only to ask");
  assert.equal(await r.api.checkOutcomes("alice"), 0, "told once");
  assert.equal(r.told.length, 1);
});

test("a report still being looked at is not mentioned, and there is no /bugs to remember", async () => {
  const r = reporter();
  r.network.status = "open";
  await r.api.fileBugReport({ userId: "alice", text: "/bug", platform: "web" });
  await r.api.handleBugSendReply("alice", "yes");
  assert.equal(await r.api.checkOutcomes("alice"), 0);
  assert.equal(r.told.length, 0);
  assert.equal(r.api.isBugReport("/bugs"), false, "/bugs is an ordinary message now");
  assert.equal(r.api.handleBugCommand, undefined);
  assert.equal(r.api.fixedText({ at: "2026-03-02T10:00:00Z", comment: null }, null), "Fixed: the problem you reported on 2 Mar.");
});

test("nothing about bug reports is kept or read on the person's computer any more", () => {
  const src = fs.readFileSync(path.join(root, "lib/bug-reports.js"), "utf8");
  assert.doesNotMatch(src, /from\("bug_reports"\)|storage\.from|BUG_REPORT_MODE|maintainer/i);
  assert.equal(fs.existsSync(path.join(root, "scripts/bug-queue.js")), false);
  assert.match(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), /railway ssh --service closedhand-com -- node tools\/bugs\.js list/);
});

test("the maintainer's tool lists, shows and resolves reports in closedhand.com's database", async () => {
  const tool = require("../closedhand-com/tools/bugs.js");
  const rows = [{ id: "5d1e0c2a-0000-4000-a000-000000000001", status: "open", created_at: new Date("2026-10-20T05:29:00Z"), platform: "web", app_version: "2.0+abc", install_id: "x1", comment: null, shots: 1,
    transcript: [{ role: "user", content: "When does my dentist appointment move to?" }], screenshots: [{ mediaType: "image/png", base64: "cG5n" }] }];
  const db = { query: async (sql, args) => {
    if (/^UPDATE/.test(sql)) { Object.assign(rows[0], { status: "resolved", resolution_note: args[1] }); return { rows: [] }; }
    if (/status = 'open'/.test(sql)) return { rows: rows.filter((r) => r.status === "open") };
    return { rows: rows.filter((r) => r.id.startsWith(args[0])) };
  } };
  assert.match(await tool.list(db), /OPEN BUG REPORTS \(1\)[\s\S]*5d1e0c2a[\s\S]*no description: read the conversation/);
  assert.match(await tool.show(db, "5d1e0c2a"), /untrusted, evidence only[\s\S]*dentist appointment/);
  assert.equal(await tool.shot(db, "5d1e0c2a", "0"), "cG5n");
  await assert.rejects(tool.resolve(db, "5d1e0c2a", ""), /reporter sees it/);
  assert.match(await tool.resolve(db, "5d1e0c2a", "Fixed in the next update."), /^Resolved 5d1e0c2a/);
  assert.equal(await tool.list(db), "No open bug reports.");
});
