// The dashboard lists work started from chats while it still needs a look:
// running, waiting on the person, or finished without a sure delivery. A
// delivered answer is in the chat, and its page under Pages, so it is not
// repeated. Each finished card says how the run ended in the person's
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

test("chat work stays while it runs or waits, and a finished run only when its answer may not have arrived", () => {
  const server = read("webapp/server.js");
  assert.match(server, /const LIVE_RUN_STATUSES = \["running", "pending", "awaiting_confirmation"\];/);
  assert.match(server, /const lists = \[runs\(\)\.in\("status", LIVE_RUN_STATUSES\), runs\(\)\.in\("status", DONE_RUN_STATUSES\)\.gte\("created_at", cutoff\)\.neq\("delivery_status", "sent"\)\];/, "a delivered run leaves the list");
  assert.match(server, /select\("id, goal, title, status, model, result, progress, tools_used, error, created_at, completed_at, result_edited_at, runtime, delivery_status"\)/);
  assert.doesNotMatch(server, /\/api\/agents[^\n]*archived|req\.query\.archived === "1" && req\.query\.count === "1"\) \{\n\s*const \{ count, error \} = await supabase\.from\("agent_tasks"\)/, "no archive of delivered runs");
  assert.match(dashboard, /var recent = live\.concat\(waiting, finished\);/, "running and waiting first, in one list");
  assert.match(dashboard, /\(recent\.length \? '<div class="mc-section-label">From your chats<\/div>' : ''\)/, "named for where the runs came from");
  assert.doesNotMatch(dashboard, /toggleArchivedRuns|_archivedRunCount|\/api\/agents\?archived=1/);
  assert.match(dashboard, /a\.delivery_status !== 'sent' &&\n\s*a\.completed_at && Date\.now\(\) - new Date\(a\.completed_at\)\.getTime\(\) > 2 \* 60000\) \{\n\s*detail = 'This may not have reached your chat, so it stays here\. ' \+ detail;/, "a late delivery says why the card is still there");
  assert.match(dashboard, /function archiveRow\(toggle, count, open\) \{\n\s*if \(!count\) return '';/, "Pages keeps its Archived row");
  assert.doesNotMatch(dashboard, /'Running now'|'This week'/, "the cards say running or waiting themselves");
  assert.match(dashboard, /What ClosedHand is working on now, the agents you have set to run on a schedule, like daily briefings or monitoring, and what is coming up\./);
});

test("the Schedules tab holds what is about time; what ClosedHand made is on Pages", () => {
  assert.match(dashboard, /onclick="switchTab\('automations'\)">Schedules<\/button>/);
  const schedule = dashboard.slice(dashboard.indexOf('id="tab-automations"'), dashboard.indexOf('id="tab-goals"'));
  assert.doesNotMatch(schedule, />Resources<|id="files-section"|id="datasets-section"|skills-library/, "no Resources on the Schedules tab");
  const pages = dashboard.slice(dashboard.indexOf('id="tab-pages"'), dashboard.indexOf('id="tab-settings"'));
  assert.match(pages, /id="files-section"[\s\S]*<div class="mc-subsection-label">Files<\/div>[\s\S]*id="datasets-section"[\s\S]*<div class="mc-subsection-label">Tables<\/div>/, "files and tables sit under Pages");
  assert.match(dashboard, /if \(tabName === 'pages'\) \{\n\s*if \(typeof loadFiles === 'function'\) loadFiles\(\);\n\s*if \(typeof loadDatasets === 'function'\) loadDatasets\(\);/);
  assert.match(dashboard, /const resolved = \(h === 'workers' \|\| h === 'agents' \|\| h === 'schedules' \|\| h === 'schedule'\) \? 'automations' : h;/, "old #agents links still open it");
  assert.match(read("lib/dashboard-links.js"), /async function dashboardUrl\(platform, section = "schedules"\)/);
});

test("Upcoming says what, what kind and when; what already happened folds under Past", () => {
  const fns = vm.runInNewContext([fn("reminderTitle")].join("\n") + "\n({ reminderTitle })", {});
  assert.equal(fns.reminderTitle("dentist-clinic-6oct"), "Dentist clinic 6oct", "an old slug reads as words");
  assert.equal(fns.reminderTitle("Decide on iCloud storage"), "Decide on iCloud storage");
  assert.equal(fns.reminderTitle(""), "Reminder");
  assert.match(dashboard, /return upcomingRow\(\{ icon: '\\u23F0', title: reminderTitle\(r\.name\), kind: 'Reminder', when: r\.next_run \|\| '' \}\);/, "the note ClosedHand left itself is not shown");
  assert.doesNotMatch(dashboard, /esc\(r\.task/, "no reminder prompt on the dashboard");
  assert.doesNotMatch(dashboard, /_showPastReminders|Show \d+ that already ran|that already ran<\/a>/);
  assert.match(dashboard, /<button type="button" class="mc-section-label archive-row" id="past-toggle" aria-expanded="false" aria-controls="past-body" onclick="togglePast\(\)">Past <span class="count" id="past-count"><\/span><span class="chevron-down"><\/span><\/button>/, "Past is a heading row like Archived");
  assert.match(dashboard, /<div id="past-body" hidden>\n\s*<div id="reminders-past"><\/div>\n\s*<div id="recent-flights"><\/div>/, "reminders that ran and flights flown, folded away");
  assert.match(read("lib/tools/definitions.js"), /What it is for, in a few plain words, as the person sees it under Upcoming on the dashboard: 'Dentist appointment', 'Decide on iCloud storage'\. Not a slug\./);
});
