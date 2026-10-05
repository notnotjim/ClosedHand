// A page is its own record, made only when ClosedHand judged one helps beyond
// the chat answer (save_report; the code still says report). It opens on its
// own, with the same content as a PDF, a Word document and its tables as a
// spreadsheet, it is listed under Pages on the dashboard whoever made it, and
// it can be deleted from the page or the list. Needs adm-zip, xlsx and mammoth on NODE_PATH (the
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
  title: "Lisbon hotels, 7 to 14 October",
  created_at: "2026-10-04T05:00:00Z",
  updated_at: "2026-10-04T05:00:00Z",
  content: [
    "**Three good ones** for 7 to 14 October.",
    "[[next]]",
    "## Private rooms",
    "| Hotel | Per night |",
    "|---|---:|",
    "| Harbour House | £14.00 |",
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
  assert.match(html, /<title>Lisbon hotels, 7 to 14 October<\/title>/);
  assert.match(html, /<h3>Private rooms<\/h3>/);
  assert.match(html, /<a href="https:\/\/example\.com\/cubicity" target="_blank" rel="noopener">the listing<\/a>/);
  assert.doesNotMatch(html, /<script>alert/, "nothing in a report becomes markup");
  assert.doesNotMatch(html, /\[\[next\]\]/);
  for (const [kind, label] of [["pdf", "PDF"], ["docx", "Word"], ["xlsx", "Excel"]]) {
    assert.match(html, new RegExp(`href="/api/pages/a1b2c3/${kind}" download aria-label="Download as ${label}" title="Download as ${label}"><svg[^>]*aria-hidden="true"`));
  }
  assert.doesNotMatch(page.pageHtml({ ...report, content: "No tables here." }), /xlsx/, "a spreadsheet only when there are tables");
  assert.match(html, /<details class="end"><summary>Delete page<\/summary><form method="post" action="\/api\/pages\/a1b2c3\/delete">/);
  assert.match(html, /Delete this page for good\? The answer in your chat stays where it is\./);
  assert.match(page.deletedHtml(report), /is gone, with its PDF, Word and Excel versions\. The answer in your chat is still there\./);
});

test("the Word document opens and says what the page says", async () => {
  const mammoth = require("mammoth");
  const { value } = await mammoth.extractRawText({ buffer: page.docxBuffer(report) });
  assert.match(value, /Lisbon hotels, 7 to 14 October/);
  assert.match(value, /Three good ones for 7 to 14 October/);
  assert.match(value, /Harbour House/);
  assert.match(value, /the listing \(https:\/\/example\.com\/cubicity\)/);
  assert.doesNotMatch(value, /\[\[next\]\]|\*\*/);
});

test("the spreadsheet holds each table on a sheet named after its heading", () => {
  const XLSX = require("xlsx");
  const book = XLSX.read(page.xlsxBuffer(report), { type: "buffer" });
  assert.deepEqual(book.SheetNames, ["Private rooms"]);
  const rows = XLSX.utils.sheet_to_json(book.Sheets["Private rooms"], { header: 1 });
  assert.deepEqual(rows[0], ["Hotel", "Per night"]);
  assert.equal(rows[1][0], "Harbour House");
});

test("a report is made by judgement, only when it helps beyond the chat answer", () => {
  const defs = read("lib/tools/definitions.js");
  const tool = defs.slice(defs.indexOf('name: "save_report"'), defs.indexOf('name: "agent_report_read"'));
  assert.match(tool, /core: true,/, "available in chat without a lookup");
  assert.match(tool, /Make one ONLY when it serves them better than a chat reply can: they asked for a document, report, PDF or spreadsheet; or the result is something to keep, share or come back to/);
  assert.match(tool, /An ordinary answer, however useful, is never a page/);
  assert.match(tool, /When you mention it, call it a page, never a report or a document\./);
  assert.match(tool, /The chat answer must still be complete on its own/);
  assert.match(read("lib/task-tools.js"), /"save_report"\]\);/, "background runs start with it");
  const { responsePresentation } = require("../lib/response-presentation");
  assert.match(responsePresentation("web"), /if it helps, write it with save_report for what it is/);
  const delivery = read("lib/task-delivery.js");
  assert.doesNotMatch(delivery, /isReportWorthy|report\|write-\?up\|document/, "no length or keyword test decides it");
  assert.match(delivery, /from\("reports"\)\.select\("id"\)\.eq\(table === "automation_runs" \? "automation_run_id" : "task_id", row\.id\)/, "delivery links the page the run made, if it made one");
  assert.match(delivery, /new RegExp\(`\/\(\?:page\|report\)\/\$\{reportId\}`\)\.test\(String\(text\)\)/, "never linked twice");
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
  for (const route of ['app.get("/page/:id"', 'app.post("/api/pages/:id/delete"', "app.get(`/api/pages/:id/${kind}`", 'app.get("/api/pages"', 'app.delete("/api/pages/:id"']) {
    assert.ok(server.indexOf(route) > gate, `${route} registered after the gate`);
  }
  assert.match(server, /\.from\("reports"\)\n\s*\.select\("id, user_id, task_id, title, content, reason, created_at, updated_at"\)/);
  assert.doesNotMatch(server, /\/api\/agents\/:id\/\$\{kind\}/, "runs have no report files of their own");
  assert.match(server, /app\.get\("\/report\/:id", \(req, res\) => res\.redirect\(301, `\/page\/\$\{encodeURIComponent\(req\.params\.id\)\}`\)\);/, "links sent before pages had their name still open");
  assert.match(read("lib/dashboard-links.js"), /const path = `\/page\/\$\{encodeURIComponent\(id\)\}`;/);
  assert.match(read("webapp/views/index.html"), /\\\/\(\?:dashboard\|canvas\|page\|report\)/, "the web chat links it");
});

