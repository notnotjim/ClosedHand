// A report is its own record, made only when ClosedHand judged one helps
// beyond the chat answer (save_report). It is a page of its own, with the same
// report as a PDF, a Word document and its tables as a spreadsheet, and it can
// be deleted from the page. Needs adm-zip, xlsx and mammoth on NODE_PATH (the
// checks workflow installs them for this test).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const page = require("../webapp/report-page");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

const report = {
  id: "a1b2c3",
  title: "Saigon hotels, 7 to 14 October",
  created_at: "2026-10-04T05:00:00Z",
  updated_at: "2026-10-04T05:00:00Z",
  content: [
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
  assert.deepEqual(page.blocks(report.content).map((b) => b.type), ["para", "heading", "table", "list"], "the follow-on break is just a paragraph break");
  assert.equal(page.hasTables(report.content), true);
  assert.equal(page.hasTables("Just text."), false);
});

test("the page shows the report safely, with downloads that say so and a delete that asks", () => {
  const html = page.pageHtml(report);
  assert.match(html, /<title>Saigon hotels, 7 to 14 October<\/title>/);
  assert.match(html, /<h3>Private rooms<\/h3>/);
  assert.match(html, /<a href="https:\/\/example\.com\/cubicity" target="_blank" rel="noopener">the listing<\/a>/);
  assert.doesNotMatch(html, /<script>alert/, "nothing in a report becomes markup");
  assert.doesNotMatch(html, /\[\[next\]\]/);
  for (const [kind, label] of [["pdf", "PDF"], ["docx", "Word"], ["xlsx", "Excel"]]) {
    assert.match(html, new RegExp(`href="/api/reports/a1b2c3/${kind}" download aria-label="Download as ${label}" title="Download as ${label}"><svg[^>]*aria-hidden="true"`));
  }
  assert.doesNotMatch(page.pageHtml({ ...report, content: "No tables here." }), /xlsx/, "a spreadsheet only when there are tables");
  assert.match(html, /<details class="end"><summary>Delete report<\/summary><form method="post" action="\/api\/reports\/a1b2c3\/delete">/);
  assert.match(html, /Delete this report for good\? The answer in your chat stays where it is\./);
  assert.match(page.deletedHtml(report), /is gone, with its PDF, Word and Excel versions\. The answer in your chat is still there\./);
});

test("the Word document opens and says what the page says", async () => {
  const mammoth = require("mammoth");
  const { value } = await mammoth.extractRawText({ buffer: page.docxBuffer(report) });
  assert.match(value, /Saigon hotels, 7 to 14 October/);
  assert.match(value, /Three good ones for 7 to 14 October/);
  assert.match(value, /Cubicity De Tham/);
  assert.match(value, /the listing \(https:\/\/example\.com\/cubicity\)/);
  assert.doesNotMatch(value, /\[\[next\]\]|\*\*/);
});

test("the spreadsheet holds each table on a sheet named after its heading", () => {
  const XLSX = require("xlsx");
  const book = XLSX.read(page.xlsxBuffer(report), { type: "buffer" });
  assert.deepEqual(book.SheetNames, ["Private rooms"]);
  const rows = XLSX.utils.sheet_to_json(book.Sheets["Private rooms"], { header: 1 });
  assert.deepEqual(rows[0], ["Hotel", "Per night"]);
  assert.equal(rows[1][0], "Cubicity De Tham");
});

