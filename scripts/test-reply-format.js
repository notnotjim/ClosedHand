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

test("nothing in a reply becomes markup of its own", () => {
  const out = formatReply("<img src=x onerror=alert(1)> **<b>hi</b>**\n- <script>x</script>");
  assert.doesNotMatch(out, /<img|<b>|<script/);
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(out, /<strong>&lt;b&gt;hi&lt;\/b&gt;<\/strong>/);
});

test("the chat page formats bot replies through it", () => {
  assert.match(page, /var html = formatReply\(text\)\n\s*\.replace\(\/\\\/dashboard/);
});
