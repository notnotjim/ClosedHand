const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function onboarding({ env = { DB_DRIVER: "pg" }, engineFails = false, sendFails = false, saveFails = false, settings = {}, displayName = "Alex Example", facts = {} } = {}) {
  const conversation = [], sent = [], calls = [];
  const ctx = { store: { facts: { ...facts } }, activeUserStore: { userId: "fixture-user", profile: { display_name: displayName, settings } } };
  let saved = structuredClone(settings);
  const dependencies = {
    "./context": ctx,
    "./model-wire": { responseText: () => "" },
    "./storage": { saveStore() {} },
    "./conversation": { getConversation: () => conversation },
    "./messaging": { sendText: async (chatId, text) => {
      if (sendFails && text === "Request answered.") throw new Error("delivery unavailable");
      sent.push({ chatId, text });
    } },
    "./services/google": { isGoogleConnected: () => false },
    "./services/shopify": { isShopifyConnected: () => false },
    "./services/slack-api": { isSlackConnected: () => false },
    "../user-store": { supabase: { from: () => ({ update: value => ({ eq: async () => {
      if (typeof saveFails === "function" ? saveFails(value.settings) : saveFails) return { error: new Error("database unavailable") };
      saved = structuredClone(value.settings);
      return { error: null };
    } }) }) } },
    "./flights": {}, "./flights-scheduler": {}, "./llm": {}, "./telegram-name": { showName: async () => {} },
    "./services/fact-vectors": { factVectors: () => ({ mirrorFact: async () => {} }) },
    "./engine": { queuedAsk: async (...args) => {
      calls.push(args);
      if (engineFails) throw new Error("provider unavailable");
      return "Request answered.";
    } },
  };
  const sandbox = { module: { exports: {} }, process: { env }, console: { log() {}, error() {} },
    require: name => {
      assert.ok(Object.hasOwn(dependencies, name), "Unexpected dependency: " + name);
      return dependencies[name];
    },
    fetch: async () => { throw new Error("Unexpected network request"); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../lib/onboarding.js"), "utf8"), sandbox);
  return {
    ctx, sent, calls, conversation, saved: () => saved,
    message: (text, opts) => sandbox.module.exports.handleOnboardingMessage("fixture-user", "fixture-chat", text, opts),
    reload: () => { ctx.activeUserStore.profile.settings = structuredClone(saved); },
    exports: () => sandbox.module.exports,
  };
}

// The account says Alex, so ClosedHand checks it: a name for itself, yes,
// then where they are, which they skip.
async function finish(flow, botName = "Robin") {
  await flow.message(botName);
  await flow.message("yes");
  await flow.message("skip");
}

test("a first request survives profile reloads and is answered in the same chat after introductions", async () => {
  const flow = onboarding(), request = "What is on my calendar tomorrow?";
  await flow.message(request);
  assert.equal(flow.saved().onboarding_pending, request);
  flow.reload();
  await finish(flow);
  assert.equal(flow.calls.length, 1);
  assert.deepEqual(flow.calls[0], ["fixture-user", request, null, "fixture-chat"]);
  assert.equal(flow.sent.at(-1).text, "Request answered.");
  assert.equal(flow.saved().onboarding_pending, null);
  assert.equal(flow.saved().onboarding_step, "done");
  await flow.message("skip");
  assert.equal(flow.calls.length, 1);
});

test("a question bundled with the bot name keeps the original request too", async () => {
  const flow = onboarding();
  await flow.message("Find my train booking");
  await finish(flow, "Robin. Also check the arrival time please");
  assert.equal(flow.calls.length, 1);
  assert.match(flow.calls[0][1], /Find my train booking/);
  assert.match(flow.calls[0][1], /Also check the arrival time please/);
});

test("greetings, /start and an automatic opener do not become deferred requests", async () => {
  for (const opener of ["Hi!", "/start", null]) {
    const flow = onboarding();
    await flow.message(opener);
    await finish(flow);
    assert.equal(flow.calls.length, 0);
    assert.ok(flow.conversation.every(turn => turn.content != null));
  }
});

test("an existing bundled request still resumes after an upgrade", async () => {
  const flow = onboarding({ settings: { onboarding_step: "ask_location", onboarding_pending: "Find my train booking" } });
  await flow.message("skip");
  assert.equal(flow.calls[0][1], "Find my train booking");
});

test("questions during introductions are retained without replacing the first request", async () => {
  const flow = onboarding();
  await flow.message("Find my train booking");
  await flow.message("Can you check the date too?");
  await finish(flow);
  assert.match(flow.calls[0][1], /Find my train booking/);
  assert.match(flow.calls[0][1], /Can you check the date too\?/);
});

test("an engine or delivery failure keeps the request and reports the failure", async () => {
  for (const failure of [{ engineFails: true }, { sendFails: true }]) {
    const flow = onboarding(failure);
    await flow.message("Find my train booking");
    await finish(flow);
    assert.equal(flow.saved().onboarding_pending, "Find my train booking");
    assert.match(flow.sent.at(-1).text, /couldn't.*earlier request/i);
  }
});

test("failed profile persistence does not advance onboarding in memory", async () => {
  const flow = onboarding({ saveFails: true });
  await assert.rejects(flow.message("Find my train booking"), /database unavailable/);
  assert.equal(flow.ctx.activeUserStore.profile.settings.onboarding_step, undefined);
  assert.equal(flow.calls.length, 0);
});

test("introductions start with names: a likely name is checked, then a short hello", async () => {
  const flow = onboarding();
  await flow.message(null);
  assert.equal(flow.sent[0].text, "Hey! Is it Alex? And what would you like to call me?");
  await flow.message("Robin");
  assert.equal(flow.sent.at(-1).text, "And is it Alex?");
  await flow.message("yes");
  assert.equal(flow.sent.at(-1).text, "Nice to meet you, Alex. Robin it is. And where are you these days? A city's plenty, so I get your timezone right.");
  assert.equal(flow.saved().bot_name, "Robin");
  assert.equal(flow.saved().preferred_name, "Alex");
  await flow.message("skip");
  assert.equal(flow.sent.at(-1).text, "No problem, tell me any time.\n\nAsk me anything, or send me something to remember.");
  assert.equal(flow.saved().onboarding_step, "done");
});

test("a name two sources agree on is used from the off, over the account's", async () => {
  // The chat app and the mail agree on Sam; the account says Sammy.
  const flow = onboarding({ displayName: "Sammy Example", facts: { "profile-name": "Sam" } });
  await flow.message(null, { platformName: "Sam Example" });
  assert.equal(flow.sent[0].text, "Hey Sam! Before we start, what would you like to call me?");
  await flow.message("Max", { platformName: "Sam Example" });
  assert.match(flow.sent.at(-1).text, /^Nice to meet you, Sam\. Max it is\./);
  const signed = onboarding({ displayName: "Sam Example", facts: { "profile-name": "Sam" }, settings: { name_certainty: "certain" } });
  await signed.message(null);
  assert.equal(signed.sent[0].text, "Hey Sam! Before we start, what would you like to call me?", "their own mail signs it, and nothing says otherwise");
});

test("a scanned name another source contradicts is checked, never assumed", async () => {
  // The scan read "Robbie" (from mail greeting the address); the account says Robert.
  const flow = onboarding({ displayName: "Robert H", facts: { "profile-name": "Robbie Hale" }, settings: { name_certainty: "certain" } });
  await flow.message(null);
  assert.equal(flow.sent[0].text, "Hey! Is it Robbie? And what would you like to call me?");
  await flow.message("Pete");
  assert.equal(flow.sent.at(-1).text, "And is it Robbie?");
  await flow.message("no, Robert");
  assert.match(flow.sent.at(-1).text, /^Nice to meet you, Robert\. Pete it is\./);
  assert.equal(flow.saved().preferred_name, "Robert");
});

test("the scan counts only the person's own mail and people writing to them as proof of a name", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "../lib/onboarding.js"), "utf8");
  assert.match(src, /certain only if their own sent mail signs off with that name, or people writing to them personally greet them by it/);
  assert.match(src, /Automated mail \(shops, services, newsletters\) greets people by whatever their address or a sign-up form suggests, so it never makes a name certain\./);
});

