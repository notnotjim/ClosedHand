// The New routine box: every field fits at once, each says what it does in the
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
  assert.match(dashboard, /When I ask: it runs when you ask for it in any chat, or when you press Run on its card under Routines\./);
  assert.match(dashboard, /Preferred skills <span[^>]*>\(optional, always used when picked; add a skill by pasting its link on Connections\)<\/span>/);
  assert.match(dashboard, /<span class="auto-tooltip">Notifications from this routine will be delivered even during your quiet hours\.<\/span>/);
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

test("Email sends the results from the assistant's own address to its owner, as a new conversation", async () => {
  const inserts = [];
  const account = { user_id: "u1", address: "pete-1a2b3c4d@assist.closedhand.ai", owner_email: "sam@example.com", enabled: true };
  const fakeDb = { from(table) {
    let op = "select";
    const q = { select: () => q, eq: () => q, maybeSingle: () => q, single: () => q,
      insert(row) { op = "insert"; inserts.push({ table, row }); return q; },
      then(done) {
        if (op === "insert") return done({ data: null, error: null });
        if (table === "assistant_email_accounts") return done({ data: account, error: null });
        if (table === "profiles") return done({ data: { settings: { bot_name: "Pete", preferred_name: "Sam" }, display_name: null }, error: null });
        return done({ data: null, error: null });
      } };
    return q;
  } };
  const load = Module._load;
  Module._load = function (request, parent, ...rest) {
    if (parent && /lib\/(assistant-email|own-email)\.js$/.test(parent.filename)) {
      if (request === "./db") return { supabase: fakeDb };
      if (request === "./context") return { activeUserId: "u1" };
    }
    return load.call(this, request, parent, ...rest);
  };
  try {
    for (const m of ["../lib/assistant-email", "../lib/own-email"]) delete require.cache[require.resolve(m)];
    const id = await require("../lib/own-email").sendToSelf("Oil monitor", "Brent is up 2%.\n[[next]]\nSee the page.");
    assert.match(id, /^[0-9a-f-]{36}$/);
    account.enabled = false; account.address = null;
    await assert.rejects(require("../lib/own-email").sendToSelf("Oil monitor", "x"), /Turn on your assistant’s email address in Settings/);
  } finally { Module._load = load; }
  const thread = inserts.find((i) => i.table === "assistant_email_threads").row;
  assert.deepEqual(thread.participants, ["sam@example.com"]);
  const message = inserts.find((i) => i.table === "assistant_email_messages").row;
  assert.equal(message.state, "outbox");
  assert.equal(message.direction, "out");
  assert.deepEqual(message.envelope.to, ["sam@example.com"], "to the owner only");
  assert.equal(message.envelope.replyToDelivery, null, "a new email, not a reply");
  assert.equal(message.envelope.displayName, "Pete, Sam’s assistant");
  assert.equal(message.envelope.text, "Brent is up 2%.\n\nSee the page.\n\nPete, Sam’s assistant");

  const { destinationsFor } = require("../lib/task-delivery");
  const row = (dests) => ({ user_id: "u", platform: "web", chat_id: "u", runtime: { config: { name: "Oil monitor", output_destinations: dests } } });
  assert.deepEqual(await destinationsFor(null, "automation_runs", row(["email"])), [{ platform: "own_email", chatId: "Oil monitor" }]);
  assert.deepEqual(await destinationsFor(null, "automation_runs", row(["dashboard"])), [], "dashboard only sends nothing to any chat");
  assert.match(read("lib/messaging.js"), /if \(platform === "own_email"\) return require\("\.\/own-email"\)\.sendToSelf\(chatId, message\);/);
});

test("with the assistant's address off, Email says where to turn it on and cannot be saved", () => {
  assert.match(dashboard, /_assistantEmail = \{ on: !!\(d\.available && d\.enabled && d\.address\), name: d\.name \|\| 'ClosedHand' \};/);
  assert.match(dashboard, /hint\.innerHTML = 'Turn on ' \+ escapeHtml\(_assistantEmail\.name\) \+ '\\u2019s email address in <a href="#" onclick="openEmailSettings\(\);return false;">Settings<\/a> to use this\.';/);
  assert.match(dashboard, /if \(_selectedDest === 'email' && _assistantEmail && !_assistantEmail\.on\) \{ errEl\.textContent = 'Turn on '/);
  assert.match(dashboard, /function openCreateAutomationModal\(\) \{\n\s*loadAssistantEmailState\(\);/);
  assert.doesNotMatch(read("lib/own-email.js"), /gmail_send|outlook_send/, "one meaning for Email: from the assistant's address");
});
