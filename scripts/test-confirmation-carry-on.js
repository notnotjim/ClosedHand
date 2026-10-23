// After a yes or a no, the turn carries on in the chat's own loop, from where
// the question was asked, with the held call's result. A loop of its own used
// to refuse anything else that needed a yes, even a read, so the model asked
// the person in its own words first and they were asked twice for each step:
// a draft sent from an alias took three questions and two "say send" lines.
// Through the chat's loop every check applies after a yes too, and the next
// step that needs one is put with its own card straight away.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

function loadConfirmation(pending) {
  const ran = [], asked = [], conversation = [];
  const ctx = { pendingConfirmations: { u1: pending }, activePlatform: "web" };
  const deps = {
    "./context": ctx, "./storage": { saveStore() {} }, "./conversation": { getConversation: () => conversation },
    "./tools/handlers": { handleInternalTool: async (name, input) => { ran.push([name, input]); return { success: true, draft_id: "r-draft-1" }; } },
    "./mcp": { callMCPTool: async () => { throw new Error("not an MCP tool"); } },
    "./spend-guard": { ledgerUpdate: async () => {} }, "./messaging": { sendTyping() {} },
    "./confirmation-lifetime": require("../lib/confirmation-lifetime"),
    "./engine": { ask: async (...args) => { asked.push(args); return "Sent from ana@harbour.test."; } },
  };
  const context = { module: { exports: {} }, console: { log() {} }, Date, JSON, require: (name) => { if (!(name in deps)) throw Error(name); return deps[name]; } };
  vm.runInNewContext(read("lib/confirmation.js"), context);
  return { ...context.module.exports, ctx, ran, asked, conversation };
}

const held = () => ({
  askedAt: Date.now(), toolName: "gmail_send_draft", toolUseId: "tu-2", isInternal: true,
  toolInput: { draft_id: "r-draft-1", _userId: "u1", _chatId: "self", _platform: "whatsapp_linked" },
  request: "Send it from ana@harbour.test please",
  messages: [
    { role: "user", content: "Send it from ana@harbour.test please" },
    { role: "assistant", content: [{ type: "tool_use", id: "tu-1", name: "gmail_draft_update", input: { draft_id: "r-draft-1", from: "ana@harbour.test" } }, { type: "tool_use", id: "tu-2", name: "gmail_send_draft", input: { draft_id: "r-draft-1" } }] },
  ],
  otherToolResults: [{ type: "tool_result", tool_use_id: "tu-1", content: "{\"success\":true}" }],
});

test("a yes runs the held call and the chat carries on from there", async () => {
  const c = loadConfirmation(held());
  const reply = await c.handleConfirmation("u1", "self", "Yes", { onStatusEvent() {} });
  assert.equal(reply, "Sent from ana@harbour.test.");
  assert.deepEqual(c.ran.map(([name, input]) => [name, input.draft_id]), [["gmail_send_draft", "r-draft-1"]]);
  assert.equal(c.ctx.pendingConfirmations.u1, undefined);
  const [[userId, request, file, chatId, deep, opts]] = c.asked;
  assert.deepEqual([userId, request, file, chatId, deep], ["u1", "Send it from ana@harbour.test please", null, "self", false], "the request it was working on");
  assert.equal(opts.platform, "whatsapp_linked", "back to the chat it was asked in");
  assert.equal(typeof opts.onStatusEvent, "function", "progress lines still show");
  assert.equal(opts.resume.said, "Yes, go ahead.");
  const last = opts.resume.messages.at(-1);
  assert.equal(opts.resume.messages.length, 3);
  assert.equal(last.content.map((b) => b.tool_use_id).join(" "), "tu-1 tu-2", "every call of that step has its result");
  assert.match(last.content[1].content, /"success":true/);
});

test("a no carries on too, with the held call marked declined and not run", async () => {
  const c = loadConfirmation(held());
  await c.handleConfirmation("u1", "self", "no thanks");
  assert.equal(c.ran.length, 0);
  const opts = c.asked[0][5];
  assert.equal(opts.resume.said, "No, cancel that.");
  assert.match(opts.resume.messages.at(-1).content[1].content, /"declined":true[\s\S]*The person said no/);
});

test("the chat's loop takes the turn up where it stopped", () => {
  const conf = read("lib/confirmation.js");
  assert.doesNotMatch(conf, /The user confirmed one action, not this one/, "no loop of its own refusing the next step");
  assert.doesNotMatch(conf, /llm\.messages\.create/);
  const engine = read("lib/engine.js");
  assert.match(engine, /const turnOpts = \{ \.\.\.opts, platform, fromPerson: true \};/);
  assert.match(engine, /const confirmResult = await handleConfirmation\(userId, chatId \|\| userId, String\(userMessage\), turnOpts\);/);
  assert.match(engine, /conversation\.push\(\{ role: "user", content: opts\.resume \? opts\.resume\.said : userMessage \}\);/, "the conversation records the answer");
  assert.match(engine, /messages\.push\(\.\.\.\(opts\.resume \? opts\.resume\.messages : conversation\)\);/, "the turn as it stood");
  assert.match(engine, /const isLight = !fileData && !opts\.resume && /);
  assert.match(engine, /const isQuick = !fileData && !isLight && !opts\.resume && /);
  assert.match(engine, /for \(const m of opts\.resume\?\.messages \|\| \[\]\) \{[\s\S]{0,300}unlockedInternalTools\.add\(b\.name\);\n\s*unlockedMcpTools\.add\(b\.name\);/, "tools unlocked before the question stay unlocked");
  // Anything but a yes or no drops the question, and the reply hears so.
  assert.match(engine, /turnOpts\.heldNote = await dropPending\(userId, "moved_on"\);/);
  assert.match(engine, /macHowTo\(userMessage, conversation\) \+ \(opts\.heldNote \? "\\n\\n" \+ opts\.heldNote : ""\)/);
  assert.match(read("lib/assistant-email.js"), /heldNote = await confirmations\.dropPending\(account\.user_id, 'moved_on'\);[\s\S]*_noHandover: true, heldNote \}\);/, "in email too");
  const gate = engine.indexOf("ctx.pendingConfirmations[userId] = {");
  assert.match(engine.slice(gate, gate + 900), /request: userMessage,/, "a held call remembers the request");
});
