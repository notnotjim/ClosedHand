// A routine set to run "when something happens" is a watch: it is checked
// against each new item of its kind as the sync brings them in
// (lib/watches.js, lib/watch-kinds.js). Before, such a routine was saved, said
// "Routine saved", and nothing ever ran it. Pulse leaves an item a watch is
// waiting for, or one anyone has told the person about, alone (told-items.js).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const watches = require("../lib/watches");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

// Enough of the database for a watch: reads of data_cache, writes to
// automations and told_items.
function fakeDb(rows) {
  const updates = [], told = [];
  return {
    updates, told,
    from(table) {
      const filters = [];
      let patch = null, gt = null, inList = null, limit = Infinity;
      const q = {
        select: () => q,
        eq: (k, v) => { filters.push([k, v]); return q; },
        in: (k, v) => { inList = [k, v]; return q; },
        gt: (k, v) => { gt = [k, v]; return q; },
        order: () => q,
        limit: (n) => { limit = n; return q; },
        update: (p) => { patch = p; return q; },
        upsert: async (r) => { told.push(...r); return { error: null }; },
        then: (ok) => {
          if (patch) { updates.push({ table, patch, filters }); return Promise.resolve({ error: null }).then(ok); }
          const data = rows.filter((r) => filters.every(([k, v]) => k === "user_id" || r[k] === v)
            && (!inList || inList[1].includes(r[inList[0]])) && (!gt || r[gt[0]] > gt[1])).slice(0, limit);
          return Promise.resolve({ data, error: null }).then(ok);
        },
      };
      return q;
    },
  };
}

const BEGAN = "2026-11-02T10:00:00.000Z";
const AT = Date.parse("2026-11-03T09:00:00.000Z");
const email = (id, fields, syncedAt = "2026-11-03T08:00:00.000Z", receivedAt = "2026-11-03T07:58:00.000Z") =>
  ({ source: "gmail", type: "email", external_id: id, received_at: receivedAt, synced_at: syncedAt, created_at: syncedAt, data: { from: "", subject: "", body: "", labels: ["INBOX"], ...fields } });
const watch = (extra = {}) => ({
  id: "w1", user_id: "u1", name: "brightwater-order-shipping", status: "active", trigger_type: "event",
  trigger_event_source: "email", trigger_event_condition: "Brightwater Toys' email saying order BW-40417 has shipped",
  watch_words: ["BW-40417"], run_once: true, created_at: BEGAN, expires_at: "2026-12-02T10:00:00.000Z",
  watch_seen: [], platform: "telegram", chat_id: "chat-1", ...extra,
});
function deps(db, answer) {
  const asked = [], ran = [], said = [];
  return {
    asked, ran, said,
    deps: { db, now: AT, ask: async (userId, system, message) => { asked.push(message); return typeof answer === "function" ? answer(message) : answer; },
      run: async (w, input) => { ran.push({ w: w.name, input }); }, say: async (w, text) => { said.push(text); } },
  };
}

test("what a watch can see: every kind the sync stores, and bookings, and nothing else", () => {
  assert.equal(watches.sourceOf("Gmail"), "email");
  assert.equal(watches.sourceOf(undefined), "email");
  assert.equal(watches.sourceOf("transactions"), "bank");
  assert.equal(watches.sourceOf("whatsapp"), "messages");
  assert.equal(watches.sourceOf("calendar"), "calendar");
  assert.equal(watches.sourceOf("notion"), "notes");
  assert.equal(watches.sourceOf("flights"), "bookings");
  assert.equal(watches.sourceOf("shopify"), null);
});

test("the shipping email fires the watch once: the routine runs with it, it is recorded as told, and the watch closes", async () => {
  const db = fakeDb([
    email("m1", { from: "Brightwater Toys <orders@brightwater.example>", subject: "Your order BW-40417 has shipped", body: "Tracking: BW-TRACK-9 arriving Thursday" }),
    email("m2", { from: "Harbour Lights <news@harbour.example>", subject: "Autumn sale", body: "20% off" }),
  ]);
  const d = deps(db, '{"matches":[1]}');
  const r = await watches.checkWatch(watch(), d.deps);
  assert.equal(r.fired, 1);
  assert.equal(d.asked.length, 1, "one model call");
  assert.match(d.asked[0], /\[1\] Email from Brightwater Toys/);
  assert.doesNotMatch(d.asked[0], /Autumn sale/, "an email without the watch's words never reaches the model");
  assert.equal(d.ran.length, 1);
  assert.match(d.ran[0].input, /Tracking: BW-TRACK-9/);
  assert.deepEqual(db.told.map((t) => [t.source, t.external_id, t.told_by]), [["gmail", "m1", "watch:brightwater-order-shipping"]]);
  const saved = db.updates.at(-1).patch;
  assert.equal(saved.status, "done");
  assert.ok(saved.fired_at);
  assert.equal(saved.watched_until, "2026-11-03T08:00:00.000Z");
  assert.deepEqual(saved.watch_seen.sort(), ["m1", "m2"], "each item is judged once");
});

