// The AI that comes with Closedhand on the person's computer: the key a
// personal URL claim brings is kept sealed and never handed on, it becomes the
// models unless the person set up their own AI account, what is left is read
// from OpenRouter with the key itself, the person is told once when most of it
// is used, and a refusal is said in fixed words. Invented keys and people only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY || crypto.randomBytes(32).toString("base64");
const root = path.join(__dirname, "..");
const policy = require("../lib/model-policy");
const KEY = "sk-or-v1-" + "ab".repeat(32);
const MODELS = { chat: "deepseek/deepseek-v4.1-flash", background: "deepseek/deepseek-v4.1-flash" };
const tick = () => new Promise((r) => setImmediate(r));
async function until(check) { for (let i = 0; i < 50 && !check(); i++) await tick(); }

function load(file, stubs, extra = {}) {
  const mod = { exports: {} };
  const sandbox = { module: mod, exports: mod.exports, console: { log() {}, error() {}, warn() {} }, URL, URLSearchParams, Buffer, AbortSignal, Date, JSON, Math, Promise, setTimeout, setInterval, setImmediate,
    process: { env: { PORT: "3000" } }, ...extra,
    require: (name) => { if (name in stubs) return stubs[name]; throw new Error("unexpected require " + name); } };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), "utf8"), sandbox);
  return mod.exports;
}

// The person's settings, changed only the way settings-patch.js changes them.
function settingsStore(initial = {}) {
  const box = { settings: structuredClone(initial) };
  const supabase = { from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { settings: structuredClone(box.settings) } }), maybeSingle: async () => ({ data: { settings: structuredClone(box.settings) } }) }) }) }) };
  const patch = { patchSettings: async (db, id, { set = {}, unset = [] } = {}) => { Object.assign(box.settings, structuredClone(set)); for (const k of unset) delete box.settings[k]; return box.settings; },
    diff: (before, after) => { const set = {}, unset = []; for (const k of Object.keys(after)) if (JSON.stringify(after[k]) !== JSON.stringify(before[k])) set[k] = after[k]; for (const k of Object.keys(before)) if (!(k in after)) unset.push(k); return { set, unset }; } };
  return { box, supabase, patch };
}

test("a claim's AI key is kept by the claim and never handed on", async () => {
  const received = [], values = {};
  const request = async (url) => ({ ok: true, json: async () => ({ state: "pending", url: "https://alex.closedhand.ai", included_ai: { key: KEY, models: MODELS } }) });
  const registration = load("webapp/phone-registration.js", {
    "node:crypto": crypto,
    "./config": { getConf: async (k) => values[k], setConf: async (p) => Object.assign(values, p) },
    "./crypto-tokens": { encryptString: (x) => "enc:v1:" + x, decryptString: (x) => x?.replace(/^enc:v1:/, "") },
    "./included-ai-setup": { receive: async (x) => received.push(x) },
  }, { fetch: request });
  const data = await registration.claim("ABC234");
  assert.equal(data.included_ai, undefined, "the answer carries no key");
  assert.ok(!JSON.stringify(data).includes(KEY));
  assert.deepEqual(received, [{ key: KEY, models: MODELS }]);
  const microsoft = await registration.claimWithMicrosoft("id-token");
  assert.equal(microsoft.included_ai, undefined);
  assert.equal(received.length, 2);
});

function setup(store, prepare) {
  return load("webapp/included-ai-setup.js", {
    "./db": { supabase: store.supabase }, "./admin": { getAdminUserId: () => "admin" }, "./settings-patch": store.patch, "./model-policy": policy,
    "./model-config": { prepare, withConfig: (settings, config) => ({ ...settings, model_config: policy.sealConfig(config), llm_provider: "custom" }) },
  }, { fetch: async () => ({ ok: false }) });
}
const prepared = (input) => ({ version: 1, connections: { primary: { provider: "openrouter", backend: "custom", baseUrl: "https://openrouter.ai/api/v1", apiKey: input.primary.apiKey } },
  roles: { chat: { connection: "primary", model: input.model }, background: { connection: "primary", model: input.backgroundModel }, vision: null } });

test("the key becomes the models, sealed, reading images with the same model, support on it too", async () => {
  const store = settingsStore({ preferred_name: "Mira" });
  let asked;
  const ai = setup(store, async (input) => { asked = input; return prepared(input); });
  assert.equal(await ai.receive({ key: KEY, models: MODELS }), true);
  await until(() => store.box.settings.model_config);
  assert.match(store.box.settings.included_api_key, /^enc:v1:/);
  assert.ok(!JSON.stringify(store.box.settings).includes(KEY), "the key is never stored readable");
  assert.equal(store.box.settings.model_config.included, true);
  assert.deepEqual({ provider: asked.primary.provider, model: asked.model, backgroundMode: asked.backgroundMode, visionMode: asked.visionMode }, { provider: "openrouter", model: MODELS.chat, backgroundMode: "same", visionMode: "same" });
  assert.equal(policy.getRole(store.box.settings, "chat").apiKey, KEY, "it opens only where a role is used");
  assert.equal(store.box.settings.preferred_name, "Mira", "nothing else changes");
});