test("the dashboard offers a report only for a run that made one, and deleting says what goes", () => {
  const server = read("webapp/server.js");
  assert.match(server, /report_id: reportOf\.get\(task\.id\) \|\| null,/);
  const dashboard = read("webapp/views/dashboard.html");
  assert.match(dashboard, /var pdfHtml = \(!running && a\.report_id\)/);
  assert.match(dashboard, /window\.open\(\\'\/page\/' \+ a\.report_id/);
  assert.match(dashboard, /hasReport \? 'Delete this run for good\? Its page stays under Pages\.' : 'Delete this run for good\?'/);
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
  assert.equal(box.f({ title: "Lisbon hotels, 7 to 14 October", goal: "whatever" }), "Lisbon hotels, 7 to 14 October", "a real name is kept");
});

test("dividers render, the title is not repeated, empty headers and unedited reports stay quiet", () => {
  const doc = { ...report, title: "Lisbon move, Friday 9 October", content: "# Lisbon move — Friday 9 October 2026\nEverything in one place.\n\n---\n\n| | |\n|---|---|\n| Flight | QZ417 |", created_at: new Date("2026-10-04T05:00:00.000Z"), updated_at: new Date("2026-10-04T05:00:00.004Z") };
  const html = page.pageHtml(doc);
  assert.equal((html.match(/Lisbon move/g) || []).length, 2, "the title tag and the page heading only, not the document's own repeat");
  assert.match(html, /<hr>/);
  assert.doesNotMatch(html, /<p>---<\/p>/);
  assert.doesNotMatch(html, /<thead>/, "a blank header row is left out");
  assert.doesNotMatch(html, /edited/, "created and saved a moment apart is not an edit");
  assert.match(page.pageHtml({ ...doc, updated_at: new Date("2026-10-05T09:00:00Z") }), /, edited 5 October 2026/);
});

test("every page is under Pages, a week on the list then Archived, whichever chat or agent made it", () => {
  const server = read("webapp/server.js");
  const list = server.slice(server.indexOf('app.get("/api/pages"'), server.indexOf('app.delete("/api/pages/:id"'));
  assert.match(list, /query = req\.query\.archived === "1" \? query\.lt\("created_at", cutoff\) : query\.gte\("created_at", cutoff\);/);
  assert.doesNotMatch(list, /task_id/, "no filter on what made it");
  const dashboard = read("webapp/views/dashboard.html");
  assert.match(dashboard, /<button class="tab" data-tab="pages" onclick="switchTab\('pages'\)">Pages<\/button>/);
  assert.match(dashboard, /fetch\('\/api\/pages\?archived=1'\)/);
  assert.match(dashboard, /Delete this page for good\? The answer in your chat stays\./);
  assert.match(dashboard, />A page is something ClosedHand makes whenever it serves you better than a chat reply, like a trip plan, a guide or a comparison worth keeping or sharing\. Open it here, or download it as PDF or Word\.</, "says what a page is, plainly");
});

test("a saved agent's page is linked in its message, and removing a run keeps its page", () => {
  const handlers = read("lib/tools/handlers.js");
  assert.match(handlers, /automation_run_id: run\?\.kind === "automation" \? run\.taskId : null/);
  assert.match(handlers, /note: run\?\.kind === "agent" \|\| run\?\.kind === "automation"/);
  const delivery = read("lib/task-delivery.js");
  assert.match(delivery, /\.eq\(table === "automation_runs" \? "automation_run_id" : "task_id", row\.id\)/);
  assert.match(delivery, /const reportId = await reportFor\(db, row, table\);/);
  const sql = read("migrations/052_pages.sql");
  assert.match(sql, /FOREIGN KEY \(task_id\) REFERENCES agent_tasks\(id\) ON DELETE SET NULL;/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS automation_run_id uuid REFERENCES automation_runs\(id\) ON DELETE SET NULL;/);
});
