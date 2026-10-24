// Everything Closedhand says unprompted lands in someone's own chat app, so
// each message must be accurate, specific and wanted. These are the checks
// that hold it to that (lib/nudge-gate.js) and the mistakes Pulse made before
// them: meeting times given to the model in UTC, mail that synced late never
// looked at, a screening that failed counted as nothing to say, the recent
// chat never seen, and quiet hours kept by Pulse alone.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

require.cache[require.resolve("../lib/db")] = { id: "db", loaded: true, exports: { supabase: {} } };
const gate = require("../lib/nudge-gate");
const tz = require("../lib/timezone");
const { quietNow, getProactiveTargets } = require("../lib/proactive");

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
  assert.equal((await gate.check({ userId: "u1", store: tokyo, message: "x y z", evidence: "", modelFor: judge(new Error("provider down")) })).send, false, "fails closed");
  assert.equal((await gate.check({ userId: "u1", store: tokyo, message: "  ", evidence: "" })).send, false);
});

test("times are where the person is, and an all-day event is its own date", () => {
  assert.equal(tz.eventWhen("2026-11-13", "Asia/Tokyo"), "Friday 13 November, all day");
  assert.match(tz.eventWhen("2026-10-17T02:00:00+08:00", "Asia/Tokyo"), /^Saturday,? 17 October at 03:00$/);
  assert.match(tz.eventWhen("2026-10-17T02:00:00+08:00", "Europe/London"), /^Friday,? 16 October at 19:00$/);
});

test("quiet hours hold every unprompted message, except one due at a set moment", async () => {
  const at = (iso) => new Date(iso);
  assert.equal(quietNow(tokyo, at("2026-10-24T14:00:00Z")), true, "23:00 in Tokyo");
  assert.equal(quietNow(tokyo, at("2026-10-24T01:00:00Z")), false, "10:00 in Tokyo");
  assert.equal(quietNow({ ...tokyo, profile: { settings: { pulse_settings: { quietEnabled: false } } } }, at("2026-10-24T14:00:00Z")), false);
  assert.equal(quietNow({ ...tokyo, profile: { settings: { pulse_settings: { quietStart: 1, quietEnd: 6 } } } }, at("2026-10-24T18:00:00Z")), true, "03:00 inside 1 to 6");

  const store = { location: { timezone: "Asia/Tokyo" }, profile: { settings: { pulse_settings: { deliveryPlatforms: ["telegram"], quietStart: 0, quietEnd: 24 } } } };
  const links = [{ platform: "telegram", platform_user_id: "7" }];
  assert.deepEqual(await getProactiveTargets("u1", store, links), [], "held for later");
  assert.deepEqual(await getProactiveTargets("u1", store, links, { anyHour: true }), links, "a gate change is due now");
  assert.match(read("lib/flights-scheduler.js"), /getProactiveTargets\(userId, userStore, chatLinks, \{ anyHour: true \}\)/);
  assert.match(read("lib/goal-check-ins.js"), /getProactiveTargets\(userId, store, links \|\| \[\], \{ anyHour: true \}\)/, "a check-in at the time they chose");
  assert.doesNotMatch(read("lib/pulse.js"), /function isQuietHours/, "one copy of quiet hours");
});

test("a screening with no answer is tried again, not passed over", async () => {
  const { triage } = require("../lib/pulse-triage");
  const run = (raw) => triage({ items: ["[1] EMAIL from a@example.test: x"], level: "medium", fallback: async () => raw });
  assert.deepEqual(await run(null), { failed: true });
  assert.deepEqual(await run("sorry, busy"), { failed: true });
  assert.deepEqual(await run('{"pulse": false}'), { pulse: false });
  const pulse = read("lib/pulse.js");
  assert.match(pulse, /if \(verdict\.failed\) \{ console\.log\([^\n]*\); return; \}/, "no markChecked");
});

