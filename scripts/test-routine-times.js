// A routine can wait for any kind of item the sync stores, and bookings, as
// each arrives, and for kinds with a time of their own it can run at a
// moment each item sets: an hour before each meeting, a day before each
// booking, as each meeting ends (lib/watch-kinds.js, lib/watches.js). One
// list of kinds, read by the bot, the server and the routine form.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const kinds = require("../lib/watch-kinds");
const watches = require("../lib/watches");

const NOW = Date.parse("2026-11-03T09:00:00.000Z");
const at = (min) => new Date(NOW + min * 60000).toISOString();

function fakeDb(tables) {
  const updates = [];
  const value = (r, k) => (k.startsWith("data->>") ? (r.data || {})[k.slice(7)] : r[k]);
  return {
    updates,
    from(table) {
      const filters = [];
      let patch = null;
      const q = {
        select: () => q, order: () => q, limit: () => q,
        eq: (k, v) => { filters.push((r) => k === "user_id" || value(r, k) === v); return q; },
        in: (k, v) => { filters.push((r) => v.includes(value(r, k))); return q; },
        gt: (k, v) => { filters.push((r) => value(r, k) > v); return q; },
        gte: (k, v) => { filters.push((r) => value(r, k) >= v); return q; },
        lte: (k, v) => { filters.push((r) => value(r, k) <= v); return q; },
        update: (p) => { patch = p; return q; },
        upsert: async () => ({ error: null }),
        then: (ok) => {
          if (patch) { updates.push({ table, patch }); return Promise.resolve({ error: null }).then(ok); }
          return Promise.resolve({ data: (tables[table] || []).filter((r) => filters.every((f) => f(r))), error: null }).then(ok);
        },
      };
      return q;
    },
  };
}

const event = (id, startMin, endMin, extra = {}) => ({ source: "gcal", type: "event", external_id: id, created_at: "2026-10-01T00:00:00.000Z", synced_at: at(-1),
  data: { summary: `Meeting ${id}`, start: at(startMin), end: at(endMin), attendees: [{ email: "dana@example.com" }], ...extra } });
const watch = (extra = {}) => ({ id: "w1", user_id: "u1", name: "agenda-before-meetings", status: "active", trigger_type: "event",
  trigger_event_source: "calendar", trigger_event_condition: "every calendar event", trigger_when: "before", trigger_offset_minutes: 60,
  trigger_timezone: "Asia/Tokyo", watch_words: [], run_once: false, created_at: "2026-11-01T00:00:00.000Z", watched_until: at(-2), watch_seen: [], ...extra });
function deps(db, answer = '{"matches":[1]}') {
  const ran = [], asked = [];
  return { ran, asked, deps: { db, now: NOW, ask: async (u, system, message) => { asked.push({ system, message }); return answer; }, run: async (w, input) => { ran.push(input); }, say: async () => {} } };
}

test("one list of kinds, in words", () => {
  assert.deepEqual(Object.keys(kinds.KINDS), ["email", "messages", "calendar", "bank", "notes", "bookings"]);
  assert.equal(kinds.describe("calendar", "before", 60), "an hour before each calendar event");
  assert.equal(kinds.describe("bookings", "before", 1440), "a day before each booking");
  assert.equal(kinds.describe("calendar", "after", 0), "as each calendar event ends");
  assert.equal(kinds.describe("calendar", "before", 30), "30 minutes before each calendar event");
  assert.equal(kinds.describe("bank"), "each new bank transaction");
  assert.deepEqual(kinds.choices().filter((c) => c.timed).map((c) => c.id), ["calendar", "bookings"], "only kinds with a time can run around it");
  assert.equal(read("lib/watch-kinds.js"), read("webapp/watch-kinds.js"));
});

test("an hour before each meeting: the meeting whose moment has come runs once, the others wait", async () => {
  const db = fakeDb({ data_cache: [event("due", 59, 90), event("later", 180, 240), event("declined", 59, 90, { attendees: [{ self: true, responseStatus: "declined" }] })] });
  const d = deps(db);
  const r = await watches.checkWatch(watch(), d.deps);
  assert.equal(r.fired, 1);
  assert.match(d.ran[0], /This routine runs an hour before each calendar event, and it is that time now for this one:\nCalendar event: Meeting due/);
  assert.equal(d.asked.length, 1);
  assert.match(d.asked[0].message, /^The routine is for: every calendar event/);
  assert.doesNotMatch(d.asked[0].message, /Meeting declined/, "a meeting the person declined is left out");
  const saved = db.updates[0].patch;
  assert.equal(saved.watched_until, new Date(NOW).toISOString());
  assert.equal(saved.watch_seen.length, 1);
  // The next minute: the same moment is never judged again.
  const again = deps(db);
  await watches.checkWatch(watch({ watched_until: saved.watched_until, watch_seen: saved.watch_seen }), again.deps);
  assert.equal(again.ran.length, 0);
});

