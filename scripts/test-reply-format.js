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
  const reply = "**Wednesday 7 October, 11:55** Vietnam time.\n\n- VN123, DAD → SGN\n- Ref FLCZQ4, seat 17E\n\nThree days from now.";
  assert.equal(formatReply(reply),
    "<strong>Wednesday 7 October, 11:55</strong> Vietnam time.<br><ul class=\"reply-list\"><li>VN123, DAD → SGN</li><li>Ref FLCZQ4, seat 17E</li></ul>Three days from now.",
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
