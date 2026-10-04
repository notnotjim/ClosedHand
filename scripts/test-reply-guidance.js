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