test("Pulse: new mail by when it arrived, local times, the chat lately, the check, and told only when delivered", () => {
  const pulse = read("lib/pulse.js");
  assert.match(pulse, /\.gt\("created_at", lookback\)\.gt\("received_at", new Date\(Date\.now\(\) - 3 \* 86400000\)\.toISOString\(\)\)/);
  assert.match(pulse, /EVENT starting within 3h: \$\{ev\.summary \|\| "untitled"\}, \$\{require\("\.\/timezone"\)\.eventWhen\(ev\.start \|\| ev\.received_at, userTz\)\}/);
  assert.match(pulse, /!\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(String\(ev\.start \|\| ""\)\)/, "all-day events are not starting soon");
  assert.match(pulse, /\.\.\.recent\.map\(\(m\) => `Said in the chat lately/);
  const at = pulse.indexOf("const verdictToSend = await gate.check(");
  assert.ok(at > 0 && at < pulse.indexOf("await deliver(text);"), "checked before it goes");
  assert.match(pulse.slice(pulse.indexOf("await deliver(text);")), /^await deliver\(text\);\n[^\n]*\n\s*if \(sent\) \{[\s\S]{0,400}recordTold/, "told only when it reached someone");
  assert.match(pulse, /try \{ await sendToPlatform\(t\.platform, t\.platform_user_id, text\); sent = true; \}/);
});

test("a sign-in to do again is told once it can be, and again after the next failure", async () => {
  const calls = [];
  const fakeDb = { from: () => ({ update: (m) => { calls.push(m); return { eq: () => ({ eq: async () => ({ error: null }) }) }; } }) };
  require.cache[require.resolve("../lib/db")].exports.supabase = fakeDb;
  const alert = require("../lib/connection-alert");
  const store = { connections: { google: { metadata: { email: "ana@harbour.test", reconnect_required: true, reconnect_told: false } } }, profile: { settings: { pulse_settings: { deliveryPlatforms: [] } } } };
  // No chat app chosen: nothing goes, and nothing is marked told.
  require.cache[require.resolve("../lib/proactive")].exports.getProactiveTargets = async () => [];
  const realDb = require.cache[require.resolve("../lib/db")].exports;
  realDb.supabase = { from: (t) => (t === "chat_links" ? { select: () => ({ eq: async () => ({ data: [] }) }) } : fakeDb.from(t)) };
  assert.equal(await alert.tellOwnerOnce("u1", store, "google"), false);
  assert.equal(store.connections.google.metadata.reconnect_told, false, "kept for the next sweep");
  // Once a chat app is chosen, the sweep tells it and marks it told.
  const sent = [];
  require.cache[require.resolve("../lib/messaging")] = { id: "m", loaded: true, exports: { sendToPlatform: async (...a) => sent.push(a) } };
  require.cache[require.resolve("../lib/dashboard-links")] = { id: "d", loaded: true, exports: { dashboardUrl: async () => "https://fixture.example/dashboard#connections" } };
  require.cache[require.resolve("../lib/proactive")].exports.getProactiveTargets = async () => [{ platform: "telegram", platform_user_id: "7" }];
  assert.equal(await alert.tellOwnerOnce("u1", store, "google"), true);
  assert.equal(sent.length, 1);
  assert.equal(store.connections.google.metadata.reconnect_told, true);
  assert.equal(calls.at(-1).metadata.reconnect_told, true, "saved");
  assert.equal(await alert.tellOwnerOnce("u1", store, "google"), false, "and not told twice");
  assert.equal(sent.length, 1);
  assert.match(read("user-store.js"), /reconnect_required: true, reconnect_reason: reason, reconnect_told: false/, "each new failure is told");
  assert.match(read("user-store.js"), /require\("\.\/lib\/connection-alert"\)\.tellOwnerOnce\(this\.userId, this, service\)/);
  assert.deepEqual(require("../webapp/connection-health").cleared({ email: "a", reconnect_required: true, reconnect_reason: "x", reconnect_told: true }), { email: "a" });
  assert.match(read("index.js"), /require\("\.\/lib\/connection-alert"\)\.start\(\);/);
});
