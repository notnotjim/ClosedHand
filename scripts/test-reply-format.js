// Replies in the web chat show their formatting (bold, lists, headings, code)
// rather than raw asterisks and dashes, and nothing in a reply becomes markup.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const page = fs.readFileSync(path.join(__dirname, "..", "webapp", "views", "index.html"), "utf8");
const start = page.indexOf("  function formatReply(text) {");
const end = page.indexOf("\n  }\n", start) + 4;
const box = {};
vm.runInNewContext(page.slice(start, end) + "\nthis.formatReply = formatReply;", box);
const { formatReply } = box;

test("bold, lists and line breaks render", () => {
  const reply = "**Friday 9 October, 14:20** Lisbon time.\n\n- QZ417, LIS → OPO\n- Ref KQ7P2X, seat 12A\n\nThree days from now.";
  assert.equal(formatReply(reply),
    "<strong>Friday 9 October, 14:20</strong> Lisbon time.<br><ul class=\"reply-list\"><li>QZ417, LIS → OPO</li><li>Ref KQ7P2X, seat 12A</li></ul>Three days from now.",
    "a list's own margins space it, so the blank lines around it go");
  assert.equal(formatReply("1. First\n2. Second"), "<ol class=\"reply-list\"><li>First</li><li>Second</li></ol>");
  assert.equal(formatReply("### Today\nNothing urgent"), "<strong class=\"reply-head\">Today</strong><br>Nothing urgent");
  assert.equal(formatReply("Run `docker compose up`"), "Run <code>docker compose up</code>");
  assert.equal(formatReply("It's *probably* fine (*not* certain)."), "It's <em>probably</em> fine (<em>not</em> certain).");
  assert.equal(formatReply("2 * 3 * 4 = 24"), "2 * 3 * 4 = 24", "a lone asterisk is left alone");
});

test("a table shows as a table, not pipes", () => {
  const reply = "**Private rooms**\n\n| Hotel | Per night |\n|---|---:|\n| Random Alley | £9.14 |\n| **Bohemia** | £17.43 |\n\nMy pick: Bohemia.";
  assert.equal(formatReply(reply),
    "<strong>Private rooms</strong><br><div class=\"reply-table\"><table><thead><tr><th>Hotel</th><th>Per night</th></tr></thead>"
    + "<tbody><tr><td>Random Alley</td><td>£9.14</td></tr><tr><td><strong>Bohemia</strong></td><td>£17.43</td></tr></tbody></table></div>My pick: Bohemia.");
  assert.equal(formatReply("a | b | c"), "a | b | c", "pipes in a sentence are left alone");
  assert.equal(formatReply("| just one row |"), "| just one row |", "no rule line, no table");
  assert.doesNotMatch(formatReply("| <b>x</b> |\n|---|\n| y |"), /<b>/, "cells are escaped too");
});

test("nothing in a reply becomes markup of its own", () => {
  const out = formatReply("<img src=x onerror=alert(1)> **<b>hi</b>**\n- <script>x</script>");
  assert.doesNotMatch(out, /<img|<b>|<script/);
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(out, /<strong>&lt;b&gt;hi&lt;\/b&gt;<\/strong>/);
});

test("links go on their words; dashboard links open the dashboard panel", () => {
  const style = 'style="color:#D8624B;text-decoration:underline;text-underline-offset:3px"';
  assert.equal(formatReply("You can watch it run on your [dashboard](/dashboard#agents)."),
    `You can watch it run on your <a href="#" onclick="event.preventDefault();openDashSlide('#agents')" ${style}>dashboard</a>.`);
  assert.equal(formatReply("See [the **listing**](https://example.com/a?b=1&c=2)"),
    `See <a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener" ${style}>the <strong>listing</strong></a>`);
  assert.equal(formatReply("Open https://example.com/x or /dashboard#workers"),
    `Open <a href="https://example.com/x" target="_blank" rel="noopener" ${style}>https://example.com/x</a> or <a href="#" onclick="event.preventDefault();openDashSlide('#workers')" ${style}>Dashboard (Workers)</a>`);
  assert.match(formatReply("[chart](/canvas/abc)"), /<a href="\/canvas\/abc" target="_blank"/);
  assert.equal(formatReply("[x](javascript:alert(1))"), "[x](javascript:alert(1))", "only web and ClosedHand addresses become links");
});

