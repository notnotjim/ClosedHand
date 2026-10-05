// Recall searches on the message's own words first, borrows only the last half
// hour of conversation to fill in a follow-up, and never hands back the
// message it is answering. A question about a dentist appointment, asked two
// hours after a reminder about cloud storage, was searched as the reminder.
// All content invented.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildSearchQuery, notTheMessage } = require("../lib/brain")._test;
const { lexicalTokens } = require("../lib/services/lexical");

const now = Date.parse("2026-10-05T03:00:00Z");
const at = (minutesAgo) => new Date(now - minutesAgo * 60000).toISOString();
const reminder = { role: "assistant", ts: at(120), content: "Your cloud storage is full: device backups, photo upload and drive sync have stopped. Upgrade the plan or clear old videos and backups?" };

test("a new question long after the last turns is searched on its own words", () => {
  const q = "How come you didn't remind me about my dentist appointment?";
  assert.equal(buildSearchQuery(q, [reminder], now), q);
  assert.ok(lexicalTokens(buildSearchQuery(q, [reminder], now)).includes("dentist"));
});

test("a follow-up borrows the last half hour, with its own words first", () => {
  const turns = [
    { role: "user", ts: at(4), content: "find me three hotels near the harbour for next week" },
    { role: "assistant", ts: at(3), content: "Harbour House, Quay Rooms and The Anchor, all under £90 a night." },
  ];
  const q = buildSearchQuery("which of those is closest to the market?", turns, now);
  assert.ok(q.startsWith("which of those is closest to the market?\n"), "the message leads");
  assert.match(q, /Harbour House, Quay Rooms and The Anchor/);
  assert.deepEqual(lexicalTokens(q).slice(0, 3), ["those", "closest", "market"], "the keyword search sees the message's words before the context's");
  assert.equal(buildSearchQuery("which of those?", [{ role: "assistant", content: "Quay Rooms or The Anchor" }], now),
    "which of those?\nQuay Rooms or The Anchor", "a turn stored without a time still counts");
  const long = "Please put together a comparison of the three harbour hotels with prices, reviews and distance to the market";
  assert.equal(buildSearchQuery(long, turns, now), long, "a long message that refers to nothing stands alone");
});

test("the message being answered is never its own context", () => {
  const msg = "How come you didn't remind me about my dentist appointment?";
  const results = [
    { service: "whatsapp", content: "me (447700900123)\nHow come you didn't  remind me about my dentist appointment?" },
    { service: "whatsapp", content: "[WhatsApp Harbour Dental, 2026-09-30] Confirmed the next appointment for 9am on 6 October." },
  ];
  assert.deepEqual(notTheMessage(results, msg).map((r) => r.content), [results[1].content]);
  assert.equal(notTheMessage(results, "ok").length, 2, "a short reply could be anywhere; nothing is dropped");
  const brain = fs.readFileSync(path.join(__dirname, "../lib/brain.js"), "utf8");
  assert.match(brain, /const serviceResults = notTheMessage\(/);
  assert.match(brain, /buildSearchQuery\(userMessage, recentTurns, opts\.at \? Date\.parse\(opts\.at\) : Date\.now\(\)\)/);
});