test("when the image check fails it is used without images, never not at all", async () => {
  const store = settingsStore({});
  const tried = [];
  const ai = setup(store, async (input) => {
    tried.push(input.visionMode);
    if (input.visionMode !== "off") throw Object.assign(new Error("The image check did not pass."), { visionNeeded: true });
    return prepared(input);
  });
  assert.equal(await ai.receive({ key: KEY, models: MODELS }), true);
  await until(() => store.box.settings.model_config);
  assert.deepEqual(tried, ["same", "off"]);
  assert.equal(store.box.settings.model_config.included, true);
  assert.equal(store.box.settings.included_ai.error, undefined);
});

test("a person's own AI account stays; the included key waits beside it", async () => {
  const own = { version: 1, connections: { primary: { provider: "anthropic", backend: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "enc:v1:own" } }, roles: { chat: { connection: "primary", model: "claude-x" }, background: { connection: "primary", model: "claude-x" }, vision: null } };
  const store = settingsStore({ model_config: own, llm_provider: "anthropic" });
  let checked = false;
  const ai = setup(store, async (input) => { checked = true; return prepared(input); });
  await ai.receive({ key: KEY, models: MODELS });
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(checked, false, "their setup is not even checked against");
  assert.deepEqual(store.box.settings.model_config, own);
  assert.match(store.box.settings.included_api_key, /^enc:v1:/);
  // Asked for, it switches.
  assert.equal(await ai.use(), true);
  assert.equal(store.box.settings.model_config.included, true);
});

test("a check that fails is recorded, so setup asks for an AI account instead of waiting", async () => {
  const store = settingsStore({});
  const ai = setup(store, async () => { throw new Error("The model provider returned HTTP 503."); });
  await ai.receive({ key: KEY, models: MODELS });
  await until(() => store.box.settings.included_ai?.error);
  assert.match(store.box.settings.included_ai.error, /503/);
  assert.equal(store.box.settings.model_config, undefined);
});

test("Closedhand's pick is followed: a changed model is switched to and named", async () => {
  const store = settingsStore({});
  let pick = MODELS, asked = 0;
  const realFetch = global.fetch;
  const ai = load("webapp/included-ai-setup.js", {
    "./db": { supabase: store.supabase }, "./admin": { getAdminUserId: () => "admin" }, "./settings-patch": store.patch, "./model-policy": policy,
    "./model-config": { prepare: async (input) => { asked++; return prepared(input); }, withConfig: (settings, config) => ({ ...settings, model_config: policy.sealConfig(config), llm_provider: "custom" }) },
    "./phone-registration": { includedAiModels: async () => pick },
  }, { fetch: async (url) => ({ ok: true, json: async () => ({ data: { name: url.includes("qwen") ? "Qwen: Qwen3 Next" : "DeepSeek: DeepSeek V4.1 Flash" } }) }) });
  await ai.receive({ key: KEY, models: MODELS });
  await until(() => store.box.settings.model_config);
  assert.equal(store.box.settings.included_ai.name, "DeepSeek V4.1 Flash", "the name people know it by");
  assert.equal(await ai.refresh(), false, "nothing changed, nothing done");
  pick = { chat: "qwen/qwen3-next", background: "qwen/qwen3-next" };
  assert.equal(await ai.refresh(), true);
  assert.equal(store.box.settings.included_ai.name, "Qwen3 Next");
  assert.equal(policy.getRole(store.box.settings, "chat").model, "qwen/qwen3-next", "switched over");
  assert.equal(asked, 2);
  global.fetch = realFetch;
});

test("only an OpenRouter key and a model name are taken", async () => {
  const store = settingsStore({});
  const ai = setup(store, async (input) => prepared(input));
  for (const bad of [null, { key: "sk-ant-x", models: MODELS }, { key: KEY, models: { chat: "../etc" } }, { key: KEY + "\n", models: MODELS }]) assert.equal(await ai.receive(bad), false);
  assert.deepEqual(store.box.settings, {});
});

