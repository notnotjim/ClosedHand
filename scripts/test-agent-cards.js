// The Agents list on the dashboard keeps a week of runs and folds older ones
// into Archived. Each finished card says how the run ended in the person's
// terms, the same way the chat did: the first line of the answer, or why it
// could not finish. The quality check's notes are ClosedHand's own working
// and never shown.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const dashboard = read("webapp/views/dashboard.html");
const fn = (name) => { const s = dashboard.indexOf(`function ${name}(`); return dashboard.slice(s, dashboard.indexOf("\n    }\n", s) + 6); };
const box = {};
vm.runInNewContext(["runWord", "runOutcome", "couldNotFinish", "stepText"].map(fn).join("\n") +
  "\nthis.runWord = runWord; this.runOutcome = runOutcome; this.stepText = stepText;", box);

test("a run that answered says Completed, and its line gives how the answer starts", () => {
  const a = { status: "partial", result: "## Newcastle and the top four\n**About a 6% chance** of the top five.\n[[next]]\nDetail." };
  assert.equal(box.runOutcome(a), "Newcastle and the top four", "the pill carries the word; the line does not repeat it");
  assert.equal(box.runWord(a), "Completed", "the check's verdict is not the person's business");
  assert.equal(box.runOutcome({ status: "completed", result: "x".repeat(200) }).length < 130, true);
});

test("a run that could not finish says why in plain words, never the check's note", () => {
  assert.equal(box.runWord({ status: "partial", error: "No answer was produced." }), "Couldn't finish");
  assert.equal(box.runOutcome({ status: "partial", error: "No answer was produced." }), "Something went wrong partway through.");
  assert.equal(box.runOutcome({ status: "failed", error: "fetch failed" }), "The connection to the AI provider kept dropping.");
  assert.equal(box.runOutcome({ status: "failed", error: "This task reached its work allowance." }), "It reached the work allowance for one task.");
  assert.equal(box.runWord({ status: "cancelled" }), "Stopped");
  assert.equal(box.runOutcome({ status: "cancelled" }), "Stopped before it finished.");
  assert.equal(box.stepText("Quality check sent it back for another pass: No answer was produced."), "Improving the answer before sending it");
  assert.equal(box.stepText("Searching the web"), "Searching the web");
  assert.doesNotMatch(dashboard, /escapeHtml\(String\(a\.error\)\)/, "the raw error is never printed");
  assert.match(read("lib/agents.js"), /\{ text: "Improving the answer before sending it", time:/);
  assert.doesNotMatch(read("lib/agents.js"), /Quality check sent it back/);
});

test("a week of runs on the list, older ones archived and loaded on request", () => {
  const server = read("webapp/server.js");
  assert.match(server, /const ARCHIVE_AFTER_MS = 7 \* 24 \* 60 \* 60 \* 1000;/);
  assert.match(server, /req\.query\.archived === "1"\n\s*\? \[runs\(\)\.in\("status", DONE_RUN_STATUSES\)\.lt\("created_at", cutoff\)\]\n\s*: \[runs\(\)\.in\("status", LIVE_RUN_STATUSES\), runs\(\)\.in\("status", DONE_RUN_STATUSES\)\.gte\("created_at", cutoff\)\]/);
  assert.doesNotMatch(dashboard, /6 \* 3600 \* 1000/, "finished runs no longer vanish after six hours");
  assert.match(dashboard, /var recent = live\.concat\(waiting, finished\);/, "running and waiting first, in one list");
  assert.match(dashboard, /\(recent\.length \|\| _archivedRunCount \? '<div class="mc-section-label">From your chats<\/div>' : ''\)/, "named for where the runs came from, and shown above Archived even when the week is empty");
  assert.doesNotMatch(dashboard, /'Running now'|'This week'/, "the cards say running or waiting themselves");
  assert.match(dashboard, /fetch\('\/api\/agents\?archived=1'\)/);
  assert.match(dashboard, /function archiveRow\(toggle, count, open\) \{\n\s*if \(!count\) return '';/, "the Archived row shows only when something is archived");
  assert.match(dashboard, /'Archived <span class="count">\\u00b7 ' \+ count \+ '<\/span><span class="chevron-down"><\/span><\/button>'/, "a heading row like the list's own, with its count");
  assert.match(dashboard, /_archivedRunCount = await archivedCount\('\/api\/agents\?archived=1&count=1'\);/);
  assert.match(read("webapp/server.js"), /if \(req\.query\.archived === "1" && req\.query\.count === "1"\) \{/);
  assert.doesNotMatch(dashboard, /Show archived runs|Nothing archived yet/);
  assert.match(dashboard, /ClosedHand spins up agent teams automatically when a task needs research, or an agent on each part\. You can also create your own agents that run on a schedule/);
});
