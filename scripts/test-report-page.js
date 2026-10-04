// A finished run's report is a page of its own, with the same report as a
// Word document and its tables as a spreadsheet. Needs adm-zip, xlsx and
// mammoth on NODE_PATH (the checks workflow installs them for this test).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const page = require("../webapp/report-page");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

const run = {
  id: "a1b2c3",
  completed_at: "2026-10-04T05:00:00Z",
  result: [
    "**Three good ones** for 7 to 14 October.",
    "[[next]]",
    "## Private rooms",
    "| Hotel | Per night |",
    "|---|---:|",
    "| Cubicity De Tham | £14.00 |",
    "| <script>alert(1)</script> | £15.71 |",
    "",
    "- Free cancellation on all three",
    "- See [the listing](https://example.com/cubicity)",
  ].join("\n"),
};

test("the report reads as headings, paragraphs, lists and tables", () => {
  const kinds = page.blocks(run.result).map((b) => b.type);
  assert.deepEqual(kinds, ["para", "heading", "table", "list"], "the follow-on break is just a paragraph break");
  assert.equal(page.hasTables(run.result), true);
  assert.equal(page.hasTables("Just text."), false);
});

test("the page shows the report safely, with its files", () => {
  const html = page.pageHtml(run, "Saigon hotels");
  assert.match(html, /<title>Saigon hotels<\/title>/);
  assert.match(html, /<h3>Private rooms<\/h3>/);
  assert.match(html, /<th>Hotel<\/th><th>Per night<\/th>/);
  assert.match(html, /<a href="https:\/\/example\.com\/cubicity" target="_blank" rel="noopener">the listing<\/a>/);
  assert.doesNotMatch(html, /<script>alert/, "nothing in a report becomes markup");
  assert.doesNotMatch(html, /\[\[next\]\]/);
  for (const kind of ["pdf", "docx", "xlsx"]) assert.match(html, new RegExp(`href="/api/agents/a1b2c3/${kind}"`));
  assert.doesNotMatch(page.pageHtml({ ...run, result: "No tables here." }, "Plain"), /xlsx/, "a spreadsheet only when there are tables");
  assert.match(html, /@media \(prefers-color-scheme: dark\)/);
});

test("the Word document opens and says what the page says", async () => {
  const mammoth = require("mammoth");
  const buf = page.docxBuffer(run, "Saigon hotels");
  const { value } = await mammoth.extractRawText({ buffer: buf });
  assert.match(value, /Saigon hotels/);
  assert.match(value, /Three good ones for 7 to 14 October/);
  assert.match(value, /Cubicity De Tham/);
  assert.match(value, /the listing \(https:\/\/example\.com\/cubicity\)/);
  assert.doesNotMatch(value, /\[\[next\]\]|\*\*/);
});

test("the spreadsheet holds each table on a sheet named after its heading", () => {
  const XLSX = require("xlsx");
  const book = XLSX.read(page.xlsxBuffer(run), { type: "buffer" });
  assert.deepEqual(book.SheetNames, ["Private rooms"]);
  const rows = XLSX.utils.sheet_to_json(book.Sheets["Private rooms"], { header: 1 });
  assert.deepEqual(rows[0], ["Hotel", "Per night"]);
  assert.equal(rows[1][0], "Cubicity De Tham");
});

test("the page sits behind the login gate, and chats link to it", () => {
  const server = read("webapp/server.js");
  assert.ok(server.indexOf('app.get("/report/:id"') > server.indexOf("// --- The gate: everything registered below needs the session"), "registered after the gate");
  assert.match(server, /for \(const kind of \["docx", "xlsx"\]\)/);
  assert.match(read("lib/task-delivery.js"), /links\.reportLinkNotice\(platform, reportId\)/);
  assert.match(read("lib/dashboard-links.js"), /const path = `\/report\/\$\{encodeURIComponent\(id\)\}`;/);
  assert.match(read("webapp/views/index.html"), /\\\/\(\?:dashboard\|canvas\|report\)/, "the web chat links it");
});