test("with no name to go on, it asks for both", async () => {
  const flow = onboarding({ displayName: null });
  await flow.message(null);
  assert.equal(flow.sent[0].text, "Hey! Before anything else, what should I call you, and what would you like to call me?");
});

test("a plan of theirs the scan found is mentioned once, in passing", async () => {
  const flow = onboarding({ settings: { welcome_highlight: "your trip to Lisbon on 12 October" } });
  await flow.message(null);
  await finish(flow);
  assert.equal(flow.sent.at(-1).text, "No problem, tell me any time. Looks like your trip to Lisbon on 12 October is coming up, so I'll keep an eye on that.\n\nAsk me anything, or send me something to remember.");
});

test("a plan already under way is not called coming up", async () => {
  const flow = onboarding({ settings: { welcome_highlight: "your stay in Da Nang until 7 October", welcome_highlight_when: "now" } });
  await flow.message(null);
  await finish(flow);
  assert.equal(flow.sent.at(-1).text, "No problem, tell me any time. I see you're in the middle of your stay in Da Nang until 7 October, so I'll keep an eye on that.\n\nAsk me anything, or send me something to remember.");
});

test("a failed completion write keeps onboarding open and the request pending", async () => {
  const flow = onboarding({ saveFails: settings => settings.onboarding_step === "done" });
  await flow.message("Find my train booking");
  await flow.message("Robin");
  await flow.message("yes");
  await assert.rejects(flow.message("skip"), /database unavailable/);
  assert.equal(flow.ctx.store.facts._onboarded, undefined);
  assert.equal(flow.saved().onboarding_step, "place");
  assert.equal(flow.saved().onboarding_pending, "Find my train booking");
  assert.equal(flow.calls.length, 0);
});

