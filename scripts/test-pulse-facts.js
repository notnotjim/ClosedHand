// What code works out exactly for Pulse (lib/pulse-facts.js), so the
// person's LLM judges instead of searching, and the writer that uses it: one
// call from the cited items, tools only when it asks. On a busy day the old
// writer was nine calls and some 300,000 tokens; this was three and 13,000.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const f = require("../lib/pulse-facts");
const pulse = fs.readFileSync(path.join(__dirname, "..", "lib", "pulse.js"), "utf8");

const H = 3600000, now = Date.parse("2026-10-24T12:00:00Z");
const msg = (chat, sender, iso, text = "") => ({ source: "whatsapp", type: "message", external_id: `${chat}-${iso}`, received_at: iso, data: { chat, sender, date: iso, text } });
const mail = (threadId, iso, labels = ["INBOX"]) => ({ source: "gmail", type: "email", external_id: `${threadId}-${iso}`, received_at: iso, data: { threadId, labels, from: "ravi@lantern.test", subject: "Hearth on Saturday" } });

test("how long, in words a person reads", () => {
  assert.equal(f.span(20 * 60000), "under an hour");
  assert.equal(f.span(14 * H), "14 h");
  assert.equal(f.span(50 * H), "2 days");
});

test("whether they wrote since, by chat and by mail thread", () => {
  const wrote = f.lastWritten({ mine: [msg("harbour", "me", "2026-10-24T09:00:00Z")], sentMail: [mail("t1", "2026-10-24T08:00:00Z", ["SENT"])] });
  assert.equal(f.replyNote(msg("harbour", "Ana", "2026-10-24T08:30:00Z"), wrote, now), "you have written in this chat since");
  assert.equal(f.replyNote(msg("harbour", "Ana", "2026-10-24T10:00:00Z"), wrote, now), "nothing from you in this chat since, 2 h");
  assert.equal(f.replyNote(msg("lantern", "Ravi", "2026-10-23T22:00:00Z"), wrote, now), "nothing from you in this chat since, 14 h");
  assert.equal(f.replyNote(mail("t1", "2026-10-24T07:00:00Z"), wrote, now), "you have replied in this thread since");
  assert.equal(f.replyNote(mail("t2", "2026-10-22T10:00:00Z"), wrote, now), "no reply from you in this thread, 2 days");
});

test("waiting on them: the latest message in each conversation they have not written in since", () => {
  const wrote = f.lastWritten({ mine: [msg("harbour", "me", "2026-10-24T09:00:00Z")] });
  const rows = [
    msg("harbour", "Ana", "2026-10-24T08:00:00Z"), // answered
    msg("lantern", "Ravi", "2026-10-23T20:00:00Z"),
    msg("lantern", "Ravi", "2026-10-23T22:00:00Z"), // the latest in that chat
    mail("t9", "2026-10-24T11:00:00Z"),
  ];
  assert.deepEqual(f.waiting(rows, wrote, now).map((r) => r.external_id), ["t9-2026-10-24T11:00:00Z", "lantern-2026-10-23T22:00:00Z"]);
});

test("how soon a coming entry starts, and which overlap", () => {
  const ev = (start, end) => ({ type: "event", received_at: start, data: { start, end } });
  assert.equal(f.untilNote(ev("2026-10-24T15:00:00Z", "2026-10-24T16:00:00Z"), now), "starts in 3 h");
  assert.equal(f.untilNote(ev("2026-10-26", "2026-10-27"), now), "", "an all-day entry's date says enough");
  const coming = [ev("2026-10-24T15:00:00Z", "2026-10-24T16:00:00Z"), ev("2026-10-24T15:30:00Z", "2026-10-24T17:00:00Z"), ev("2026-10-24T16:00:00Z", "2026-10-24T16:30:00Z"), ev("2026-10-24", "2026-10-25")];
  assert.deepEqual(f.overlaps(coming), [[0, 1], [1, 2]], "touching is not overlapping; all-day is left out");
});

test("Pulse: the picture carries the facts, and conversations waiting on them", () => {
  assert.match(pulse, /\.eq\("type", "message"\)\.neq\("data->>sender", "me"\)/, "what others wrote, three days back");
  assert.match(pulse, /const waitingRows = facts\.waiting\(\[\.\.\.\(theirs \|\| \[\]\), \.\.\.inboundMail\], wrote\)\n\s*\.filter\(\(r\) => !watches\.ignored\(r\) && unclaimed\(r\) && !isNew\.has/);
  assert.match(pulse, /noted\(l, "overlaps " \+ overlapsOf\.get\(i\)/);
  assert.match(pulse, /coming\.map\(\(r\) => noted\(line\(r\), facts\.untilNote\(r\),/);
  assert.match(require("../lib/pulse-triage").notice.toString(), /WAITING ON THEM \(in each conversation, the latest message from someone else that they have not written in since\)/);
});

test("the writer: one call from the cited items, tools only when it asks", () => {
  const one = pulse.indexOf("let written = await writeOnce();"), loop = pulse.indexOf("while (iteration < MAX_PULSE_ITERATIONS)");
  assert.ok(one > 0 && one < loop, "the one call comes first");
  assert.match(pulse, /if \(written && typeof written === "object" && !written\.lookup\) \{[\s\S]{0,1200}await markChecked\(\);\n\s*return;\n\s*\}/, "and ends the check unless it asked for a lookup");
  assert.match(pulse, /if \(written\?\.lookup\) messages\[0\]\.content \+= `\\n\\nLook this up first: /);
  assert.match(pulse, /Write it again with exactly those parts removed or corrected to what the items say, and nothing else changed or added\./, "one more go, fixing only what was held");
  assert.match(pulse, /Every fact comes from the items\. Add no guesses or advice that rest on what they do not say/);
  assert.match(pulse, /One point: 2-4 sentences\. Several: one short, plain line each/);
  assert.match(pulse, /THE CITED EMAILS IN FULL/);
  assert.match(pulse, /const result = await sendChecked\(String\(\(block\.input && block\.input\.text\) \|\| ""\)\.trim\(\), lookedUp\);/, "both ways go through the same check");
  assert.match(pulse, /ctx\.store\.facts\._pulse_last = \{ value: /, "what it told them is kept in code");
  assert.match(pulse, /text = require\("\.\/plain-dashes"\)\.noEmDashes\(text\);/);
  assert.match(require("../lib/pulse-triage").notice.toString(), /say only what they show: no guesses about the person's circumstances/);
});
