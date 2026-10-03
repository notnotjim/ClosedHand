// The progress lines the chat shows while ClosedHand works are plain words:
// never an internal tool name, a raw path or "undefined".
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { INTERNAL_TOOLS } = require("../lib/tools/definitions");
const { StatusFeed, isHidden, GENERIC } = require("../lib/status-feed");

const CODE_LIKE = /[_{}\[\]<>]|\bundefined\b|\bnull\b|\bNaN\b/;
const INPUTS = [{}, { query: "dinner", path: "/Users/sam/Documents/menu.txt", dataset: "Expenses", name: "Expenses", rows: [{}], to: "sam@example.com", subject: "Dinner", event_id: "ev1", file_id: "1AbC", url: "https://example.com/page" }];

function lines(toolName, input) {
  const seen = [];
  const feed = new StatusFeed({ update: (events, latest) => seen.push(latest), clear() {} });
  feed.emit({ type: "tool_start", toolName, input, timestamp: 1 });
  feed.emit({ type: "tool_end", toolName, input, success: true, timestamp: 2 });
  return seen.map((e) => e.description);
}

test("every tool's progress line is plain words, or hidden bookkeeping", () => {
  const bad = [];
  for (const tool of INTERNAL_TOOLS) {
    for (const input of INPUTS) {
      const shown = lines(tool.name, input);
      if (isHidden(tool.name)) { if (shown.length) bad.push(`${tool.name} is hidden but showed ${shown}`); continue; }
      for (const text of shown) {
        if (!text || text === GENERIC) bad.push(`${tool.name} has no description of its own`);
        else if (CODE_LIKE.test(text) || text.includes(tool.name)) bad.push(`${tool.name}: "${text}"`);
      }
    }
  }
  assert.deepEqual([...new Set(bad)], []);
});

test("a tool nothing knows about never shows its internal name", () => {
  for (const text of lines("some_unknown_tool", {})) assert.equal(text, GENERIC);
});

test("the chat page never falls back to an internal name", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "webapp", "views", "index.html"), "utf8");
  const start = html.indexOf("function renderActivityFeed");
  const body = html.slice(start, html.indexOf("\n  }\n", start));
  assert.doesNotMatch(body, /\|\|\s*(item\.end|running\[r\])\.toolName/);
});

test("recall, before the model reads the message, says what it is doing", () => {
  const seen = [];
  const feed = new StatusFeed({ update: (events, latest) => seen.push(latest), clear() {} });
  feed.emit({ type: "recall" });
  assert.equal(seen[0].description, "Looking for anything relevant");
  const engine = fs.readFileSync(path.join(__dirname, "..", "lib", "engine.js"), "utf8");
  assert.ok(engine.indexOf('opts.onStatusEvent({ type: "recall" })') < engine.indexOf("contextInjection = await fetchRelevantContext("), "signalled before recall runs");
  const page = fs.readFileSync(path.join(__dirname, "..", "webapp", "views", "index.html"), "utf8");
  assert.match(page, /lastEvent\.type === 'recall' \? \(lastEvent\.description \|\| 'Looking for anything relevant'\)/);
  // A chat app shows no step for it, as for thinking.
  const status = fs.readFileSync(path.join(__dirname, "..", "lib", "status-feed.js"), "utf8");
  assert.match(status, /if \(\(latest\.type === "thinking" \|\| latest\.type === "recall"\) && events\.every/);
});

test("the web chat greets people by the name they asked for", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "webapp", "server.js"), "utf8");
  assert.match(server, /name: profile\?\.settings\?\.preferred_name \|\| profile\?\.display_name \|\| null,/, "chat status");
  assert.match(server, /name: profile\?\.settings\?\.preferred_name \|\| profile\?\.display_name \|\| "User",/, "dashboard status");
});
