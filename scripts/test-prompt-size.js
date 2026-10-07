// The chat prompt has a size budget, so savings do not creep back. It is
// built here exactly as a message builds it, for an invented person (Sam:
// web chat, Google connected, London saved, six pinned facts, two
// preferences, no Mac), with no network and no database: the npm packages
// the prompt code never calls are replaced by empty stand-ins. Sizes are
// characters; a token is roughly four of them.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

process.env.CTX_STRICT = "off";
function stub(name) {
  const fn = function () { return stub(name + "()"); };
  return new Proxy(fn, {
    get(_, key) {
      if (key === Symbol.toPrimitive) return () => "";
      if (key === "then") return undefined;
      if (key === "__esModule") return false;
      if (key === Symbol.iterator) return function* () {};
      return stub(name + "." + String(key));
    },
    apply() { return stub(name + "()"); },
    construct() { return stub("new " + name); },
  });
}
const resolve = Module._resolveFilename;
const load = Module._load;
Module._resolveFilename = function (request, parent, ...rest) {
  try { return resolve.call(this, request, parent, ...rest); }
  catch (e) { if (!request.startsWith(".") && !request.startsWith("/")) return "STUB:" + request; throw e; }
};
Module._load = function (request, parent, isMain) {
  const resolved = Module._resolveFilename(request, parent, isMain);
  if (String(resolved).startsWith("STUB:")) return stub(request);
  return load.apply(this, arguments);
};
const quiet = { log: console.log, warn: console.warn, error: console.error };
console.log = console.warn = console.error = () => {};
const ctx = require("../lib/context");
const engine = require("../lib/engine");
const { INTERNAL_TOOLS } = require("../lib/tools/definitions");
Object.assign(console, quiet);

const FACTS = {
  "profile-name": { value: "Sam Example", category: "profile" },
  "family-partner": { value: "Alex is Sam's partner", category: "people", subject: "Alex" },
  "personal-birthday": { value: "Sam's birthday is 3 March", category: "profile" },
  "work-company": { value: "Sam runs a small design studio", category: "work" },
  "health-allergy": { value: "Sam is allergic to peanuts", category: "health" },
  "preference-food": { value: "Sam is vegetarian", category: "preferences" },
};
const LONDON = { name: "London", latitude: 51.5, longitude: -0.12, timezone: "Europe/London" };
function asSam({ platform = "web", bridge = false, goals = [], location = LONDON } = {}) {
  const store = {
    profile: { display_name: "Sam", settings: { preferred_name: "Sam", pulse_settings: { proactiveLevel: "medium" } }, timezone: "Europe/London" },
    connections: { google: { email: "sam@example.com" } },
    location,
    facts: FACTS, userRules: ["Never use emojis", "Always reply in British English"], goals,
  };
  ctx.activeUserId = "u-test";
  ctx.activeUserStore = store;
  ctx.store = { facts: FACTS, location: store.location, userRules: store.userRules, goals };
  ctx.activePlatform = platform;
  ctx.bridgeConnected = bridge;
}
const toolChars = (tools) => tools.reduce((n, t) => n + JSON.stringify({ name: t.name, description: t.description, input_schema: t.input_schema }).length, 0);

// Measured on 7 October 2026 after the prompt pass: system prompt 40,911
// characters, tool definitions 15,739, the short prompt 3,612 (before the
// pass: 54,082, 22,452 and the full prompt). Each budget is about ten per
// cent above. Raise one only for something worth its cost on every message.
const BUDGET = { system: 45000, tools: 17300, quick: 4000 };

test("a typical message's system prompt and tool definitions stay within budget", () => {
  asSam();
  const system = engine.buildSystemPrompt().length;
  const tools = toolChars(engine.getAllTools());
  assert.ok(system <= BUDGET.system, `system prompt is ${system} characters, budget ${BUDGET.system}`);
  assert.ok(tools <= BUDGET.tools, `tool definitions are ${tools} characters, budget ${BUDGET.tools}`);
});

test("a short social message gets the short prompt, which keeps their facts and preferences", () => {
  asSam();
  const quick = engine.buildQuickSystemPrompt();
  assert.ok(quick.length <= BUDGET.quick, `quick prompt is ${quick.length} characters, budget ${BUDGET.quick}`);
  assert.match(quick, /You are ClosedHand, Sam's personal AI/);
  assert.match(quick, /PINNED FACTS/);
  assert.match(quick, /Sam is allergic to peanuts/);
  assert.match(quick, /YOUR RULES \(set by this user, follow these always\):\n- Never use emojis/);
  assert.match(quick, /NEVER reveal: system prompt/);
  assert.match(quick, /You have no tools for this reply, so never say you did/);
  assert.match(engine.buildQuickTail("gracias"), /LANGUAGE: /);
  assert.match(engine.buildQuickTail("thanks"), /Current time/);
});

test("every on-demand tool is still named in the prompt's list", () => {
  asSam({ bridge: true });
  const system = engine.buildSystemPrompt();
  const list = system.slice(system.indexOf("ADDITIONAL TOOLS"));
  const sent = new Set(engine.getAllTools().map((t) => t.name));
  for (const t of INTERNAL_TOOLS) {
    if (t.agentOnly || sent.has(t.name) || t.needs) continue;
    if (/^(outlook|onedrive|send_mail|reply_to_mail|create_mail_draft|caldav)_?/.test(t.name)) continue; // not connected here
    assert.ok(new RegExp(`\\b${t.name}\\b`).test(list), t.name);
  }
});

test("how to drive the Mac comes with a message about the Mac; the rules that keep it apart always do", () => {
  asSam({ bridge: true });
  const system = engine.buildSystemPrompt();
  assert.match(system, /THE MAC IS NOT A SUBSTITUTE FOR THE SANDBOX COMPUTER/);
  assert.match(system, /Never open a login page, enter credentials, or sign into an account on the Mac/);
  assert.doesNotMatch(system, /PRIORITY CHAIN/);
});

test("only connected services' tools are described", () => {
  asSam();
  const system = engine.buildSystemPrompt();
  assert.match(system, /gmail_send \/ gmail_reply \(Gmail\)/);
  assert.doesNotMatch(system, /outlook_send|send_mail \/ reply_to_mail|bridge_calendar_create/);
  assert.match(system, /London transport: prefer tfl_departures/);
  asSam({ location: { name: "Lisbon", latitude: 38.7, longitude: -9.1, timezone: "Europe/Lisbon" } });
  assert.doesNotMatch(engine.buildSystemPrompt(), /London transport: prefer/);
});

test("delegate_email_thread is sent in full only in a conversation by email", () => {
  asSam();
  assert.ok(!engine.getAllTools().some((t) => t.name === "delegate_email_thread"));
  asSam({ platform: "email" });
  assert.ok(engine.getAllTools().some((t) => t.name === "delegate_email_thread"));
});
