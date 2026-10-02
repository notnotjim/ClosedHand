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