test("an address cannot break out of its link", () => {
  for (const reply of ['https://a.example/"onmouseover="alert(1)', '[x](https://a.example/"onmouseover="alert(1))']) {
    const out = formatReply(reply);
    assert.doesNotMatch(out, /"onmouseover/, reply);
    assert.match(out, /&quot;onmouseover=&quot;/);
  }
});

test("the chat page formats bot replies through it", () => {
  assert.match(page, /div\.innerHTML = formatReply\(text\);/);
});

test("message times stay current instead of saying just now for ever", () => {
  assert.match(page, /when\.setAttribute\('data-ts', ts\)/);
  assert.match(page, /querySelectorAll\('\.msg-time\[data-ts\]'\)[\s\S]{0,200}msgTime\(el\.getAttribute\('data-ts'\)\)/);
});

test("the web chat prompt puts dashboard links on words and names memory as the dashboard does", () => {
  const engine = fs.readFileSync(path.join(__dirname, "..", "lib", "engine.js"), "utf8");
  assert.match(engine, /A link goes on its words, written \[words\]\(\/dashboard#section\)/);
  assert.doesNotMatch(engine, /Check it out here: \/dashboard|make them curious|want to explore it/, "no bare path, no pitch");
  assert.match(engine, /"pinned facts" and "Context Notes" \(past conversations, condensed\) in Context Brain, and "goals" and "preferences" \(what save_rule stores\) in Settings, under Goals & Preferences\./);
  const dashboard = fs.readFileSync(path.join(__dirname, "..", "webapp", "views", "dashboard.html"), "utf8");
  for (const name of ["Pinned facts", "Context Notes", "Goals &amp; Preferences"]) assert.ok(dashboard.includes(name), `the dashboard still says ${name}`);
});

test("a reopened conversation shows what was said, not ClosedHand's bookkeeping", () => {
  const start = page.indexOf("  function shownInThread(messages) {");
  const box = {};
  vm.runInNewContext(page.slice(start, page.indexOf("\n  }\n", start) + 4) + "\nthis.f = shownInThread;", box);
  const shown = box.f([
    { role: "assistant", content: "Just to confirm: send email?" },
    { role: "user", content: "[User moved on, action cancelled]" },
    { role: "assistant", content: "OK, cancelled." },
    { role: "user", content: "no, just pin the address here" },
    { role: "assistant", content: [{ type: "tool_use" }] },
    { role: "assistant", content: "Harbour House, 14 Quay Street" },
    { role: "user", content: "[The question lapsed unanswered, action cancelled]" },
    { role: "assistant", content: "OK, cancelled." },
  ]);
  assert.deepEqual([...shown].map((m) => m.content), ["Just to confirm: send email?", "no, just pin the address here", "Harbour House, 14 Quay Street"]);
  assert.equal((page.match(/shownInThread\(thread\.messages\)\.forEach/g) || []).length, 2, "both ways of opening a conversation");
  assert.doesNotMatch(page, /thread\.messages\.forEach/, "nothing draws a thread unfiltered");
});

test("coming back to the tab shows what arrived while away", () => {
  const start = page.indexOf("  function missedSince(history, lastShown) {");
  const box = {};
  vm.runInNewContext(page.slice(start, page.indexOf("\n  }\n", start) + 4) + "\nthis.f = missedSince;", box);
  const history = [
    { direction: "inbound", content: "find me a hotel" },
    { direction: "outbound", content: "On it, back in about ten minutes." },
    { direction: "outbound", content: "Three good ones: …" },
    { direction: "outbound", content: "Reminder: iCloud storage" },
  ];
  assert.deepEqual([...box.f(history, "On it, back in about ten minutes.")].map((m) => m.content), ["Three good ones: …", "Reminder: iCloud storage"]);
  assert.deepEqual([...box.f(history, "Reminder: iCloud storage")], [], "nothing new");
  assert.deepEqual([...box.f(history, "")], [], "an empty page has nothing to anchor on");
  assert.match(page, /div\._raw = raw;/, "each message keeps the text as sent");
  assert.match(page, /missedSince\(data\.messages \|\| \[\], last\)/);
});

test("the conversation uses the app's scale, set once, larger on touch screens", () => {
  const root = page.slice(page.indexOf("  :root {"), page.indexOf("  * { margin: 0; padding: 0; box-sizing: border-box; }"));
  for (const token of ["--chat-text: 16px;", "--chat-input-min: 48px;"]) assert.ok(root.includes(token), `touch default ${token}`);
  assert.match(root, /@media \(hover: hover\) and \(pointer: fine\) \{\n\s*:root \{\n\s*--chat-text: 15px;\n\s*--chat-text-sm: 13px;\n\s*--chat-meta: 11px;/, "computers get the dashboard's scale");
  assert.doesNotMatch(page, /font-size: 17px !important/, "no hero-sized messages");
  assert.doesNotMatch(page, /div\.style\.fontSize = '16px'/, "no inline sizes overriding the scale");
  assert.match(page, /\.message \{\n\s*max-width: 85%;\n\s*padding: var\(--chat-pad\);\n\s*border-radius: 18px;\n\s*font-size: var\(--chat-text\);/);
  assert.match(page, /\.docked-input \.input-textarea-wrap textarea \{\n\s*font-size: var\(--chat-text\);/);
  assert.match(page, /\.docked-input \.input-box-wrap:focus-within \{ transform: none; \}/, "the chat input does not zoom on focus");
  assert.match(page, /\.docked-input \.toolbar-btn \{ width: var\(--chat-control\); height: var\(--chat-control\);/);
  assert.match(page, /docked-input textarea \{[^}]*font-size: 16px !important/, "phones keep 16px in the input so the page does not zoom");
});

test("only a tab waiting for its own reply can call it stalled", () => {
  assert.match(page, /else if \(_awaitingReply\) armResponseWatchdog\(\);/);
  assert.match(page, /_awaitingReply = false; disarmResponseWatchdog\(\);/);
  assert.match(page, /_awaitingReply = true;\n\s*armResponseWatchdog\(\);/);
});

test("a line of dashes in a reply is a divider", () => {
  assert.equal(formatReply("Above\n---\nBelow"), 'Above<hr class="reply-rule">Below');
});
