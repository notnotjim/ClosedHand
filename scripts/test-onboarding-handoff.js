const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function onboarding({ env = { DB_DRIVER: "pg" }, engineFails = false, sendFails = false, saveFails = false, settings = {} } = {}) {
  const conversation = [], sent = [], calls = [];
  const ctx = { store: { facts: {} }, activeUserStore: { userId: "fixture-user", profile: { display_name: "Alex Example", settings } } };
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
    "./flights": {}, "./flights-scheduler": {}, "./llm": {},
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
    message: text => sandbox.module.exports.handleOnboardingMessage("fixture-user", "fixture-chat", text),
    reload: () => { ctx.activeUserStore.profile.settings = structuredClone(saved); },
  };
}

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

test("onboarding describes the host independently of the phone reading the message", async () => {
  for (const env of [{ DB_DRIVER: "pg" }, {}]) {
    const flow = onboarding({ env });
    await flow.message("Hi");
    await finish(flow);
    const signoff = flow.sent.at(-1).text;
    assert.doesNotMatch(signoff, /this machine|this computer|Nothing reaches us|only thing that leaves|can't be read by anyone|never used for training/);
    assert.match(signoff, /requests and relevant context/);
    assert.match(signoff, env.DB_DRIVER ? /computer or server running ClosedHand/ : /ClosedHand's hosted service/);
  }
});


test("a failed completion write keeps onboarding open and the request pending", async () => {
  const flow = onboarding({ saveFails: settings => settings.onboarding_step === "done" });
  await flow.message("Find my train booking");
  await flow.message("Robin");
  await flow.message("yes");
  await assert.rejects(flow.message("skip"), /database unavailable/);
  assert.equal(flow.ctx.store.facts._onboarded, undefined);
  assert.equal(flow.saved().onboarding_step, "ask_location");
  assert.equal(flow.saved().onboarding_pending, "Find my train booking");
  assert.equal(flow.calls.length, 0);
});