test("a report is made by judgement, only when it helps beyond the chat answer", () => {
  const defs = read("lib/tools/definitions.js");
  const tool = defs.slice(defs.indexOf('name: "save_report"'), defs.indexOf('name: "agent_report_read"'));
  assert.match(tool, /core: true,/, "available in chat without a lookup");
  assert.match(tool, /Make one ONLY when it helps them beyond the chat answer: they asked for a document, report, PDF or spreadsheet; or the result is something to keep, share or come back to/);
  assert.match(tool, /An ordinary answer, however useful, is never a report/);
  assert.match(tool, /The chat answer must still be complete on its own/);
  assert.match(read("lib/task-tools.js"), /"save_report"\]\);/, "background runs start with it");
  const { responsePresentation } = require("../lib/response-presentation");
  assert.match(responsePresentation("web"), /if it does, write it with save_report as the fuller version/);
  const delivery = read("lib/task-delivery.js");
  assert.doesNotMatch(delivery, /isReportWorthy|report\|write-\?up\|document/, "no length or keyword test decides it");
  assert.match(delivery, /from\("reports"\)\.select\("id"\)\.eq\("task_id", row\.id\)/, "delivery links the report the run made, if it made one");
  assert.match(delivery, /String\(text\)\.includes\(`\/report\/\$\{reportId\}`\)/, "never linked twice");
});

test("save_report records the reason and the run, and answers with the link", () => {
  const handlers = read("lib/tools/handlers.js");
  const body = handlers.slice(handlers.indexOf('case "save_report": {'), handlers.indexOf('case "agent_report_read":'));
  assert.match(body, /if \(!title \|\| !content \|\| !reason\) return \{ error:/);
  assert.match(body, /task_id: run\?\.kind === "agent" \? run\.taskId : null/);
  assert.match(body, /The link is added to your answer when it is delivered, so do not add it yourself/, "a background run leaves the link to delivery");
  assert.match(read("migrations/051_reports.sql"), /task_id uuid REFERENCES agent_tasks\(id\) ON DELETE CASCADE,\n\s*title text NOT NULL,\n\s*content text NOT NULL,\n\s*reason text NOT NULL,/);
});

test("the page and its files sit behind the login gate and are the report's own", () => {
  const server = read("webapp/server.js");
  const gate = server.indexOf("// --- The gate: everything registered below needs the session");
  for (const route of ['app.get("/report/:id"', 'app.post("/api/reports/:id/delete"', "app.get(`/api/reports/:id/${kind}`"]) {
    assert.ok(server.indexOf(route) > gate, `${route} registered after the gate`);
  }
  assert.match(server, /\.from\("reports"\)\n\s*\.select\("id, user_id, task_id, title, content, reason, created_at, updated_at"\)/);
  assert.doesNotMatch(server, /\/api\/agents\/:id\/\$\{kind\}/, "runs have no report files of their own");
  assert.match(read("lib/dashboard-links.js"), /const path = `\/report\/\$\{encodeURIComponent\(id\)\}`;/);
  assert.match(read("webapp/views/index.html"), /\\\/\(\?:dashboard\|canvas\|report\)/, "the web chat links it");
});

test("the dashboard offers a report only for a run that made one, and deleting says what goes", () => {
  const server = read("webapp/server.js");
  assert.match(server, /report_id: reportOf\.get\(task\.id\) \|\| null,/);
  const dashboard = read("webapp/views/dashboard.html");
  assert.match(dashboard, /var pdfHtml = \(!running && a\.report_id\)/);
  assert.match(dashboard, /window\.open\(\\'\/report\/' \+ a\.report_id/);
  assert.match(dashboard, /hasReport \? 'Delete this run and its report for good\?' : 'Delete this run for good\?'/);
  assert.doesNotMatch(dashboard, /title="Remove from list"/);
  assert.equal((server.match(/app\.delete\("\/api\/agents\/:id"/g) || []).length, 1, "one delete route");
});

test("older titles cut mid-word read as untitled and are cut at a word", () => {
  const src = read("webapp/run-pdf.js");
  const start = src.indexOf("function runTitle");
  const box = {};
  vm.runInNewContext(src.slice(start, src.indexOf("\n}\n", start) + 2) + "\nthis.f = runTitle;", box);
  assert.equal(box.f({ title: "Can you find me a couple of good coworking spaces in District 1 with d", goal: "Can you find me a couple of good coworking spaces in District 1 with day passes, for next week?" }),
    "Can you find me a couple of good coworking spaces in District 1 with day passes, for next…");
  assert.equal(box.f({ title: "Saigon hotels, 7 to 14 October", goal: "whatever" }), "Saigon hotels, 7 to 14 October", "a real name is kept");
});
