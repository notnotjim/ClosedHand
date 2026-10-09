// The progress lines the chat shows while Closedhand works are plain words:
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
  assert.ok(engine.indexOf('opts.onStatusEvent({ type: "recall" })') < engine.indexOf("const recalled = fetchRelevantContext("), "signalled before recall runs");
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

test("a progress line quotes words a person would say, never search syntax, identifiers or raw dates", () => {
  const d = (n, i) => INTERNAL_TOOLS.find((t) => t.name === n).activityDescription(i);
  assert.equal(d("search_cache", { query: "booking OR confirmation OR reservation OR flight OR hotel", type: "email" }), 'Searching emails for "booking confirmation reservation flight hotel"');
  assert.equal(d("search_cache", { query: "*" }), "Searching your data");
  assert.equal(d("search_cache", { query: "from:sam@example.com newer_than:7d" }), "Searching your data");
  assert.equal(d("search_calendar", { start: "2026-10-04T00:00:00+07:00", end: "2026-10-14T00:00:00+07:00" }), "Checking your calendar, 4 Oct to 14 Oct");
  assert.equal(d("web_search", { query: '"coworking" da nang' }), 'Searching the web for "coworking da nang"');
  assert.equal(d("pin_fact", { key: "profile-name-certainty" }), "Pinning a fact");
  assert.equal(d("web_search", { query: "icloud-storage-reminder" }), 'Searching the web for "icloud storage reminder"', "a name made for code reads as words");
  assert.equal(d("web_search", { query: "sam@my-mail.com" }), 'Searching the web for "sam@my-mail.com"', "an address keeps its dashes");
  // A service nobody would know by its address is named by what it does.
  assert.equal(d("api_request", { method: "GET", url: "https://nominatim.openstreetmap.org/search?q=x" }), "Looking at the map");
  assert.equal(d("api_request", { method: "POST", url: "https://shop.example.co.uk/x", service: "shopify" }), "Sending to Shopify");
  assert.equal(d("api_request", { method: "DELETE", url: "https://api.example.co.uk/items/1" }), "Removing something from example.co.uk");
  assert.equal(d("maps_geocode", { address: "Random Alley 148 Saigon" }), "Finding Random Alley 148 Saigon on the map");
  for (const t of INTERNAL_TOOLS.filter((x) => typeof x.activityDescription === "function")) {
    const line = t.activityDescription({ file_id: "1AbCdEfGhIjKlMnOp", key: "some-key_slug", query: "a OR b" }) || "";
    assert.doesNotMatch(line, /1AbCdEf|some-key_slug|\bOR\b/, `${t.name}: ${line}`);
  }
});

test("a send's progress line fits both a send and a send that waits for a yes", () => {
  const d = (n, i) => INTERNAL_TOOLS.find((t) => t.name === n).activityDescription(i);
  assert.equal(d("gmail_send", { to: "sam@example.com" }), "Writing an email to sam@example.com");
});
