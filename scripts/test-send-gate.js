// While "Ask before sending emails" is ticked, nothing reaches other people
// without the person's yes, wherever the send comes from: the chat,
// background tasks, schedules and automations, a connected server's tool or
// a Send button pressed in a browser. Schedules once asked about no send at
// all, and a server that labelled its send tool "not destructive" was never
// asked about anywhere (lib/send-gate.js).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

// The MCP rule, read from its source: the module itself needs the MCP SDK.
const mcpSrc = read("lib/mcp-client.js");
const isDestructive = new Function(mcpSrc.slice(mcpSrc.indexOf("const DESTRUCTIVE_NAME"), mcpSrc.indexOf("\n}\n", mcpSrc.indexOf("function isDestructive(")) + 3) + "\nreturn isDestructive;")();

// Stand-ins for what the gate asks, so it runs without a database.
const fake = (rel, exports) => { const file = require.resolve(path.join(__dirname, "..", "lib", rel)); require.cache[file] = { id: file, filename: file, loaded: true, exports }; };
let mcpTools = {};
fake("user-mcp.js", {
  isUserMcpTool: (name) => name in mcpTools,
  needsMcpConfirmation: (userId, name) => isDestructive(mcpTools[name]),
  mcpQuestion: (userId, name) => `I'm about to run ${name}`,
});
fake("self-send.js", { sendsOnlyToSelf: (name, input) => input.to === "me@kestrelpadel.example" });
let paying = false;
fake("spend-guard.js", { refLabel: (userId, ref) => (ref === 7 ? 'button "Send"' : ""), spendIntent: () => (paying ? { kind: "click" } : null) });
const gate = require("../lib/send-gate");

