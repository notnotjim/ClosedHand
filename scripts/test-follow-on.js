// A long reply goes as two or three messages that follow on, on every chat;
// an email, a report or a PDF shows the break as a paragraph. Background work
// shows its progress as one live line on the web and one message elsewhere.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const { parts, joined, sendParts, splitTelegram } = require("../lib/follow-on");

const reply = "Three good ones for 7 to 14 Oct:\n- Cubicity, £14\n\n[[next]]\n\n| Hotel | Per night |\n|---|---|\n| Cubicity | £14 |\n[[next]]\nPrices move; check Agoda too.";

test("a reply splits at each break line, and only there", () => {
  assert.deepEqual(parts(reply), ["Three good ones for 7 to 14 Oct:\n- Cubicity, £14", "| Hotel | Per night |\n|---|---|\n| Cubicity | £14 |", "Prices move; check Agoda too."]);
  assert.deepEqual(parts("Just one line."), ["Just one line."]);
  assert.deepEqual(parts("Talking about [[next]] inline stays whole."), ["Talking about [[next]] inline stays whole."]);
  assert.equal(joined(reply).includes("[[next]]"), false);
  assert.match(joined(reply), /£14\n\n\| Hotel/);
});

test("parts are sent in order, one at a time", async () => {
  const sent = [];
  const first = await sendParts(reply, async (p) => { sent.push(p); return { id: sent.length }; }, 0);
  assert.equal(sent.length, 3);
  assert.deepEqual(first, { id: 1 }, "callers tracking the reply get the first message");
});

test("Telegram's sender splits too, wherever it is called from", async () => {
  const sent = [];
  const bot = splitTelegram({ sendMessage: async (chat, text) => { sent.push([chat, text]); return { message_id: sent.length }; } });
  await bot.sendMessage(7, "Hello [[next]] stays whole");
  await bot.sendMessage(7, "A\n[[next]]\nB");
  assert.deepEqual(sent.map((s) => s[1]), ["Hello [[next]] stays whole", "A", "B"]);
  assert.equal(splitTelegram(bot), bot, "wrapped once");
  assert.equal((read("index.js").match(/splitTelegram\(new TelegramBot\(/g) || []).length, 2, "both places the bot is made");
});

test("every chat app sender and every non-chat output handles breaks", () => {
  const messaging = read("lib/messaging.js");
  for (const fn of ["sendWhatsAppMessage", "sendSlackMessage", "sendDiscordMessage"]) {
    assert.match(messaging, new RegExp(`require\\("\\./follow-on"\\)\\.sendParts\\(text, \\(part\\) => ${fn}\\(`), fn);
  }
  assert.match(read("lib/platforms/line.js"), /sendParts\(text, \(part\) => sendLinePush\(lineUserId, part\)\)/);
  assert.match(read("lib/platforms/whatsapp-linked.js"), /sendParts\(message, \(part\) => sendLinkedMessage\(chatId, part, messageId\)\)/);
  assert.match(read("lib/platforms/telegram.js"), /if \(streamInfo && inParts\)/, "a streamed Telegram reply is replaced by its parts");
  assert.match(read("lib/assistant-email.js"), /text = require\('\.\/follow-on'\)\.joined\(text\);/, "an email is one message");
  assert.match(read("lib/services/tts.js"), /speechText\(require\("\.\.\/follow-on"\)\.joined\(text\)\)/, "read aloud as paragraphs");
  assert.match(read("webapp/views/dashboard.html"), /md = String\(md\)\.replace\(\/\^\[ \\t\]\*\\\[\\\[next\\\]\\\]\[ \\t\]\*\$\/gm, ''\);/);
  assert.match(read("webapp/server.js"), /runPdf\(\{ \.\.\.run, result: String\(run\.result\)\.replace\(/);
});

test("the web chat shows the parts as separate messages", () => {
  const page = read("webapp/views/index.html");
  const start = page.indexOf("  function followOnParts(text) {");
  const box = {};
  vm.runInNewContext(page.slice(start, page.indexOf("\n  }\n", start) + 4) + "\nthis.f = followOnParts;", box);
  assert.deepEqual([...box.f(reply)], parts(reply), "the same split as the server");
  assert.match(page, /if \(!live \|\| i === 0\) addOneMessage\(part, role, null, ts, text\);/);
  assert.match(page, /else setTimeout\(function \(\) \{ addOneMessage\(part, role, null, ts, text\); \}, i \* 900\);/, "a beat apart when live");
});

test("the model is told: complete in chat, answer first, parts past a screen, reports only as an extra", () => {
  const { responsePresentation } = require("../lib/response-presentation");
  const guide = responsePresentation("web");
  assert.match(guide, /Answer in chat, completely/);
  assert.match(guide, /Lead with the answer/);
  assert.match(guide, /Put a line holding only \[\[next\]\] between them\. Never split a short reply, and never more than three parts\./);
  assert.match(guide, /A report \(a document or page to open\) is an extra, never the answer/);
});

test("research goes to the background at the start, with a note written from the request", () => {
  const engine = read("lib/engine.js");
  assert.match(engine, /UP-FRONT HANDOFF: When a request plainly needs several sites or many steps/);
  assert.match(engine, /purpose: "handover", timeoutMs: 6000/);
  assert.doesNotMatch(engine, /I'm continuing this in the background\. I'll bring the result back here when it finishes\./, "no stock sentence");
  assert.match(read("lib/tools/definitions.js"), /name: "agent_start",\n(.*\n){0,3}\s*core: true,/, "always loaded");
});

test("background progress: one live line on the web, one plain message on a chat app", () => {
  const agents = read("lib/agents.js");
  const start = agents.indexOf("function progressParts");
  const box = {};
  vm.runInNewContext(agents.slice(start, agents.indexOf("function formatElapsed")) + "\nthis.live = liveLine; this.still = stillWorking;", box);
  assert.equal(box.live("Searching the web... (8m so far)", 8 * 60000), "Searching the web · 8 min");
  assert.equal(box.still("Searching the web... (8m so far)", 8 * 60000), "Still on it, about 8 minutes in: searching the web. I'll send the answer here when it's done.");
  assert.match(agents, /sendToUser\(chatId, \{ type: "agent_progress", taskId, content: liveLine\(/);
  assert.match(agents, /\} else if \(deliveredNow \|\| !chatAppPinged\) \{/);
  assert.match(read("lib/task-delivery.js"), /\{ type: "agent_progress", taskId: row\.id, done: true \}/, "the line goes when the result lands");
  const page = read("webapp/views/index.html");
  assert.match(page, /if \(msg\.type === 'agent_progress'\) \{ agentLiveLine\(msg\); return; \}/);
  assert.ok(page.indexOf("if (msg.type === 'agent_progress')") < page.indexOf("armResponseWatchdog();\n"), "progress never arms the reply watchdog");
});