test("what is left is read from OpenRouter with the person's own key", async () => {
  const included = require("../lib/included-ai");
  const settings = { included_api_key: policy.sealKey(KEY), model_config: { included: true } };
  const seen = [];
  const real = global.fetch;
  global.fetch = async (url, opts) => { seen.push({ url, opts }); return { ok: true, json: async () => ({ data: { limit: 10, usage: 8.5, limit_remaining: 1.5 } }) }; };
  try {
    assert.deepEqual(await included.credit(settings), { limit: 10, used: 8.5, left: 1.5 });
    assert.equal(seen[0].url, "https://openrouter.ai/api/v1/key");
    assert.equal(seen[0].opts.headers.Authorization, "Bearer " + KEY);
    assert.equal(seen[0].opts.headers["X-Title"], "Closedhand");
    global.fetch = async () => ({ ok: false, status: 401 });
    assert.equal(await included.credit(settings), null, "unknown, not zero, when it can't be read");
  } finally { global.fetch = real; }
  assert.equal(included.inUse(settings), true);
  assert.equal(included.inUse({ included_api_key: "x", model_config: { roles: {} } }), false, "their own account, not the included one");
  assert.equal(included.usedUpText("https://alex.closedhand.ai/dashboard#settings", false),
    "Your free use of Closedhand Managed Models has run out, so I can't reply for now. Connect your own LLM provider in the dashboard (https://alex.closedhand.ai/dashboard#settings) and I'll carry on.");
  assert.match(included.nearlyUsedText("/dashboard#settings", true), /in the \[dashboard\]\(\/dashboard#settings\)\.$/);
  assert.match(included.accountProblemText(402, null, false), /needs payment or more credit.*dashboard's Settings\.$/);
  assert.match(included.accountProblemText(401, null, false), /rejected Closedhand's API key/);
  for (const text of [included.nearlyUsedText(null, false), included.usedUpText(null, false), included.accountProblemText(402, null, false), included.accountProblemText(401, null, false)])
    assert.doesNotMatch(text, /\bAI\b(?! key)/, "the LLM is the LLM, never 'AI': " + text);
});

test("the person is told once, when most of the credit is used", async () => {
  const included = require("../lib/included-ai");
  const store = settingsStore({ included_api_key: policy.sealKey(KEY), model_config: { included: true }, included_ai: { models: MODELS } });
  const told = [];
  let usage = 7;
  const job = load("lib/included-credit.js", {
    "./included-ai": { ...included, credit: async () => ({ limit: 10, used: usage, left: 10 - usage }) },
    "./admin": { getAdminUserId: () => "admin" },
    "../user-store": { UserStore: { load: async () => ({ profile: { settings: structuredClone(store.box.settings) } }) } },
    "./connection-alert": { notifyAboutAi: async (id, s, textFor) => { told.push(textFor("https://alex.closedhand.ai/dashboard#settings", false)); return true; } },
    "./db": { supabase: store.supabase }, "./settings-patch": store.patch,
  });
  assert.equal(await job.check(), false, "70% used: nothing said");
  usage = 8.2;
  assert.equal(await job.check(), true);
  assert.equal(told.length, 1);
  assert.match(told[0], /^You've used most of your free use of Closedhand Managed Models\./);
  assert.ok(store.box.settings.included_ai.warned);
  usage = 9.5;
  assert.equal(await job.check(), false, "said once");
  assert.equal(told.length, 1);
});

test("when the AI account refuses, the chat says so in fixed words instead of 'something went wrong'", () => {
  const engine = fs.readFileSync(path.join(root, "lib/engine.js"), "utf8");
  assert.match(engine, /error\.status === 402 \|\| error\.status === 401/);
  assert.match(engine, /if \(refused\) return aiAccountRefused\(refused\);/);
  assert.match(engine, /included\.inUse\(ctx\.activeUserStore\?\.profile\?\.settings\)\) return status === 402 \? included\.usedUpText\(link, web\)/);
  // OpenRouter credits the traffic to Closedhand, in both copies.
  for (const f of ["lib/model-wire.js", "webapp/model-wire.js"]) assert.match(fs.readFileSync(path.join(root, f), "utf8"), /"HTTP-Referer": "https:\/\/closedhand\.com", "X-Title": "Closedhand"/);
});

test("Closedhand speaks as itself: it names its LLM only when asked, explains how it is built, never speaks as the LLM", () => {
  const engine = fs.readFileSync(path.join(root, "lib/engine.js"), "utf8");
  assert.match(engine, /your LLM is one part of you\. Never speak as it or claim its name, maker or knowledge cutoff\./);
  assert.match(engine, /Name your LLM only if \$\{userName\} asks: "I'm \$\{botName\}\. My LLM right now is/);
  assert.match(engine, /Never show or repeat an API key, token or password, theirs or yours \(the Managed Models key too\)/);
  assert.match(engine, /About Closedhand the company, say only what closedhand\.com publishes; for its costs, plans, other users or systems, point to support@closedhand\.com/);
  assert.match(engine, /let prompt = identityLines\(\) \+ builtLines\(\) \+/, "how it is built goes in the full prompt only");
  assert.match(engine, /HOW YOU ARE BUILT \(public: Closedhand is open source/);
  assert.match(engine, /if \(pick && settings\.model_config\?\.included\) return `\$\{settings\.included_ai\?\.name \|\| pick\.model\} \(Closedhand Managed Models/);
  assert.doesNotMatch(engine, /technical architecture/, "how it is built is not a secret");
  assert.doesNotMatch(engine, /closedhand\.com never sees/, "remote dashboard pages pass through the relay");
});