test("a Send press is recognised in the sandbox browser, on the Mac and in Mac apps", () => {
  const yes = [
    ["sandbox_browse", { action: "click", selector: 'div[aria-label="Send"]' }],
    ["sandbox_browse", { action: "click", ref: 7 }],
    ["sandbox_browse", { action: "click", text: "Send now" }],
    ["sandbox_browse", { action: "press", key: "Control+Enter" }],
    ["sandbox_browse", { action: "batch", steps: [{ action: "fill", selector: "#body", text: "Hi Mara" }, { action: "click", selector: "#send-btn" }] }],
    ["sandbox_browse", { action: "eval_js", script: "document.querySelector('[aria-label=\"Send\"]').click()" }],
    ["sandbox_exec", { code: "from browser_helper import page\npage.get_by_role('button', name='Send').click()" }],
    ["bridge_browser_click", { selector: '[data-tooltip="Send"]' }],
    ["bridge_browser_execute_js", { javascript: "[...document.querySelectorAll('button')].find(b => b.textContent === 'Send').click()" }],
    ["bridge_ax_click", { app: "Mail", title: "Send", role: "AXButton" }],
    ["bridge_input_key_combo", { combo: "cmd+enter" }],
    ["bridge_input_key_press", { key: "d", modifiers: ["cmd", "shift"] }],
  ];
  for (const [name, input] of yes) assert.ok(gate.browserSend(name, input, (ref) => (ref === 7 ? 'button "Send"' : "")), `${name} ${JSON.stringify(input)}`);
  const no = [
    ["sandbox_browse", { action: "click", selector: "#compose" }],
    ["sandbox_browse", { action: "click", text: "Resend code" }],
    ["sandbox_browse", { action: "click", text: "Sender details" }],
    ["sandbox_browse", { action: "fill", selector: "#body", text: "please send the racquets", submit: false }],
    ["sandbox_browse", { action: "press", key: "Enter" }],
    ["bridge_browser_type", { selector: "#body", text: "I'll send it Monday" }],
    ["bridge_input_key_combo", { combo: "cmd+c" }],
    ["sandbox_exec", { code: "print('send')" }],
    ["gmail_create_draft", { to: "editor@harbourpost.example" }],
  ];
  for (const [name, input] of no) assert.equal(gate.browserSend(name, input), null, `${name} ${JSON.stringify(input)}`);
  assert.match(gate.browserSendCard("mac"), /press Send on your Mac/);
  assert.match(gate.browserSendCard("sandbox"), /press Send on Closedhand's sandbox computer/);
});

test("a connected server's send is asked about whatever it calls itself", () => {
  assert.equal(isDestructive({ name: "send_email", annotations: { destructiveHint: false } }), true, "labelled not destructive");
  assert.equal(isDestructive({ name: "sendEmail" }), true, "camelCase");
  assert.equal(isDestructive({ name: "reply_to_thread" }), true);
  assert.equal(isDestructive({ name: "forwardMessage", annotations: { destructiveHint: false } }), true);
  assert.equal(isDestructive({ name: "send_email", annotations: { readOnlyHint: true } }), false, "a read says so");
  assert.equal(isDestructive({ name: "list_messages" }), false);
  assert.equal(isDestructive({ name: "get_post", annotations: { destructiveHint: false } }), false, "reading a post is not sending one");
  assert.equal(isDestructive({ name: "delete_event" }), true, "deletes still ask");
  assert.equal(isDestructive({ name: "delete_event", annotations: { destructiveHint: false } }), false);
});

test("Microsoft's reply and forward send at once, so they are refused like a send", () => {
  for (const url of ["https://graph.microsoft.com/v1.0/me/messages/AAMk1/reply", "https://graph.microsoft.com/v1.0/me/messages/AAMk1/replyAll", "https://graph.microsoft.com/v1.0/me/messages/AAMk1/forward"])
    assert.ok(gate.isMailSendUrl(url), url);
  for (const url of ["https://graph.microsoft.com/v1.0/me/messages/AAMk1/createReply", "https://graph.microsoft.com/v1.0/me/messages"])
    assert.ok(!gate.isMailSendUrl(url), url);
  assert.match(gate.RAW_SEND_REFUSAL, /gmail_send_draft[^.]*outlook_send or outlook_reply[^.]*send_mail or reply_to_mail/);
});

test("runs nobody is watching ask about the same things the chat does", async () => {
  const ticked = { profile: { settings: {} } };
  const unticked = { profile: { settings: { require_send_confirmation: false } } };
  const ask = (name, input, store = ticked) => gate.unattended(name, input, "u1", store);

  assert.match((await ask("api_request", { method: "POST", url: "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send" })).refuse, /^Refused/);
  assert.match((await ask("api_request", { method: "POST", url: "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send" }, unticked)).refuse, /^Refused/, "refused even unticked");

  const mail = await ask("outlook_send", { to: "editor@harbourpost.example", subject: "Racquets", body: "Two land Monday." });
  assert.equal(mail.isInternal, true);
  assert.match(mail.card, /^I'm about to send an email\. Reply "yes"[\s\S]*To: editor@harbourpost\.example[\s\S]*Two land Monday\./);
  assert.match((await ask("reply_to_mail", { body: "Thanks" })).card, /^I'm about to reply to an email/);
  assert.equal(await ask("gmail_send", { to: "me@kestrelpadel.example" }), null, "to the person's own address");
  assert.equal(await ask("gmail_send", { to: "editor@harbourpost.example" }, unticked), null, "unticked: sends go");

  mcpTools = { harbour_send_message: { name: "send_message", annotations: { destructiveHint: false } }, harbour_list: { name: "list_messages" } };
  const viaServer = await ask("harbour_send_message", { to: "Mara" }, unticked);
  assert.deepEqual([viaServer.isInternal, viaServer.card], [false, "I'm about to run harbour_send_message"], "as in the chat, a server's send asks either way");
  assert.equal(await ask("harbour_list", {}), null);

  assert.match((await ask("sandbox_browse", { action: "click", selector: "#send-btn" })).card, /press Send on Closedhand's sandbox computer/);
  paying = true;
  assert.equal(await ask("sandbox_browse", { action: "click", selector: "#send-btn" }), null, "a paying click is the money check's to ask");
  paying = false;
  assert.equal(await ask("sandbox_browse", { action: "click", selector: "#send-btn" }, unticked), null);
  assert.equal(await ask("gmail_create_draft", { to: "editor@harbourpost.example" }), null, "a draft sends nothing");
});

test("every runner uses the gate: chat, background tasks, schedules and automations", () => {
  const engine = read("lib/engine.js");
  assert.match(engine, /const browserSendAt = !needsConfirmation && ctx\.activeUserStore\?\.profile\?\.settings\?\.require_send_confirmation !== false\n\s*\? require\("\.\/send-gate"\)\.browserSend\(/);
  assert.match(engine, /\} else if \(browserSendAt\) \{\n\s*confirmSummary = require\("\.\/send-gate"\)\.browserSendCard\(browserSendAt\);/);
  assert.match(engine, /usedCloudBrowser && \/\^bridge_\(browser\|input\)_\/\.test\(block\.name\) && !browserSendAt/, "the switch-machines question never hides a send");
  const agents = read("lib/agents.js");
  assert.match(agents, /sendGate\.MAIL_SEND_TOOLS\.has\(block\.name\) && sendConfirmRequired\(userStore\)/);
  assert.match(agents, /userMcp\.isUserMcpTool\(block\.name\) && userMcp\.needsMcpConfirmation\(userId, block\.name\) \? userMcp\.mcpQuestion\(/);
  assert.match(agents, /sendGate\.mailSendQuestion\(pendingSend\.name, pendingSend\.input\)/);
  for (const [file, store] of [["lib/automations.js", "freshStore"], ["lib/scheduling.js", "ctx.activeUserStore"]]) {
    const src = read(file);
    const at = src.indexOf(`const held = await sendGate.unattended(block.name, block.input, userId, ${store});`);
    assert.ok(at > 0, file);
    assert.match(src.slice(at, at + 700), /\} else if \(isInternalTool\(block\.name\)\) \{/, `${file}: before anything runs`);
    assert.match(src.slice(at, at + 700), /extra: \{ isInternal: held\.isInternal \}/, `${file}: a server's tool runs as one on yes`);
  }
  const hold = read("lib/spend-guard.js");
  assert.match(hold, /isInternal: true,\n\s*\.\.\.\(extra \|\| \{\}\),/, "extra can say the held call is a server's");
});