test("a moment missed while the computer was off is skipped, as schedules are", async () => {
  const db = fakeDb({ data_cache: [event("missed", 0, 30)] }); // its moment was an hour ago
  const d = deps(db);
  await watches.checkWatch(watch({ watched_until: at(-180) }), d.deps);
  assert.equal(d.ran.length, 0);
});

test("after each one ends, all-day dates in the person's own time, and bookings", async () => {
  const ended = deps(fakeDb({ data_cache: [event("call", -45, 0)] }));
  await watches.checkWatch(watch({ trigger_when: "after", trigger_offset_minutes: 0 }), ended.deps);
  assert.equal(ended.ran.length, 1);
  assert.match(ended.ran[0], /runs as each calendar event ends/);
  // An all-day date starts at midnight where the person is: 2026-11-04 in Tokyo is 15:00 UTC the day before.
  assert.equal(watches.timeOf("2026-11-04", "Asia/Tokyo"), Date.parse("2026-11-03T15:00:00.000Z"));
  const flight = { id: "b1", user_id: "u1", kind: "flight", title: "Osaka to London", starts_at: at(1440), ends_at: at(1440 + 780), status: "confirmed", detected_at: "2026-10-20T00:00:00.000Z" };
  const b = deps(fakeDb({ bookings: [flight] }));
  await watches.checkWatch(watch({ trigger_event_source: "bookings", trigger_offset_minutes: 1440, trigger_event_condition: "every flight" }), b.deps);
  assert.equal(b.ran.length, 1);
  assert.match(b.ran[0], /a day before each booking[\s\S]*Booking \(flight\): Osaka to London/);
});

test("a calendar event is new when first stored, not each time the sync saves it again", async () => {
  const old = event("old", 600, 660);
  const fresh = { ...event("fresh", 900, 960), created_at: at(-5) };
  const d = deps(fakeDb({ data_cache: [old, fresh] }), '{"matches":[1]}');
  await watches.checkWatch(watch({ trigger_when: "arrives", trigger_offset_minutes: 0, trigger_event_condition: "a new meeting", watched_until: at(-10) }), d.deps);
  assert.equal(d.ran.length, 1);
  assert.match(d.ran[0], /Meeting fresh/);
});

test("the server, the form and the chat tool all take the timing", () => {
  const server = read("webapp/server.js");
  const watchFields = new Function("watchKinds", server.slice(server.indexOf("function watchFields("), server.indexOf("// What the routine form offers to wait for.")) + "return watchFields;")(require("../webapp/watch-kinds"));
  const timed = watchFields({ trigger_type: "event", trigger_event_source: "calendar", trigger_when: "before", trigger_offset_minutes: 60 }).fields;
  assert.equal(timed.trigger_when, "before");
  assert.equal(timed.trigger_offset_minutes, 60);
  assert.equal(timed.trigger_event_condition, "every calendar event", "no words needed for every one");
  assert.equal(timed.run_once, false, "it goes on, meeting after meeting");
  assert.equal(watchFields({ trigger_type: "event", trigger_event_source: "email", trigger_when: "before", trigger_event_condition: "x" }).ok, false, "an email has no time of its own");
  assert.match(server, /app\.get\("\/api\/watch-kinds"/);
  const dash = read("webapp/views/dashboard.html");
  for (const id of ["auto-event-when", "auto-event-offset", "auto-event-when-row"]) assert.match(dash, new RegExp(`id="${id}"`));
  assert.match(dash, /trigger_when: eventWhen,\n\s*trigger_offset_minutes: eventOffset,/);
  assert.match(dash, /if \(timed\) return 'Runs ' \+ looks \+ ', for: ' \+ what;/);
  const h = read("lib/tools/handlers.js");
  assert.match(h, /const runOnce = isWatch && \(when === "arrives" \? toolInput\.once !== false : toolInput\.once === true\);/);
  assert.match(h, /trigger_when: when,\n\s*trigger_offset_minutes: offsetMinutes,/);
  assert.match(read("lib/tools/definitions.js"), /when: \{ type: "string", enum: \["arrives", "before", "after"\]/);
  assert.match(read("migrations/067_routine_times.sql"), /ADD COLUMN IF NOT EXISTS trigger_when text NOT NULL DEFAULT 'arrives';[\s\S]*trigger_offset_minutes integer NOT NULL DEFAULT 0;/);
});
