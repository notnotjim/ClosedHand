// What ClosedHand is told about replying, and the names it uses, as
// behaviour that can be checked rather than wording that can drift.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const { responsePresentation } = require("../lib/response-presentation");

test("it never points at something the person cannot see", () => {
  for (const p of ["web", "whatsapp", "telegram"]) {
    assert.match(responsePresentation(p), /Refer only to what the person can see in this chat/);
  }
});

test("the sandbox is called what the Computers tab calls it", () => {
  const files = ["lib/engine.js", "lib/agents.js", "lib/messaging.js", "lib/status-feed.js", "lib/tools/definitions.js", "lib/tools/handlers.js", "lib/automations.js", "webapp/server.js", "webapp/rag-processor.js"];
  for (const f of files) assert.doesNotMatch(read(f), /cloud (computer|browser)/i, f);
  assert.match(read("webapp/views/index.html"), /ClosedHand's sandbox computer/, "the name it follows");
  assert.match(read("lib/engine.js"), /call it your sandbox computer/);
});

test("a saved location is the city, written in English", () => {
  const defs = read("lib/tools/definitions.js");
  assert.match(defs, /Save the most specific place you know, the town or city/);
  assert.match(defs, /never the local spelling/);
});

test("comparisons are checked against their own figures, in chat and by the quality check", () => {
  const { responsePresentation } = require("../lib/response-presentation");
  assert.match(responsePresentation("web"), /the one you call closest, cheapest or best must be that in the list you give/);
  assert.match(read("lib/verification.js"), /every ranking or superlative \(closest, cheapest, best, first\) must agree with the figures the answer gives/);
});

test("what it already knows comes first; only what can be out of date is looked up", () => {
  const engine = read("lib/engine.js");
  assert.match(engine, /Holdings include what you already know \(general knowledge: geography, how things work, well-known facts\)/);
  assert.match(engine, /Look things up only for what can be out of date or must be exact: prices, availability, opening hours/);
});

test("new mail is indexed newest first", () => {
  const usi = read("lib/services/usi.js");
  const start = usi.indexOf("function newestFirst");
  const vm = require("node:vm");
  const box = { Date, Number };
  vm.runInNewContext(usi.slice(start, usi.indexOf("\n}\n", start) + 2) + "\nthis.f = newestFirst;", box);
  const rows = [{ data: { date: "Mon, 28 Sep 2026 10:00:00 +0000" } }, { data: { date: "Sat, 3 Oct 2026 09:00:00 +0000" } }, { data: {} }];
  assert.equal(JSON.stringify(box.f(rows).map((r) => r.data.date || "none")), JSON.stringify(["Sat, 3 Oct 2026 09:00:00 +0000", "Mon, 28 Sep 2026 10:00:00 +0000", "none"]));
  assert.match(usi, /const items = \(type === "email" \? newestFirst\(rows \|\| \[\]\) : \(rows \|\| \[\]\)\)/);
});

test("prices come in the local currency and the person's own", () => {
  const { responsePresentation } = require("../lib/response-presentation");
  assert.match(responsePresentation("web"), /in the local currency and in the person's own/);
});

test("the sandbox computer is for answers words cannot give, not a default", () => {
  const engine = read("lib/engine.js");
  assert.doesNotMatch(engine, /SHOW, DON'T TELL|do not wait to be asked\):\n- Numbers/);
  assert.match(engine, /USE IT WHEN IT MAKES THE ANSWER BETTER THAN WORDS CAN \(and only then: every run costs the person time\)/);
  assert.match(engine, /Not for what a sentence already answers: which of a few nearby places is closer, a couple of options near somewhere, one simple sum\./);
});