test("the order confirmation is not the shipping notice: the model says no and nothing runs", async () => {
  const db = fakeDb([email("m3", { from: "orders@brightwater.example", subject: "Thanks for your order BW-40417", body: "We'll email when it ships" })]);
  const d = deps(db, '{"matches":[]}');
  const r = await watches.checkWatch(watch(), d.deps);
  assert.equal(r.fired, 0);
  assert.equal(d.ran.length, 0);
  assert.equal(db.updates.at(-1).patch.status, undefined, "still watching");
  assert.deepEqual(db.updates.at(-1).patch.watch_seen, ["m3"]);
});

test("a watch never reads what the person sent, drafted, a sign-in code, or mail from before it began", async () => {
  const db = fakeDb([
    email("s1", { subject: "Re: BW-40417", labels: ["SENT"] }),
    email("d1", { subject: "BW-40417 question", is_draft: true }),
    email("c1", { subject: "Your verification code", body: "Your code is 482915 for order BW-40417. Sign in to continue." }),
    email("o1", { subject: "BW-40417 shipped" }, "2026-11-03T08:00:00.000Z", "2026-11-01T09:00:00.000Z"),
  ]);
  const d = deps(db, '{"matches":[1]}');
  const r = await watches.checkWatch(watch(), d.deps);
  assert.equal(d.asked.length, 0, "nothing reached the model");
  assert.equal(r.fired, 0);
});

test("when no model can answer, nothing is marked and the same items are asked about next minute", async () => {
  const db = fakeDb([email("m1", { subject: "Your order BW-40417 has shipped" })]);
  const d = deps(db, null);
  const r = await watches.checkWatch(watch(), d.deps);
  assert.equal(r.waiting, "model");
  assert.equal(db.updates.length, 0);
});

test("a watch that runs every time keeps going, and a watch with no words asks the model about every new item", async () => {
  const rows = [
    email("t1", { from: "rent@lettings.example", subject: "Rent received" }),
    email("t2", { from: "rent@lettings.example", subject: "Rent reminder" }),
  ];
  const db = fakeDb(rows);
  const d = deps(db, '{"matches":[1,2]}');
  const r = await watches.checkWatch(watch({ run_once: false, watch_words: [], expires_at: null, trigger_event_condition: "a rent email from the letting agent" }), d.deps);
  assert.equal(r.fired, 2);
  assert.match(d.asked[0], /\[1\][\s\S]*\[2\]/);
  assert.equal(db.updates.at(-1).patch.status, undefined);
});

