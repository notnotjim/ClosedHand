// A message sent while Closedhand is still answering the last one joins that
// answer, as frontier chat apps do: the reply running takes it in at its next
// step, and the message's own turn then finds it answered and says nothing.
// It used to be answered on its own after a "new message first" line that
// read as if the new message were the one being put off. A file, a command,
// a project's emoji or a possible answer to a waiting question still waits
// its turn. /bug and the yes or no to sending it never wait at all, even
// behind a reply that has jammed. Runs the real queue (lib/context.js,
// lib/user-mutex.js) with a stand-in reply.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

let bugQuestion = false;
const stand = (rel, exports) => { const file = require.resolve(path.join(__dirname, "..", "lib", rel)); require.cache[file] = { id: file, filename: file, loaded: true, exports }; };
stand("bug-reports.js", { isBugReport: (t) => /^\s*\/bug\b/i.test(t), answersBugQuestion: (u, t) => bugQuestion && /^(yes|no)$/i.test(t.trim()) });
const ctx = require("../lib/context");
const fold = require("../lib/fold-in");
ctx.pendingConfirmations = {};
const tick = () => new Promise((r) => setTimeout(r, 5));

test("a message sent mid-reply joins it, and its own turn says nothing", async () => {
  let release;
  const running = ctx.queueUserMessage("u1", () => new Promise((r) => { release = r; }), { text: "Draft a reply to Mara", platform: "whatsapp_linked", chatId: "self" });
  await tick();
  const seen = [];
  const second = ctx.queueUserMessage("u1", async () => { seen.push(ctx.foldedIn); }, { text: "and say Tuesday, not Monday", platform: "whatsapp_linked", chatId: "self" });
  assert.equal(ctx.pendingIncoming.u1, 1, "waiting for its turn");
  assert.deepEqual(fold.take("u1", "web", "u1"), [], "not taken into a reply in another chat");
  assert.deepEqual(fold.take("u1", "whatsapp_linked", "self"), ["and say Tuesday, not Monday"]);
  assert.deepEqual(fold.take("u1", "whatsapp_linked", "self"), [], "taken once");
  assert.equal(fold.takenWaiting("u1"), 1, "the running reply does not step aside for it");
  release();
  await running; await second;
  assert.deepEqual(seen, [true], "its own turn knows it was answered");
  assert.equal(fold.takenWaiting("u1"), 0);
});

test("files, commands, project emoji and possible answers wait their turn", async () => {
  const opts = (text) => ({ text, platform: "telegram", chatId: 7 });
  assert.equal(fold.arrive("u2", {}), null, "a photo or voice note: no text before its turn");
  assert.equal(fold.arrive("u2", opts("/clear")), null);
  assert.equal(fold.arrive("u2", opts("voice replies on")), null);
  assert.equal(fold.arrive("u2", opts("🏠 how is the move going")), null, "a project's emoji picks that project");
  ctx.pendingConfirmations.u2 = { toolName: "gmail_send_draft" };
  assert.equal(fold.arrive("u2", opts("is it from my other address?")), null, "a question is waiting for an answer");
  delete ctx.pendingConfirmations.u2;
  const entry = fold.arrive("u2", opts("thanks"));
  assert.ok(entry);
  fold.leave("u2", entry);
  assert.deepEqual(fold.take("u2", "telegram", 7), [], "once its turn has come, it is not taken in");
});

test("/bug and its yes or no go straight through, never behind a reply still running", async () => {
  let release;
  const running = ctx.queueUserMessage("u3", () => new Promise((r) => { release = r; }), { text: "Plan the Lisbon weekend", platform: "web", chatId: "u3" });
  await tick();
  const order = [];
  await ctx.queueUserMessage("u3", async () => { order.push("bug"); }, { text: "/bug it is stuck", platform: "web", chatId: "u3" });
  bugQuestion = true;
  await ctx.queueUserMessage("u3", async () => { order.push("yes"); }, { text: "yes", platform: "web", chatId: "u3" });
  bugQuestion = false;
  assert.deepEqual(order, ["bug", "yes"], "both ran while the reply was still running");
  assert.equal(ctx.pendingIncoming.u3 || 0, 0, "neither makes the running reply step aside");
  release();
  await running;
});

test("the engine takes messages in at each step, and the platforms say what each message is", () => {
  const engine = read("lib/engine.js");
  assert.match(engine, /if \(ctx\.foldedIn\) \{\n\s*console\.log\([^\n]*\n\s*return null;/, "its own turn says nothing");
  assert.match(engine, /if \(opts\.fromPerson\) \{\n\s*const more = require\("\.\/fold-in"\)\.take\(userId, deliverPlatform, chatId\);/);
  assert.match(engine, /\(\(\(ctx\.pendingIncoming\?\.\[userId\] \|\| 0\) - require\("\.\/fold-in"\)\.takenWaiting\(userId\)\) > 0\)/);
  assert.match(engine, /Take it into account, and answer it in the same reply\./);
  assert.match(engine, /m\.content\.some\(b => b\?\.type === "tool_result"\)\) continue;/, "tool results stay first in their message");
  assert.match(engine, /"I'll answer your latest message first, then come back to the one before it\."/, "which message waits is clear");
  assert.doesNotMatch(engine, /I'll follow up on this one right after/);
  const wiring = {
    "lib/platforms/whatsapp-linked.js": /\}, media \? \{\} : \{ text: engineText, platform: "whatsapp_linked", chatId: _selfJid \}\);/,
    "lib/web-chat-ws.js": /\}, fileData \|\| project \? \{\} : \{ text, platform: "web", chatId: userId \}\);/,
    "lib/platforms/web.js": /\}, \{ text: msg\.content, platform: "web", chatId: userId \}\);/,
    "lib/platforms/discord.js": /\}, \{ text, platform: "discord", chatId: discordUserId \}\);/,
    "lib/platforms/line.js": /\}, message\.type === "text" \? \{ text: message\.text, platform: "line", chatId: lineUserId \} : \{\}\);/,
    "lib/platforms/slack-handler.js": /\}, \{ text, platform: "slack", chatId: slackUserId \}\);/,
    "lib/platforms/whatsapp.js": /\}, text \? \{ text, platform: "whatsapp", chatId: waId \} : \{\}\);/,
    "lib/platforms/telegram.js": /\}, msg\.text \? \{ text: msg\.text, platform: "telegram", chatId \} : \{\}\); \/\/ end queueUserMessage/,
  };
  for (const [file, re] of Object.entries(wiring)) assert.match(read(file), re, file);
});
