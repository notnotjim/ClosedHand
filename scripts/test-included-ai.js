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
    "./phone-registration": { includedAiState: async () => ({ models: pick }) },
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
  // A key OpenRouter resets every month (Closedhand+) counts this month's use.
  global.fetch = async () => ({ ok: true, json: async () => ({ data: { limit: 20, usage: 31, usage_monthly: 4, limit_reset: "monthly", limit_remaining: 16 } }) });
  try { assert.deepEqual(await included.credit(settings), { limit: 20, used: 4, left: 16 }); } finally { global.fetch = real; }
});

test("what Closedhand says about Managed Models follows the plan, own provider first, never money", () => {
  const included = require("../lib/included-ai");
  const link = "https://alex.closedhand.ai/dashboard#settings";
  const first = { name: "first-month", ends_at: "2026-03-21T10:00:00.000Z", email: false };
  assert.equal(included.endingText(first, link, false, "Europe/London"),
    "Closedhand Managed Models, the LLM I've been using since you set me up, stays on until 21 March. After that, connect your own LLM provider in the dashboard (https://alex.closedhand.ai/dashboard#settings) (free ones work too), or keep Managed Models with Closedhand+.");
  assert.match(included.endingText({ ...first, email: true }, link, false, "Europe/London"), /with Closedhand\+, which also gives Closedhand's own email with no monthly limit\.$/);
  assert.match(included.endingText({ ...first, ends_at: "2026-03-21T23:30:00.000Z" }, link, false, "Asia/Tokyo"), /until 22 March\./, "the day where the person is");
  assert.equal(included.nearlyUsedText(first, link, false),
    "You've used most of the fair use of Closedhand Managed Models. To carry on without a break, connect your own LLM provider in the dashboard (https://alex.closedhand.ai/dashboard#settings) (free ones work too), or get Closedhand+ at closedhand.com/account.");
  assert.equal(included.nearlyUsedText({ name: "plus" }, "/dashboard#settings", true),
    "You've used most of this month's fair use of Closedhand+. To carry on without a break, carry on to the end of the month at [closedhand.com/account](https://closedhand.com/account), or connect your own LLM provider in the [dashboard](/dashboard#settings).");
  assert.doesNotMatch(included.nearlyUsedText({ name: "plus", extended: true }, link, false), /end of the month at/, "never offered twice in a month");
  assert.equal(included.usedUpText(first, link, false, "Europe/London"),
    "You've reached the fair use of Closedhand Managed Models, so I can't reply for now. Connect your own LLM provider in the dashboard (https://alex.closedhand.ai/dashboard#settings) (free ones work too) and I'll carry on, or get Closedhand+ at closedhand.com/account.");
  assert.equal(included.usedUpText({ name: "plus" }, link, false, "Europe/London"),
    `You've reached this month's fair use of Closedhand+, so I can't reply until ${included.day(included.nextMonth(), "Europe/London")}. Carry on to the end of the month at closedhand.com/account, or connect your own LLM provider in the dashboard (https://alex.closedhand.ai/dashboard#settings).`);
  assert.match(included.usedUpText({ name: "ended", was: "plus" }, link, false), /^Your Closedhand\+ has ended, so I can't reply for now\. .* or subscribe again at closedhand\.com\/account\.$/);
  assert.match(included.usedUpText({ name: "ended", was: "first-month" }, link, false), /^Closedhand Managed Models has ended, so I can't reply for now\. .* or keep Managed Models with Closedhand\+ at closedhand\.com\/account\.$/);
  assert.equal(included.usedUpText({ name: "ended" }, link, false), included.usedUpText({ name: "ended", was: "first-month" }, link, false), "unknown: the first month's words");
  assert.equal(included.usedUpText(undefined, link, false), included.usedUpText(first, link, false), "no plan known yet: as a first month");
  assert.equal(new Date(included.nextMonth(new Date("2026-12-31T23:00:00Z"))).toISOString(), "2027-01-01T00:00:00.000Z");
  assert.equal(included.period(first), "first-month:2026-03-21T10:00:00.000Z");
  assert.equal(included.period({ name: "plus" }, new Date("2026-03-05T00:00:00Z")), "plus:2026-03");
  assert.equal(included.period({ name: "plus", extended: true }, new Date("2026-03-05T00:00:00Z")), "plus:2026-03:extended");
  assert.equal(included.period({ name: "ended" }), null);
  assert.match(included.accountProblemText(402, null, false), /needs payment or more credit.*dashboard's Settings\.$/);
  assert.match(included.accountProblemText(401, null, false), /rejected Closedhand's API key/);
  const all = [included.endingText(first, null, false), included.nearlyUsedText(first, null, false), included.nearlyUsedText({ name: "plus" }, null, false),
    included.usedUpText(first, null, false), included.usedUpText({ name: "plus" }, null, false), included.usedUpText({ name: "ended", was: "plus" }, null, false),
    included.usedUpText({ name: "ended" }, null, false), included.accountProblemText(402, null, false), included.accountProblemText(401, null, false)];
  for (const text of all) assert.doesNotMatch(text, /\bAI\b(?! key)/, "the LLM is the LLM, never 'AI': " + text);
  for (const text of all.slice(0, 7)) assert.doesNotMatch(text, /\$|%|credit|tokens?\b|free until|trial/i, "no money, shares, tokens or trial words: " + text);
  // Their own provider is offered first wherever a Managed Models message offers both.
  for (const text of all.slice(0, 7)) {
    const own = text.indexOf("your own LLM provider"), plus = text.search(/Closedhand\+ at|with Closedhand\+|end of the month at|subscribe again/);
    if (own >= 0 && plus >= 0 && !/Closedhand\+\. To carry on|Closedhand\+, so I can't/.test(text)) assert.ok(own < plus, "own provider first: " + text);
  }
});

// The bot's half-hourly job (included-credit.js) over a settings store.
function messages(store, usage) {
  const included = require("../lib/included-ai");
  const told = [], notices = [];
  const job = load("lib/included-credit.js", {
    "./included-ai": { ...included, credit: async () => ({ limit: 20, used: usage.now, left: 20 - usage.now }) },
    "./admin": { getAdminUserId: () => "admin" },
    "../user-store": { UserStore: { load: async () => ({ profile: { settings: structuredClone(store.box.settings) } }) } },
    "./connection-alert": {
      notifyAboutAi: async (id, s, textFor) => { told.push(textFor("https://alex.closedhand.ai/dashboard#settings", false)); return true; },
      notifyFromClosedhand: async (id, s, text) => { notices.push(text); return true; },
    },
    "./timezone": { getUserTimezone: () => "Europe/London" },
    "./db": { supabase: store.supabase }, "./settings-patch": store.patch,
  });
  return { job, told, notices };
}

test("a first month: most of the fair use is said once, and its end once, five days before", async () => {
  const ends = new Date(Date.now() + 10 * 86400000).toISOString();
  const store = settingsStore({ included_api_key: policy.sealKey(KEY), model_config: { included: true }, included_ai: { models: MODELS, plan: { name: "first-month", ends_at: ends, email: false } } });
  const usage = { now: 14 };
  const { job, told } = messages(store, usage);
  assert.equal(await job.check(), 0, "70% used, ten days left: nothing said");
  usage.now = 16.5;
  assert.equal(await job.check(), 1);
  assert.match(told[0], /^You've used most of the fair use of Closedhand Managed Models\./);
  assert.equal(await job.check(), 0, "said once");
  store.box.settings.included_ai.plan.ends_at = new Date(Date.now() + 4 * 86400000).toISOString();
  store.box.settings.included_told.nearly = "first-month:" + store.box.settings.included_ai.plan.ends_at;
  assert.equal(await job.check(), 1);
  assert.match(told[1], /^Closedhand Managed Models, the LLM I've been using since you set me up, stays on until \d{1,2} [A-Z][a-z]+\. After that, connect your own LLM provider/);
  assert.equal(await job.check(), 0, "the end is said once");
  assert.equal(told.length, 2);
});

test("Closedhand+: most of the fair use is said once a month, and again after carrying on", async () => {
  const store = settingsStore({ included_api_key: policy.sealKey(KEY), model_config: { included: true }, included_ai: { models: MODELS, plan: { name: "plus", renews_at: "2026-04-01T00:00:00.000Z", email: true } } });
  const usage = { now: 17 };
  const { job, told } = messages(store, usage);
  assert.equal(await job.check(), 1);
  assert.match(told[0], /^You've used most of this month's fair use of Closedhand\+\. To carry on without a break, carry on to the end of the month at closedhand\.com\/account/);
  assert.equal(await job.check(), 0);
  store.box.settings.included_ai.plan.extended = true;
  assert.equal(await job.check(), 1, "a new ceiling, a new notice");
  assert.doesNotMatch(told[1], /end of the month at/);
  // On their own LLM provider nothing about Managed Models is said.
  store.box.settings.model_config = { included: false };
  store.box.settings.included_told = {};
  assert.equal(await job.check(), 0);
});

test("notices closedhand.com sent this account go out once, whatever LLM is in use", async () => {
  const store = settingsStore({ model_config: { roles: {} }, included_notices: [{ id: "first-months-75", text: "Free first months this month are at 75% of what you set." }] });
  const { job, notices } = messages(store, { now: 0 });
  assert.equal(await job.check(), 1);
  assert.deepEqual(notices, ["Free first months this month are at 75% of what you set."]);
  assert.deepEqual(store.box.settings.included_notices_sent, ["first-months-75"]);
  assert.equal(await job.check(), 0, "never twice");
  assert.equal(notices.length, 1);
});

test("when the AI account refuses, the chat says so in fixed words instead of 'something went wrong'", () => {
  const engine = fs.readFileSync(path.join(root, "lib/engine.js"), "utf8");
  assert.match(engine, /error\.status === 402 \|\| error\.status === 401/);
  assert.match(engine, /if \(refused\) return aiAccountRefused\(refused\);/);
  assert.match(engine, /if \(included\.inUse\(settings\)\) return status === 402 \? included\.usedUpText\(settings\.included_ai\?\.plan, link, web, require\("\.\/timezone"\)\.getUserTimezone\(ctx\.activeUserStore\)\)/);
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

function refresher(store, answer) {
  return load("webapp/included-ai-setup.js", {
    "./db": { supabase: store.supabase }, "./admin": { getAdminUserId: () => "admin" }, "./settings-patch": store.patch, "./model-policy": policy,
    "./model-config": { prepare: async (input) => prepared(input), withConfig: (settings, config) => ({ ...settings, model_config: policy.sealConfig(config), llm_provider: "custom" }) },
    "./phone-registration": { includedAiState: async () => answer.now },
  }, { fetch: async () => ({ ok: true, json: async () => ({ data: { name: "DeepSeek: DeepSeek V4.1 Flash" } }) }) });
}

test("each hour: the plan is kept, a waiting key is taken sealed, and notices are kept once for the bot", async () => {
  const store = settingsStore({});
  const notice = { id: "first-months-75", text: "Free first months this month are at 75% of what you set." };
  const answer = { now: { models: MODELS, plan: { name: "plus", renews_at: "2026-04-01T00:00:00Z", email: true, ignored: "x" }, key: KEY, notices: [notice, { id: "bad id!", text: "x" }] } };
  const ai = refresher(store, answer);
  assert.equal(await ai.refresh(), true);
  await until(() => store.box.settings.model_config);
  assert.match(store.box.settings.included_api_key, /^enc:v1:/);
  assert.ok(!JSON.stringify(store.box.settings).includes(KEY), "the key is never stored readable");
  assert.equal(store.box.settings.model_config.included, true, "set up as a claim's key is");
  assert.deepEqual(store.box.settings.included_ai.plan, { name: "plus", email: true, renews_at: "2026-04-01T00:00:00.000Z" });
  assert.deepEqual(store.box.settings.included_notices, [notice], "only well-formed notices");
  // The same answer again, without a key: nothing new.
  answer.now = { models: MODELS, plan: answer.now.plan, notices: [notice] };
  assert.equal(await ai.refresh(), false);
  assert.equal(store.box.settings.included_notices.length, 1, "kept once");
  // Sent by the bot: let go, and never kept again.
  store.box.settings.included_notices_sent = [notice.id];
  assert.equal(await ai.refresh(), true);
  assert.deepEqual(store.box.settings.included_notices, []);
  assert.equal(await ai.refresh(), false);
  // An ended plan remembers what it was; a plan closedhand.com names oddly changes nothing.
  answer.now = { models: MODELS, plan: { name: "ended", email: false } };
  assert.equal(await ai.refresh(), true);
  assert.deepEqual(store.box.settings.included_ai.plan, { name: "ended", email: false, was: "plus" });
  answer.now = { models: MODELS, plan: { name: "free" } };
  assert.equal(await ai.refresh(), false);
  assert.equal(store.box.settings.included_ai.plan.name, "ended");
  // A computer that never asked for a personal URL asks nothing.
  answer.now = null;
  assert.equal(await ai.refresh(), false);
  assert.match(fs.readFileSync(path.join(root, "webapp/included-ai-setup.js"), "utf8"), /setInterval\(run, 60 \* 60 \* 1000\)/, "every hour");
  assert.match(fs.readFileSync(path.join(root, "webapp/phone-registration.js"), "utf8"), /if \(!\(await getConf\('PHONE_INSTALL_ID'\)\)\) return null;\n  return \(await call\('included-ai', 'GET'\)\) \|\| null;/);
});

// The dashboard's Settings line for Managed Models, run as the page runs it.
function settingsDetail() {
  const page = fs.readFileSync(path.join(root, "webapp/views/dashboard.html"), "utf8");
  const start = page.indexOf("    function planDay(");
  const end = page.indexOf("    async function loadIncludedAi()");
  assert.ok(start > 0 && end > start);
  const document = { createElement: () => ({ style: {} }) };
  const box = { document, Date, out: null };
  vm.runInNewContext(page.slice(start, end) + "\nout = includedDetail;", box);
  return (data) => box.out(data).map((p) => typeof p === "string" ? p : `[${p.textContent}](${p.href})`).join("");
}

test("Settings shows the plan, never money or how much is used", () => {
  const detail = settingsDetail();
  const day = (days) => new Date(Date.now() + days * 86400000).toISOString();
  assert.equal(detail({ plan: { name: "first-month", ends_at: day(20) } }), "", "a first month says nothing until its last week");
  assert.match(detail({ plan: { name: "first-month", ends_at: day(5) } }), /^Closedhand Managed Models stays on until \d{1,2} [A-Z][a-z]+\. After that, connect your own LLM provider \(free ones work too\), or keep Managed Models with Closedhand\+\.$/);
  assert.match(detail({ plan: { name: "plus", renews_at: "2026-04-01T12:00:00Z" } }), /^Closedhand\+ renews on 1 April\. \[Manage Closedhand\+\]\(https:\/\/closedhand\.com\/account\)$/);
  assert.match(detail({ plan: { name: "plus", ends_at: "2026-04-01T12:00:00Z" } }), /^Closedhand\+ ends on 1 April\./);
  assert.match(detail({ plan: { name: "plus", renews_at: "2026-04-01T12:00:00Z" }, nearly: true }), / You've used most of this month's fair use\. \[Carry on to the end of the month\]\(https:\/\/closedhand\.com\/account\)$/);
  assert.doesNotMatch(detail({ plan: { name: "plus", renews_at: "2026-04-01T12:00:00Z", extended: true }, nearly: true }), /Carry on to the end of the month/);
  assert.match(detail({ plan: { name: "ended", was: "plus" } }), /^Closedhand Managed Models has ended\. Connect your own LLM provider \(free ones work too\), or keep Managed Models with Closedhand\+\. \[Subscribe again\]/);
  const page = fs.readFileSync(path.join(root, "webapp/views/dashboard.html"), "utf8");
  assert.doesNotMatch(page, /shareText|usage-included|of your free use left|free until/i);
  const server = fs.readFileSync(path.join(root, "webapp/server.js"), "utf8");
  const route = server.slice(server.indexOf('app.get("/api/included-ai"'), server.indexOf('app.post("/api/included-ai/use"'));
  assert.doesNotMatch(route, /credit:/, "no amount reaches the page");
  assert.match(route, /nearly: !!credit && credit\.used >= credit\.limit \* included\.NEARLY_USED/);
});

test("Usage on Managed Models shows what Closedhand did, without prices, tokens or costs", () => {
  const page = fs.readFileSync(path.join(root, "webapp/views/dashboard.html"), "utf8");
  assert.match(page, /usageManaged = managed;\n\s+document\.getElementById\('usage-sub'\)\.textContent = managed \? 'What Closedhand has been doing\.' : "What Closedhand's AI use costs you\. Add your provider's prices below to see it\.";/);
  assert.match(page, /if \(usageManaged\) \{ el\.innerHTML = ''; return; \}/, "no prices to enter");
  assert.match(page, /const amount = r => usageManaged \? r\.calls : r\.tokens_in \+ r\.tokens_out;/, "counted by how often, not tokens");
  const tiles = page.slice(page.indexOf("if (usageManaged) return '<div class=\"usage-tile\">'"), page.indexOf("return '<div class=\"usage-tile\">' +\n          '<div class=\"t-name\">"));
  assert.ok(tiles.length > 0);
  assert.doesNotMatch(tiles, /fmtTokens|t-cost|fmtCost/);
  assert.match(page, /notes\.length && !usageManaged \?/, "no spend insights");
  assert.match(page, /\(usageManaged \? '' : '<th class="num">Tokens in<\/th><th class="num">Tokens out<\/th>'\)/);
});