test("a watch for one thing that runs out says so and ends", async () => {
  const db = fakeDb([]);
  const d = deps(db, '{"matches":[]}');
  const r = await watches.checkWatch(watch({ expires_at: "2026-11-03T08:59:00.000Z", trigger_timezone: "Europe/London" }), d.deps);
  assert.equal(r.expired, true);
  assert.equal(db.updates[0].patch.status, "expired");
  assert.match(d.said[0], /^Nothing came for "Brightwater Toys' email saying order BW-40417 has shipped" by Tuesday 3 November, so I've stopped watching for it\./);
});

test("bank transactions count by their day, and the person's own chat messages never count", async () => {
  const bank = { source: "lunchflow", type: "bank_transaction", external_id: "tx:1", received_at: "2026-11-02T00:00:00.000Z", synced_at: "2026-11-03T08:00:00.000Z", created_at: "2026-11-03T08:00:00.000Z",
    data: { date: "2026-11-02", amount: -950, currency: "GBP", payee: "Harbour Lettings", description: "RENT NOV", account_name: "Current" } };
  const d1 = deps(fakeDb([bank]), '{"matches":[1]}');
  const r1 = await watches.checkWatch(watch({ trigger_event_source: "bank", watch_words: ["harbour lettings"], trigger_event_condition: "November rent leaving the account" }), d1.deps);
  assert.equal(r1.fired, 1, "dated the day the watch began, still counts");
  const mine = { source: "whatsapp", type: "message", external_id: "wa-1", received_at: "2026-11-03T07:59:00.000Z", synced_at: "2026-11-03T08:00:00.000Z", created_at: "2026-11-03T08:00:00.000Z", data: { sender: "me", text: "did the parcel come?", chat_name: "Sam" } };
  assert.equal(watches.ignored(mine), true);
});

test("Pulse leaves alone what a watch with words is waiting for, and what anyone already told", () => {
  const w = watch();
  assert.equal(watches.claims(w, email("m1", { subject: "Order BW-40417 has shipped" })), true);
  assert.equal(watches.claims(w, email("m2", { subject: "Autumn sale" })), false);
  assert.equal(watches.claims(watch({ watch_words: [] }), email("m3", { subject: "anything" })), false, "a watch with no words never silences Pulse");
  assert.equal(watches.claims(watch({ trigger_event_source: "bank" }), email("m4", { subject: "BW-40417" })), false);
  const pulse = read("lib/pulse.js");
  assert.match(pulse, /!toldKeys\.has\(toldItems\.key\(e\.source, e\.external_id\)\) && !openWatches\.some\(\(w\) => watches\.claims\(w, e\)\)/);
  assert.match(pulse, /await toldItems\.recordTold\(supabase, userId, flaggedItems, "pulse"\);/, "what Pulse tells is recorded");
  assert.match(pulse, /const cite = \(lines\) => lines\.map\(\(l\) => `\[\$\{\+\+n\}\] \$\{l\}`\);/, "items are numbered across the picture");
  assert.match(read("lib/pulse-triage.js"), /starting with the numbers of the items it rests on/);
});

test("the chat tool makes a watch only for what one can see, with its words, end date and plain message", () => {
  const h = read("lib/tools/handlers.js");
  assert.match(h, /if \(isWatch && !watchSource\) return \{ error: "A watch can look at " \+ kinds\.choices\(\)/);
  assert.match(h, /const modelMap = \{ fast: "haiku", balanced: "sonnet", thorough: "opus"/, "the effort the tool offers reaches the routine");
  assert.match(h, /run_once: runOnce,\n\s+watch_words: watchWords,\n\s+expires_at: expiresAt,/);
  assert.match(h, /"Watch '" \+ auto\.name \+ "' is on: " \+ looks/);
  const defs = read("lib/tools/definitions.js");
  assert.match(defs, /event_source: \{ type: "string", enum: \["email", "messages", "calendar", "bank", "notes", "bookings"\]/);
  assert.match(defs, /never promise to watch those/);
  assert.match(read("lib/engine.js"), /is made only with a watch behind it: in the same turn, create one with automation_create/);
  assert.match(read("index.js"), /require\("\.\/lib\/watches"\)\.start\(\);/);
});

test("the dashboard checks a watch it saves, arms it from now, and shows where it stands", () => {
  const server = read("webapp/server.js");
  const watchFields = new Function("watchKinds", server.slice(server.indexOf("function watchFields("), server.indexOf("// What the routine form offers to wait for.")) + "return watchFields;")(require("../webapp/watch-kinds"));
  assert.equal(watchFields({ trigger_type: "event", trigger_event_source: "shopify", trigger_event_condition: "x" }).ok, false);
  assert.equal(watchFields({ trigger_type: "event", trigger_event_condition: " " }).ok, false);
  const now = Date.parse("2026-11-03T09:00:00.000Z");
  const w = watchFields({ trigger_type: "event", trigger_event_condition: "the shipping email", watch_words: "BW-40417, Brightwater" }, now).fields;
  assert.deepEqual(w.watch_words, ["BW-40417", "Brightwater"]);
  assert.equal(w.run_once, true);
  assert.equal(w.expires_at, "2026-12-03T09:00:00.000Z");
  assert.equal(w.watched_until, "2026-11-03T09:00:00.000Z");
  assert.equal(w.status, "active");
  assert.deepEqual(watchFields({ trigger_type: "scheduled" }).fields, { run_once: false, watch_words: [], expires_at: null, trigger_when: "arrives", trigger_offset_minutes: 0 });
  assert.match(server, /watched_until: _looked, watch_seen: _judged, fired_at: _fired, expires_at: _ends, \.\.\.changes \} = req\.body/, "how far it looked is not the browser's to set");
  const dash = read("webapp/views/dashboard.html");
  for (const id of ["auto-event-source", "auto-event-condition", "auto-event-words", "auto-event-once"]) assert.match(dash, new RegExp(`id="${id}"`));
  assert.match(dash, /function watchLine\(a\)/);
  assert.doesNotMatch(dash, /Shopify order over 500/, "the form no longer suggests what a watch cannot see");
  const sql = read("migrations/059_watches.sql");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS told_items/);
  assert.match(sql, /UPDATE automations SET watched_until = now\(\) WHERE trigger_type = 'event' AND watched_until IS NULL;/, "routines saved before watches ran start from now");
  assert.match(sql, /CHECK \(status IN \('active', 'paused', 'idle', 'done', 'expired'\)\)/);
});
