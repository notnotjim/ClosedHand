const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const root = path.join(__dirname, "..");
function database() {
  const tables = { bug_reports: [], profiles: [] }, uploads = [];
  const db = {
    tables, uploads, failInsert: false, failUpload: false,
    storage: { from: () => ({
      upload: async (p) => { uploads.push(p); return { error: db.failUpload ? { message: "upload failed" } : null }; },
      download: async () => ({ data: { arrayBuffer: async () => Buffer.from("image") } }),
      remove: async () => ({ error: null }),
    }) },
    from(table) {
      let operation = "select", value, options, fields = "*", filters = [], one = false, limit = Infinity;
      const q = {
        select(f = "*") { fields = f; return q; }, insert(v) { operation = "insert"; value = v; return q; },
        upsert(v, o) { operation = "upsert"; value = v; options = o; return q; },
        update(v) { operation = "update"; value = v; return q; },
        delete() { operation = "delete"; return q; },
        eq(k, v) { filters.push(row => row[k] === v); return q; },
        order() { return q; }, limit(n) { limit = n; return q; },
        single() { one = true; return q; }, maybeSingle() { one = true; return q; },
        then(resolve, reject) {
          return Promise.resolve().then(() => {
            if (db.failInsert && operation === "insert") return { data: null, error: { message: "offline" } };
            let rows = tables[table].filter(row => filters.every(f => f(row)));
            if (operation === "insert" || operation === "upsert") {
              let r = tables[table].find(r => r.id === value.id);
              if (!r) { r = { id: crypto.randomUUID(), status: "open", created_at: new Date().toISOString(), screenshots: [], ...value }; tables[table].push(r); }
              else if (!options?.ignoreDuplicates) Object.assign(r, value);
              rows = [r];
            }
            if (operation === "update") rows.forEach(row => Object.assign(row, value));
            if (operation === "delete") tables[table] = tables[table].filter(row => !rows.includes(row));
            rows = rows.slice(0, limit).map(r => fields === "*" ? { ...r } : Object.fromEntries(fields.split(",").map(k => [k, r[k]])));
            return { data: one ? rows[0] || null : rows, error: null };
          }).then(resolve, reject);
        },
      };
      return q;
    },
  };
  return db;
}
function reporter(env = { DB_DRIVER: "pg" }) {
  const db = database(), calls = [], ctx = { store: { conversations: { alice: [{ role: "user", content: "private message" }] } }, activeUserStore: { profile: { settings: {}, created_at: "2026-01-01" } } };
  const network = { failures: 0 };
  const mod = { exports: {} };
  const sandbox = { module: mod, process: { env }, console: { log() {}, error() {} }, Buffer, Date, AbortSignal,
    fetch: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); if (network.failures-- > 0) throw new Error("network timeout"); return { ok: true, json: async () => ({ ok: true, id: "central", receipt: "receipt", status: "resolved", resolution_note: "Fixed and verified.", resolved_at: "2026-09-12T00:00:00Z" }) }; },
    require: n => n === "./context" ? ctx : n === "../user-store" ? { supabase: db, UserStore: { load: async () => ({ conversations: [] }) } } : n === "crypto" ? crypto : n === "../package.json" ? { version: "test" } : (() => { throw Error(n); })(),
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "lib/bug-reports.js"), "utf8"), sandbox);
  return { api: mod.exports, db, ctx, calls, network };
}
const file = api => api.fileBugReport({ userId: "alice", text: "/bug wrong answer", platform: "whatsapp_linked", chatId: "alice-chat" });
test("ordinary OSS report stays local until explicit consent; bare bug and spaced slash are not commands", async () => {
  const r = reporter();
  assert.equal(r.api.isBugReport("/bug wrong"), true);
  assert.equal(r.api.isBugReport("/ bug wrong"), false);
  assert.equal(r.api.isBugReport("bug wrong"), false);
  const reply = await file(r.api);
  assert.match(reply, /Send this to ClosedHand to check/);
  assert.match(reply, /installation identifier/);
  assert.equal(r.calls.length, 0);
  await r.api.handleBugSendReply("alice", "no");
  assert.equal(r.calls.length, 0);
});
test("maintainer reports stay local without asking to send them to their own team", async () => {
  const r = reporter({ DB_DRIVER: "pg", BUG_REPORT_MODE: "maintainer" });
  const reply = await file(r.api);
  assert.match(reply, /development queue/);
  assert.equal(r.calls.length, 0);
  assert.equal(r.ctx.activeUserStore.profile.settings.bug_send_pending, undefined);
  assert.equal(r.api.handleBugSendReply("alice", "yes"), null);
});
test("hosted reports disclose saved context and do not forward elsewhere", async () => {
  const r = reporter({ SUPABASE_URL: "https://db.example" });
  assert.match(await file(r.api), /Sent to ClosedHand to check/);
  assert.equal(r.calls.length, 0);
});
test("save and screenshot failures are reported honestly", async () => {
  const r = reporter();
  r.db.failInsert = true;
  assert.match(await file(r.api), /Couldn't save/);
  assert.equal(r.db.tables.bug_reports.length, 0);
  r.db.failInsert = false; r.db.failUpload = true;
  const reply = await r.api.fileBugReport({ userId: "alice", text: "/bug screenshot", fileData: { buffer: Buffer.from("image"), mediaType: "image/png" } });
  assert.match(reply, /Saved 0 of 1 screenshots/);
  assert.doesNotMatch(reply, /Screenshot saved/);
});
test("send checks report ownership, and stores the receipt for resolution lookup", async () => {
  const r = reporter();
  await file(r.api);
  const row = r.db.tables.bug_reports[0];
  await r.api.sendReport("bob", row.id);
  assert.equal(r.calls.length, 0);
  await r.api.handleBugSendReply("alice", "yes");
  assert.equal(r.calls.length, 1);
  assert.equal(row.remote_receipt.id, "central");
  assert.match(row.remote_receipt.submission_key, /^[a-f0-9]{64}$/);
  await r.api.sendReport("alice", row.id);
  assert.equal(r.calls.length, 1, "already-sent report is not duplicated");
  const listing = await r.api.handleBugCommand("alice", "/bugs");
  assert.match(listing, /Fixed and verified/);
  assert.equal(row.status, "resolved");
  assert.doesNotMatch(listing, /submission_key|receipt/);
});
test("concurrent sends share one request and a retry reuses the submission key", async () => {
  const r = reporter();
  await file(r.api);
  const id = r.db.tables.bug_reports[0].id;
  r.network.failures = 1;
  await Promise.all([r.api.sendReport("alice", id), r.api.sendReport("alice", id)]);
  assert.equal(r.calls.length, 1);
  assert.equal(r.db.tables.bug_reports[0].sent_at, undefined);
  await r.api.handleBugCommand("alice", "/bugs send " + id);
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[0].body.submission_key, r.calls[1].body.submission_key);
});
test("review and deletion only expose the authenticated user's own reports", async () => {
  const r = reporter();
  await file(r.api);
  const id = r.db.tables.bug_reports[0].id;
  assert.doesNotMatch(await r.api.handleBugCommand("bob", "/bugs " + id), /private message/);
  await r.api.handleBugCommand("bob", "/bugs delete " + id);
  assert.equal(r.db.tables.bug_reports.length, 1);
  assert.match(await r.api.handleBugCommand("alice", "/bugs " + id), /private message/);
  await r.api.handleBugCommand("alice", "/bugs delete " + id);
  assert.equal(r.db.tables.bug_reports.length, 0);
});
test("an unrelated or expired yes never sends a pending report", async () => {
  const r = reporter();
  await file(r.api);
  assert.equal(r.api.handleBugSendReply("alice", "a different question"), null);
  assert.equal(r.api.handleBugSendReply("alice", "yes"), null);
  await file(r.api);
  r.ctx.activeUserStore.profile.settings.bug_send_pending.at = 0;
  assert.equal(r.api.handleBugSendReply("alice", "yes"), null);
  assert.equal(r.calls.length, 0);
});
const intakePath = path.join(root, "webapp/bug-intake.js");
if (fs.existsSync(intakePath)) {
  const { registerBugIntake, submissionId } = require(intakePath);
  function intake() {
    const db = database(), routes = {};
    registerBugIntake({ post: (path, fn) => { routes[path] = fn; } }, db, "test-secret");
    async function call(route, body) {
      const out = { code: 200 }, res = { set() { return res; }, status(n) { out.code = n; return res; }, json(data) { out.data = data; return res; } };
      await routes[route]({ headers: {}, ip: "test", body }, res);
      return out;
    }
    return { db, call };
  }
  test("a retried submission keeps one report; forged receipts cannot read its outcome", async () => {
    const r = intake(), key = crypto.randomBytes(32).toString("hex");
    const body = { submission_key: key, comment: "Test report" };
    const first = await r.call("/api/bug-intake", body);
    assert.equal(first.code, 200);
    const again = await r.call("/api/bug-intake", { ...body, comment: "retry must not overwrite" });
    assert.equal(again.data.id, first.data.id);
    assert.equal(r.db.tables.bug_reports.length, 1);
    assert.equal(r.db.tables.bug_reports[0].comment, "Test report");
    const forged = await r.call("/api/bug-intake/status", { id: first.data.id, receipt: "0".repeat(64) });
    assert.equal(forged.code, 404);
    r.db.tables.bug_reports[0].status = "resolved";
    r.db.tables.bug_reports[0].resolution_note = "Fixed in the next update.";
    const result = await r.call("/api/bug-intake/status", { id: first.data.id, receipt: first.data.receipt });
    assert.equal(result.code, 200);
    assert.equal(result.data.status, "resolved");
    assert.deepEqual(Object.keys(result.data).sort(), ["resolution_note", "resolved_at", "status"]);
    assert.notEqual(submissionId(crypto.randomBytes(32).toString("hex")), first.data.id);
  });
}
