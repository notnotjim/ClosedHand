// The New Agent box: every field fits at once, each says what it does in the
// person's words, an agent can carry several rules, and every destination in
// "Send results to" actually delivers, Email included.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const dashboard = read("webapp/views/dashboard.html");

test("several rules go into the instructions as a list, and come back out when editing", () => {
  const start = dashboard.indexOf("    var RULES_HEAD");
  const box = {};
  vm.runInNewContext(dashboard.slice(start, dashboard.indexOf("    async function saveAutomation()", start)) + "\nthis.withRules = withRules; this.splitRules = splitRules;", box);
  const full = box.withRules("Check oil prices.", "Always include specific numbers\n- Name the source\n\n");
  assert.equal(full, "Check oil prices.\n\nRULES (check the result follows every one of these before sending it, and fix it if not):\n- Always include specific numbers\n- Name the source");
  assert.deepEqual({ ...box.splitRules(full) }, { prompt: "Check oil prices.", rules: "Always include specific numbers\nName the source" }, "saving again never adds them twice");
  assert.equal(box.withRules("Check oil prices.", "  "), "Check oil prices.");
  const old = "Brief me.\n\nQUALITY CHECK: Before delivering results, verify against these criteria: Must cite 5 sources. If any criteria fail, iterate and improve before reporting.";
  assert.deepEqual({ ...box.splitRules(old) }, { prompt: "Brief me.", rules: "Must cite 5 sources" }, "an older agent's check reads back as one rule");
  assert.match(dashboard, /task_prompt: withRules\(prompt, document\.getElementById\('auto-quality-input'\)\.value\),/);
  assert.match(dashboard, /var parts = splitRules\(a\.task_prompt \|\| a\.description \|\| ''\);/);
  assert.match(dashboard, /<label for="auto-quality-input" style="margin-top:10px;">Rules <span[^>]*>\(optional, one per line\)<\/span><\/label>\s*<textarea id="auto-quality-input" rows="2"/);
  assert.match(read("webapp/server.js"), /fullPrompt \+= "\\n\\nRULES \(check the result follows every one of these before sending it, and fix it if not\):\\n"/);
  assert.match(read("lib/automations.js"), /If the task includes a RULES list \(or, in older tasks, a QUALITY CHECK section\), check the result against each one explicitly/);
});

test("each field says what it does, in the names the person sees elsewhere", () => {
  assert.match(dashboard, /When I ask: it runs when you ask for it in any chat, or when you press Run on its card under Saved agents\./);
  assert.match(dashboard, /Preferred skills <span[^>]*>\(optional, always used when picked; add or remove skills under Skills on the Agents tab\)<\/span>/);
  assert.match(dashboard, /<span class="auto-tooltip">Notifications from this agent will be delivered even during your quiet hours\.<\/span>/);
  assert.doesNotMatch(dashboard, /Use for time-sensitive alerts/);
  assert.match(read("webapp/public/builtin-skills.json"), /"name": "Instagram \(sandbox computer\)"/);
  assert.doesNotMatch(dashboard, /'the workspace browser'|'the workspace'/, "the sandbox computer is called that on agent cards too");
});

test("the box fits a laptop screen: room for the select's arrow, one row of advanced settings", () => {
  assert.match(dashboard, /\.modal select \{\n\s*appearance: none;[\s\S]{0,120}padding-right: 34px !important;[\s\S]{0,500}background-position: right 12px center;/);
  assert.doesNotMatch(dashboard, /<select id="auto-template-select"[^>]*background:#1A1817/, "an inline background would hide the arrow");
  assert.match(dashboard, /<div class="modal agent-modal" style="max-width:760px;max-height:calc\(100vh - 16px\);">/);
  assert.match(dashboard, /<textarea id="auto-prompt-input" rows="2"/);
  assert.doesNotMatch(dashboard, /id="auto-model-desc"/, "the speed descriptions are on the buttons, not a line of their own");
});

test("Email sends the results to the person's own inbox, from their own account", async () => {
  const sent = [];
  const load = Module._load;
  Module._load = function (request, parent, ...rest) {
    if (parent && /own-email\.js$/.test(parent.filename)) {
      if (request === "./context") return { activeUserStore: {} };
      if (request === "./services/google") return { listGoogleAccounts: () => [{ email: "sam@example.com", primary: true }] };
      if (request === "./services/microsoft") return { listMicrosoftAccounts: () => [] };
      if (request === "./tools/handlers") return { handleInternalTool: async (name, input) => { sent.push({ name, input }); return { success: true, messageId: "m1" }; } };
    }
    return load.call(this, request, parent, ...rest);
  };
  try {
    delete require.cache[require.resolve("../lib/own-email")];
    const { sendToSelf } = require("../lib/own-email");
    assert.equal(await sendToSelf("Oil monitor", "## Today\n**Brent is up 2%.**\n[[next]]\nSee [the page](https://sam.closedhand.ai/page/x)."), "m1");
  } finally { Module._load = load; }
  assert.deepEqual(sent, [{ name: "gmail_send", input: { to: "sam@example.com", account: "sam@example.com", subject: "Oil monitor",
    body: "Today\nBrent is up 2%.\n\nSee the page: https://sam.closedhand.ai/page/x." } }]);

  const { destinationsFor } = require("../lib/task-delivery");
  const row = (dests) => ({ user_id: "u", platform: "web", chat_id: "u", runtime: { config: { name: "Oil monitor", output_destinations: dests } } });
  assert.deepEqual(await destinationsFor(null, "automation_runs", row(["email"])), [{ platform: "own_email", chatId: "Oil monitor" }]);
  assert.deepEqual(await destinationsFor(null, "automation_runs", row(["dashboard"])), [], "dashboard only sends nothing to any chat");
  assert.match(read("lib/messaging.js"), /if \(platform === "own_email"\) return require\("\.\/own-email"\)\.sendToSelf\(chatId, message\);/);
});
