// Everything Closedhand says unprompted lands in someone's own chat app, so
// each message must be accurate, specific and wanted. These are the checks
// that hold it to that (lib/nudge-gate.js) and the mistakes Pulse made before
// them: meeting times given to the model in UTC, mail that synced late never
// looked at, a screening that failed counted as nothing to say, the recent
// chat never seen, quiet hours kept by Pulse alone, and messages raised in
// the night either sent in it or lost.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

require.cache[require.resolve("../lib/db")] = { id: "db", loaded: true, exports: { supabase: {} } };
const gate = require("../lib/nudge-gate");
const tz = require("../lib/timezone");
const proactive = require("../lib/proactive");
const { quietNow } = proactive;

const tokyo = { userId: "u1", location: { timezone: "Asia/Tokyo" }, profile: { settings: {} },
  conversations: [{ role: "user", content: "Is the dentist still on Thursday?" }, { role: "assistant", content: [{ type: "text", text: "Yes, Thursday at 09:00." }] }] };
const judge = (answer, seen = []) => () => ({ model: "main", client: { messages: { create: async (req) => { seen.push(req); if (answer instanceof Error) throw answer; return { content: [{ type: "text", text: answer }] }; } } } });

test("a message goes only when the person's LLM clearly says so, and never when the check cannot run", async () => {
  const seen = [];
  const ok = await gate.check({ userId: "u1", store: tokyo, message: "Ravi moved Saturday's dinner at Hearth to 19:30.", evidence: "EMAIL from Ravi: dinner at Hearth moved to 19:30 on Saturday", modelFor: judge('{"send": true, "problems": []}', seen) });
  assert.deepEqual(ok, { send: true, problems: [] });
  const asked = JSON.parse(seen[0].messages[0].content);
  assert.match(asked.now, /\(Asia\/Tokyo\)/, "judged against the time where they are");
  assert.equal(asked.recent_conversation[0].text, "Is the dentist still on Thursday?", "and what they already know");
  assert.match(seen[0].system, /a fact in the message[^\n]*is not in the evidence, or differs from it[\s\S]*a time or day is not right for where the user is now[\s\S]*When unsure, say no\./);

  const no = await gate.check({ userId: "u1", store: tokyo, message: "Your dentist is on Friday.", evidence: "Dentist Thursday 09:00", modelFor: judge('{"send": false, "problems": ["The evidence says Thursday"]}') });
  assert.deepEqual(no, { send: false, problems: ["The evidence says Thursday"] });
  assert.equal((await gate.check({ userId: "u1", store: tokyo, message: "x y z", evidence: "", modelFor: judge("I think it is fine") })).send, false, "an answer that is not a verdict");
  assert.equal((await gate.check({ userId: "u1", store: tokyo, message: "Ravi moved dinner to 19:30.", evidence: "Ravi: 19:30", modelFor: judge('Checked it.\n{"send": true, "problems": []}') })).send, true, "words around the JSON");
  assert.equal(seen[0].max_tokens, 8000, "room for a reasoning LLM to finish");
  assert.equal((await gate.check({ userId: "u1", store: tokyo, message: "x y z", evidence: "", modelFor: judge(new Error("provider down")) })).send, false, "fails closed");
  assert.equal((await gate.check({ userId: "u1", store: tokyo, message: "  ", evidence: "" })).send, false);
});

test("times are where the person is, and an all-day event is its own date", () => {
  assert.equal(tz.eventWhen("2026-11-13", "Asia/Tokyo"), "Friday 13 November, all day");
  assert.match(tz.eventWhen("2026-10-17T02:00:00+08:00", "Asia/Tokyo"), /^Saturday,? 17 October at 03:00$/);
  assert.match(tz.eventWhen("2026-10-17T02:00:00+08:00", "Europe/London"), /^Friday,? 16 October at 19:00$/);
});

// A stand-in for the database: chat links, held messages, and what was asked.
function fakeDb(rows = { chat_links: [], held_messages: [] }) {
  const q = (table) => {
    const filters = [];
    const api = {
      select: () => api, order: () => api,
      eq: (k, v) => { filters.push([k, v]); return api; },
      insert: async (row) => { rows[table].push({ id: "h" + rows[table].length, created_at: new Date().toISOString(), ...row }); return { error: null }; },
      delete: () => ({ eq: async (k, v) => { rows[table] = rows[table].filter((r) => r[k] !== v); return { error: null }; } }),
      then: (ok) => ok({ data: rows[table].filter((r) => filters.every(([k, v]) => r[k] === v)), error: null }),
    };
    return api;
  };
  return { rows, from: q };
}

