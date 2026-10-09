// A lookup that hangs never hangs the reply: read-only tools have a ceiling,
// after which the model hears it took too long. A live Gmail search reads the
// newest 40 matches, never hundreds of full bodies, and says when there were more.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

function ceiling(ms) {
  const engine = read("lib/engine.js");
  const start = engine.indexOf("const READ_TOOL_CEILING_MS");
  const end = engine.indexOf("\n}\n", engine.indexOf("function withReadCeiling")) + 2;
  const box = { READ_ONLY_TOOLS: new Set(["search_cache"]), setTimeout, clearTimeout, console: { log() {} }, Promise };
  vm.runInNewContext(engine.slice(start, end).replace(/= 45000;/, `= ${ms};`) + "\nthis.f = withReadCeiling;", box);
  return box.f;
}

test("a read-only lookup that hangs is set aside, and the reply carries on", async () => {
  const withReadCeiling = ceiling(30);
  const hung = await withReadCeiling("search_cache", new Promise(() => {}));
  assert.match(hung.error, /took longer than .* seconds/);
  assert.deepEqual(await withReadCeiling("search_cache", Promise.resolve({ results: [1] })), { results: [1] }, "a quick one is untouched");
  const action = new Promise(() => {});
  assert.equal(withReadCeiling("gmail_send", action), action, "an action is never cut short");
});

test("both ways tools run go through the ceiling", () => {
  const engine = read("lib/engine.js");
  assert.match(engine, /prefetched\.set\(b\.id, withReadCeiling\(b\.name, handleInternalTool\(b\.name, input\)/);
  assert.match(engine, /: withReadCeiling\(block\.name, handleInternalTool\(block\.name, input\)\)\);/);
});

test("a live Gmail search reads the newest 40, a few at a time, and says when there were more", () => {
  const src = read("lib/services/data-access.js");
  assert.match(src, /const LIVE_LIMIT = 40;/);
  assert.match(src, /q: fullQuery, maxResults: LIVE_LIMIT \}/, "the gws path asks for 40");
  assert.match(src, /messages\?q=\$\{encoded\}&maxResults=\$\{LIVE_LIMIT\}/, "the HTTP path asks for 40");
  assert.equal((src.match(/pLimit\(LIVE_FETCHES_AT_ONCE\)/g) || []).length, 2);
  assert.doesNotMatch(src, /slice\(0, 500\)|maxResults=100|"maxResults":500/);
  assert.match(src, /metadata\.only_newest = metadata\.only_newest \|\| \[\]/, "the model is told");
});