test("where they are: a guess from their calendar, and asked to guess, it says what gave it away", async () => {
  const flow = onboarding({ settings: { calendar_timezone: "Asia/Bangkok" } });
  await flow.message(null);
  await flow.message("Robin");
  await flow.message("yes");
  assert.equal(flow.sent.at(-1).text, "Nice to meet you, Alex. Robin it is. Is Bangkok where you are at the moment?");
  await flow.message("guess");
  assert.equal(flow.sent.at(-1).text, "My money's on Bangkok, going by your calendar running on Bangkok time. Close?");
  assert.notEqual(flow.saved().onboarding_step, "done", "a guess is not an answer");
  await flow.message("yes");
  assert.match(flow.sent.at(-1).text, /^Got it, Bangkok\./);
  assert.equal(flow.saved().onboarding_step, "done");
});

test("a chat app linked after introductions says hello as the same assistant, never asks again", async () => {
  const flow = onboarding({ settings: { onboarding_step: "done", preferred_name: "Alex", bot_name: "Robin" } });
  const { hereTooLine } = flow.exports();
  assert.equal(hereTooLine("Telegram"), "Hey Alex, it's Robin, here on Telegram too. Same memory as everywhere else, so carry on wherever suits.");
});

test("the first scan reads the calendar's timezone from its events, never from the calendar itself", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "onboarding.js"), "utf8");
  // Reading calendars/primary needs a calendar scope ClosedHand does not request (calendar.events only).
  assert.doesNotMatch(src, /calendar\/v3\/calendars\/primary["'`]/);
  assert.match(src, /saveProfileSetting\("calendar_timezone", calData\.timeZone\)/);
});