test("quiet hours, in the person's own time zone, hold every notice until they end", async () => {
  const at = (iso) => new Date(iso);
  assert.equal(quietNow(tokyo, at("2026-10-24T14:00:00Z")), true, "23:00 in Tokyo");
  assert.equal(quietNow(tokyo, at("2026-10-24T01:00:00Z")), false, "10:00 in Tokyo");
  assert.equal(quietNow({ ...tokyo, profile: { settings: { pulse_settings: { quietEnabled: false } } } }, at("2026-10-24T14:00:00Z")), false);
  assert.equal(quietNow({ ...tokyo, profile: { settings: { pulse_settings: { quietStart: 1, quietEnd: 6 } } } }, at("2026-10-24T18:00:00Z")), true, "03:00 inside 1 to 6");

  const db = fakeDb();
  require.cache[require.resolve("../user-store")] = { id: "us", loaded: true, exports: { supabase: db } };
  delete require.cache[require.resolve("../lib/proactive")];
  const p = require("../lib/proactive");
  const sent = [];
  require.cache[require.resolve("../lib/messaging")] = { id: "m", loaded: true, exports: { sendToPlatform: async (...a) => sent.push(a) } };
  const settings = (quiet) => ({ location: { timezone: "Asia/Tokyo" }, profile: { settings: { pulse_settings: { deliveryPlatforms: ["telegram"], ...(quiet ? { quietStart: 0, quietEnd: 24 } : { quietEnabled: false }) } } } });
  const links = [{ platform: "telegram", platform_user_id: "7" }, { platform: "discord", platform_user_id: "9" }];

  assert.equal(await p.deliverUnprompted("u1", settings(true), links, (t) => `Bank needs you, via ${t.platform}`), true, "held counts as told");
  assert.equal(sent.length, 0, "nothing in the night");
  assert.deepEqual(db.rows.held_messages.map((h) => [h.platform, h.text]), [["telegram", "Bank needs you, via telegram"]], "only the chosen chat app");
  assert.equal(await p.sendHeld("u1", async () => settings(true)), 0, "still quiet");
  assert.equal(await p.sendHeld("u1", async () => settings(false)), 1);
  assert.deepEqual(sent, [["telegram", "7", "Bank needs you, via telegram"]]);
  assert.equal(db.rows.held_messages.length, 0, "and it goes once");

  assert.equal(await p.deliverUnprompted("u1", settings(false), links, () => "Now"), true);
  assert.equal(sent.length, 2, "out of quiet hours it goes at once");
  const none = { profile: { settings: { pulse_settings: { deliveryPlatforms: [] } } } };
  assert.equal(await p.deliverUnprompted("u1", none, links, () => "x"), false, "nowhere to send it");

  assert.match(read("lib/connection-alert.js"), /require\("\.\/proactive"\)\.deliverUnprompted\(userId, store, links \|\| \[\],/, "notices, bank ones included, use it");
  assert.match(read("migrations/071_held_messages.sql"), /user_id          uuid NOT NULL REFERENCES profiles\(id\) ON DELETE CASCADE/);
  assert.match(read("index.js"), /require\("\.\/lib\/proactive"\)\.start\(\);/);
  assert.doesNotMatch(read("lib/pulse.js"), /function isQuietHours/, "one copy of quiet hours");
  assert.match(read("lib/pulse.js"), /if \(require\("\.\/proactive"\)\.quietNow\(store\)\) \{/);
});

test("the clock follows flight tracking: after a landing, quiet hours and the check use the new place", async () => {
  const { personZone, timeBlock } = require("../lib/time-context");
  const now = new Date("2026-11-02T23:30:00Z"); // 08:30 in Tokyo, 23:30 in London
  const landed = { location: { timezone: "Asia/Tokyo", name: "Tokyo", updated: "2026-10-01T00:00:00Z" }, profile: { settings: {} },
    facts: { "flight-ZX101": JSON.stringify({ flightNumber: "ZX101", departure: { airport: "HND", tz: "Asia/Tokyo", dateTime: "2026-11-02T10:00:00+09:00" }, arrival: { airport: "LHR", tz: "Europe/London", dateTime: "2026-11-02T22:30:00Z" } }) } };
  assert.equal(personZone(landed, now), "Europe/London", "landed an hour ago");
  assert.equal(personZone({ ...landed, facts: {} }, now), "Asia/Tokyo", "no flight: the saved place");
  assert.equal(quietNow(landed, now), true, "23:30 in London is quiet, though 08:30 in Tokyo is not");
  assert.equal(quietNow({ ...landed, facts: {} }, now), false);
  assert.match(timeBlock(landed, now), /Europe\/London, inferred from flight ZX101/);

  const seen = [];
  const hour = 3600000, iso = (ms) => new Date(ms).toISOString();
  const justLanded = { ...landed, facts: { "flight-ZX101": JSON.stringify({ flightNumber: "ZX101", departure: { airport: "HND", tz: "Asia/Tokyo", dateTime: iso(Date.now() - 13 * hour) }, arrival: { airport: "LHR", tz: "Europe/London", dateTime: iso(Date.now() - hour) } }) } };
  await gate.check({ userId: "u1", store: justLanded, message: "Your bag for ZX101 is at belt 5.", evidence: "x", modelFor: judge('{"send": true}', seen) });
  assert.match(JSON.parse(seen[0].messages[0].content).now, /Europe\/London/, "the check is told where they are now");
  assert.match(seen[0].system, /A travel time given in its own airport's or property's local time, and saying so, is right/);
  const pulse = read("lib/pulse.js");
  assert.match(pulse, /const userTz = timeContext\.personZone\(store\);/);
  assert.match(pulse, /"\\n\\n" \+ timeContext\.timeBlock\(store\);/, "the writer gets the chat's clock and flight dates");
  assert.doesNotMatch(pulse, /nowStamp/);
});

test("a flight found at setup is told the way every found flight is", () => {
  const onboarding = read("lib/onboarding.js");
  assert.match(onboarding, /require\("\.\/flights-scheduler"\)\.announceNewFlights\(userId, ctx\.activeUserStore \|\| userStore, newFlights\)/);
  assert.doesNotMatch(onboarding, /toLocaleDateString\("en-GB", \{ weekday: "short", day: "numeric", month: "short" \}\)/, "no date in the server's time zone");
});

test("a look with no answer is tried again, not passed over", async () => {
  const { notice } = require("../lib/pulse-triage");
  const run = (raw) => notice({ items: ["[1] EMAIL from a@example.test: x"], level: "medium", ask: async () => raw });
  assert.deepEqual(await run(null), { failed: true });
  assert.deepEqual(await run("sorry, busy"), { failed: true });
  assert.deepEqual(await run('{"pulse": false}'), { pulse: false });
  const pulse = read("lib/pulse.js");
  assert.match(pulse, /if \(verdict\.failed\) \{ console\.log\([^\n]*\); return; \}/, "no markChecked");
});

test("Pulse: new mail by when it arrived, local times, the chat lately, the check, and told only when delivered", () => {
  const pulse = read("lib/pulse.js");
  assert.match(pulse, /\.gt\("created_at", lookback\)\.gt\("received_at", new Date\(Date\.now\(\) - 3 \* 86400000\)\.toISOString\(\)\)/);
  assert.match(pulse, /const line = \(r\) => watches\.itemText\(r, userTz\)/, "every item, coming ones included, in the person's time");
  assert.match(pulse, /\.\.\.recent\.map\(\(m\) => `Said in the chat lately/);
  const at = pulse.indexOf("const verdictToSend = await gate.check(");
  assert.ok(at > 0 && at < pulse.indexOf("await deliver(text);"), "checked before it goes");
  assert.match(pulse.slice(pulse.indexOf("await deliver(text);")), /^await deliver\(text\);\n[^\n]*\n\s*if \(sent\) \{[\s\S]{0,400}recordTold/, "told only when it reached someone");
  assert.match(pulse, /try \{ await sendToPlatform\(t\.platform, t\.platform_user_id, text\); sent = true; \}/);
});

test("Pulse reads what is new from every connection, not only mail and calendar, with times where the person is", () => {
  const pulse = read("lib/pulse.js");
  assert.match(pulse, /\.eq\("user_id", userId\)\.neq\("type", "email"\)\n\s*\.gt\("created_at", lookback\)/, "chats, bookings, pages, bank and the rest");
  assert.match(pulse, /const otherItems = \(newOther \|\| \[\]\)\.filter\(\(r\) => !watches\.ignored\(r\) && unclaimed\(r\)\)/, "never their own messages, nor what was told or is watched");
  assert.match(pulse, /\.\.\.otherItems\.map\(line\),/);
  assert.match(pulse, /const numbered = \[\.\.\.realEmails, \.\.\.otherItems, \.\.\.sentLines\.map\(\(\) => null\), \.\.\.coming, \.\.\.projectLines\.map\(\(\) => null\)\];/, "and whatever it tells is recorded as told, never what they sent");
  assert.match(pulse, /\.eq\("type", "message"\)\.eq\("data->>sender", "me"\)/, "what they sent is in the picture, so an answered question is not called unanswered");
  assert.match(pulse, /e\.labels\.includes\("SENT"\)/);
  assert.match(pulse, /const evidence = \[citedItems\.join\("\\n"\), flaggedText,/, "the check gets what the message stands on");
  assert.match(pulse, /Never hold back something that clears the bar\./);
  assert.doesNotMatch(pulse, /is the RIGHT answer most of the time/, "usefulness is the bar, not rarity");
  const { itemText } = require("../lib/watches");
  const msg = { type: "message", source: "whatsapp", data: { chat_name: "Harbour group", sender: "Ana", date: "2026-10-23T18:42:00Z", text: "Still on for lunch?" } };
  assert.match(itemText(msg, "Asia/Tokyo"), /from Ana, Saturday,? 24 October at 03:42: Still on for lunch\?/, "Friday in UTC was Saturday in Tokyo");
  assert.match(itemText(msg), /2026-10-23T18:42:00Z/, "watches' own use unchanged");
});

test("a sign-in to do again is told once it can be, and again after the next failure", async () => {
  const calls = [];
  const fakeDb = { from: () => ({ update: (m) => { calls.push(m); return { eq: () => ({ eq: async () => ({ error: null }) }) }; } }) };
  require.cache[require.resolve("../lib/db")].exports.supabase = fakeDb;
  const alert = require("../lib/connection-alert");
  const store = { connections: { google: { metadata: { email: "ana@harbour.test", reconnect_required: true, reconnect_told: false } } }, profile: { settings: { pulse_settings: { deliveryPlatforms: [] } } } };
  // No chat app chosen: nothing goes, and nothing is marked told.
  const delivered = [];
  require.cache[require.resolve("../lib/proactive")].exports.deliverUnprompted = async (u, st, l, textFor) => (st.chosen ? (delivered.push(await textFor({ platform: "telegram" })), true) : false);
  const realDb = require.cache[require.resolve("../lib/db")].exports;
  realDb.supabase = { from: (t) => (t === "chat_links" ? { select: () => ({ eq: async () => ({ data: [] }) }) } : fakeDb.from(t)) };
  assert.equal(await alert.tellOwnerOnce("u1", store, "google"), false);
  assert.equal(store.connections.google.metadata.reconnect_told, false, "kept for the next sweep");
  // Once a chat app is chosen, the sweep tells it and marks it told.
  require.cache[require.resolve("../lib/dashboard-links")] = { id: "d", loaded: true, exports: { dashboardUrl: async () => "https://fixture.example/dashboard#connections" } };
  store.chosen = true;
  assert.equal(await alert.tellOwnerOnce("u1", store, "google"), true);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0], /ana@harbour\.test[\s\S]*https:\/\/fixture\.example\/dashboard#connections/);
  assert.equal(store.connections.google.metadata.reconnect_told, true);
  assert.equal(calls.at(-1).metadata.reconnect_told, true, "saved");
  assert.equal(await alert.tellOwnerOnce("u1", store, "google"), false, "and not told twice");
  assert.equal(delivered.length, 1);
  assert.match(read("user-store.js"), /reconnect_required: true, reconnect_reason: reason, reconnect_told: false/, "each new failure is told");
  assert.match(read("user-store.js"), /require\("\.\/lib\/connection-alert"\)\.tellOwnerOnce\(this\.userId, this, service\)/);
  assert.deepEqual(require("../webapp/connection-health").cleared({ email: "a", reconnect_required: true, reconnect_reason: "x", reconnect_told: true }), { email: "a" });
  assert.match(read("index.js"), /require\("\.\/lib\/connection-alert"\)\.start\(\);/);
});
