// "Run it here" end to end against stand-ins (run-here-fixtures.js): one
// click downloads, starts, checks, times and switches a job; a crashed
// runner comes back while the provider answers; jobs sharing a runner keep
// its image part and largest context, also after a restart; two clicks at
// once don't corrupt each other; saving the models keeps or tidies; and a
// record or file that would reach outside the models folder is refused.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY || crypto.randomBytes(32).toString("base64");
const { SMALL, hub, runnerFarm, profileStore, sha256 } = require("./run-here-fixtures");
const fit = require("../webapp/run-here-fit");
const runHere = require("../webapp/run-here");
const policy = require("../lib/model-policy");
const wire = require("../lib/model-wire");

const MODEL = "examplelab/example-1.5b";
const pick = (model = MODEL) => ({ connection: "primary", model, capabilities: { tools: true } });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await wait(25); }
  throw new Error("timed out waiting");
}

function setup(roles, { force = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-here-flow-"));
  const bin = path.join(dir, "llama-server");
  fs.writeFileSync(bin, "");
  const sandbox = path.join(dir, "sandbox-exec");
  fs.writeFileSync(sandbox, "");
  const env = { ...process.env };
  Object.assign(process.env, { MODELS_DIR: path.join(dir, "models"), LLAMA_SERVER_BIN: bin, CLOSEDHAND_DESKTOP: "1" });
  if (force) process.env.RUN_HERE_FORCE = "1"; else delete process.env.RUN_HERE_FORCE;
  const store = profileStore({ model_config: { version: 1,
    connections: { primary: { provider: "openrouter", backend: "custom", baseUrl: "https://openrouter.ai/api/v1", apiKey: policy.sealKey("router-key") } },
    roles: { chat: null, background: null, vision: null, ...roles } } });
  let state = {};
  const farm = runnerFarm();
  const h = hub();
  runHere.configure({ fetch: h.impl, spawn: farm.spawn, supabase: store.supabase, getAdminUserId: () => "u", platform: "darwin", arch: "arm64",
    hardware: () => ({ chip: fit.chipOf("Apple M4 Max"), memoryBytes: 64e9, freeDiskBytes: 900e9 }),
    state: { read: async () => state, write: async (s) => { state = s; } }, restartDelays: [50], sandboxExec: sandbox, retryMs: 10 });
  const files = () => { const out = []; const walk = (d) => { try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : out.push(path.relative(path.join(dir, "models", "llm"), p)); } } catch (_) {} }; walk(path.join(dir, "models", "llm")); return out.sort(); };
  return { dir, bin, sandbox, store, farm, hub: h, state: () => state, files, settings: () => store.db.settings,
    done: () => { runHere.stopAll(); fs.rmSync(dir, { recursive: true, force: true }); process.env = env; } };
}
// A stand-in for the provider, so a fallback can be seen.
async function provider() {
  const asked = [];
  const server = http.createServer((req, res) => { asked.push(req.url); res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "from the provider" }, finish_reason: "stop" }], usage: {} })); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return { asked, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => server.close() };
}
async function ask(settings, job, providerUrl) {
  const conn = policy.getRole(settings, job);
  if (providerUrl && conn.fallback) conn.fallback.baseUrl = providerUrl;
  return wire.responseText(await wire.request(conn, { model: conn.model, max_tokens: 16, messages: [{ role: "user", content: "hello" }] })).trim();
}

test("one click: download, the makers' template, a checked and timed runner, then the switch", async () => {
  const t = setup({ chat: pick(), background: pick() });
  try {
    const offered = await runHere.offers(t.settings());
    assert.deepEqual(Object.keys(offered).sort(), ["background", "chat"]);
    assert.equal(offered.background.provider, "OpenRouter");
    await runHere.start("background");
    const config = t.settings().model_config;
    const role = config.roles.background;
    assert.equal(role.here, true);
    assert.deepEqual(role.fallback, { connection: "primary", model: MODEL, capabilities: { tools: true } });
    assert.equal(role.capabilities.reasoning, "here");
    const conn = config.connections[role.connection];
    assert.match(conn.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    assert.match(conn.apiKey, /^enc:v1:/, "the runner's key is stored sealed");
    assert.deepEqual([conn.here.gguf.repo, conn.here.files, conn.here.ctx, conn.here.projector], ["examplelab/Example-1.5B-GGUF", ["Example-1.5B-Q4_K_M.gguf"], 32768, null]);
    assert.ok(conn.here.memoryBytes > 0);
    assert.deepEqual(t.files(), ["examplelab/Example-1.5B-GGUF/" + "3".repeat(40) + "/Example-1.5B-Q4_K_M.gguf",
      "examplelab/Example-1.5B-GGUF/" + "3".repeat(40) + "/chat-template.jinja", `runner-${role.connection}.pid`].sort());
    const dir = path.join(process.env.MODELS_DIR, "llm", "examplelab/Example-1.5B-GGUF", "3".repeat(40));
    assert.equal(fs.readFileSync(path.join(dir, "chat-template.jinja"), "utf8"), SMALL.template.toString());
    assert.equal(sha256(fs.readFileSync(path.join(dir, "Example-1.5B-Q4_K_M.gguf"))), sha256(SMALL.ggufs[1].files[0].body));
    const run = t.farm.live()[0];
    assert.equal(run.file, t.sandbox, "started inside the sandbox");
    const real = fs.realpathSync(t.bin);
    assert.ok(run.argv.includes(`BIN=${real}`) && run.argv.includes(real));
    const profile = run.arg("-p");
    for (const rule of ["(deny process-fork)", "(deny process-exec*)", '(allow process-exec (literal (param "BIN")))', '(global-name "com.apple.coreservices.launchservicesd")',
      '(global-name "com.apple.coreservices.appleevents")', '(global-name-prefix "com.apple.pasteboard")', "(deny network*)"]) assert.ok(profile.includes(rule), rule);
    assert.equal(run.arg("--host"), "127.0.0.1");
    assert.equal(run.arg("-c"), "32768");
    assert.equal(run.arg("--chat-template-file"), path.join(dir, "chat-template.jinja"));
    assert.ok(run.argv.includes("--offline") && !run.argv.includes("--mmproj"));
    assert.ok(t.hub.calls.every(u => !u.includes("strangerfolk/Example-1.5B-GGUF/resolve")), "a GGUF from outside the makers and the known quantizers is never fetched");
    assert.ok(t.hub.calls.every(u => !u.includes("escape")), "a file named to climb out of its folder is never fetched");
    const status = await runHere.status();
    assert.deepEqual(status.jobs.background, { state: "here", runner: "running", provider: "OpenRouter" });
    assert.equal(await ask(t.settings(), "background"), "ready", "answered by the runner");
  } finally { t.done(); }
});

test("going back to the provider stops the runner and frees the disk; a runner another job uses stays", async () => {
  const t = setup({ chat: pick(), background: pick() });
  try {
    await runHere.start("chat");
    await runHere.start("background");
    assert.equal(await runHere.undo("background"), true);
    let config = t.settings().model_config;
    assert.deepEqual(config.roles.background, { connection: "primary", model: MODEL, capabilities: { tools: true } });
    assert.equal(t.farm.live().length, 1, "chat still runs there");
    assert.ok(t.files().some(f => f.endsWith(".gguf")));
    assert.equal(await runHere.undo("chat"), true);
    config = t.settings().model_config;
    assert.deepEqual(Object.keys(config.connections), ["primary"]);
    assert.equal(t.farm.live().length, 0);
    assert.deepEqual(t.files(), []);
    assert.equal(await runHere.undo("chat"), false, "nothing to undo");
  } finally { t.done(); }
});

test("a runner that crashes is started again, and the provider answers meanwhile", async () => {
  const t = setup({ background: pick() });
  const p = await provider();
  try {
    await runHere.start("background");
    t.farm.live()[0].child.crash();
    await until(async () => (await runHere.status()).jobs.background.runner === "restarting");
    assert.equal(await ask(t.settings(), "background", p.url), "from the provider");
    await until(async () => (await runHere.status()).jobs.background.runner === "running");
    assert.equal(t.farm.live().length, 1);
    assert.equal(await ask(t.settings(), "background", p.url), "ready", "the runner answers again");
    assert.equal(p.asked.length, 1);
  } finally { p.close(); t.done(); }
});

test("jobs sharing a runner keep its image part and largest context, also after a restart", async () => {
  const t = setup({ chat: pick(), vision: pick() });
  try {
    await runHere.start("vision");
    let run = t.farm.live()[0];
    assert.ok(run.arg("--mmproj").endsWith("mmproj-Example-1.5B-f16.gguf"));
    assert.equal(run.arg("-c"), "8192");
    await runHere.start("chat");
    const config = t.settings().model_config;
    assert.equal(config.roles.chat.connection, config.roles.vision.connection, "one runner for both");
    run = t.farm.live()[0];
    assert.equal(t.farm.live().length, 1);
    assert.ok(run.arg("--mmproj"), "chat switching second keeps the image part");
    assert.equal(run.arg("-c"), "65536");
    runHere.stopAll();
    await runHere.resume();
    run = t.farm.live()[0];
    assert.ok(run.arg("--mmproj") && run.arg("-c") === "65536", "and so does a restart of the app");
    await until(async () => (await runHere.status()).jobs.chat.runner === "running");
  } finally { t.done(); }
});

test("two clicks at once are set up one after the other, onto one intact download", async () => {
  const t = setup({ chat: pick(), background: pick() });
  try {
    runHere.start("chat");
    const second = runHere.start("background");
    assert.equal((await runHere.status()).jobs.background.state, "waiting");
    await second;
    const config = t.settings().model_config;
    assert.ok(config.roles.chat.here && config.roles.background.here);
    assert.equal(config.roles.chat.connection, config.roles.background.connection);
    assert.equal(t.farm.live().length, 1);
    assert.equal(t.farm.live()[0].arg("-c"), "65536");
    assert.ok(!t.files().some(f => f.endsWith(".part")));
    const file = path.join(process.env.MODELS_DIR, "llm", "examplelab/Example-1.5B-GGUF", "3".repeat(40), "Example-1.5B-Q4_K_M.gguf");
    assert.equal(sha256(fs.readFileSync(file)), sha256(SMALL.ggufs[1].files[0].body));
  } finally { t.done(); }
});

test("saving the models keeps a job there when its pick is the same, and tidies one that changed", async () => {
  const t = setup({ background: pick() });
  try {
    await runHere.start("background");
    const before = t.settings().model_config;
    const fromSettings = { version: 1, connections: { primary: { provider: "openrouter", backend: "custom", baseUrl: "https://openrouter.ai/api/v1", apiKey: "router-key" } },
      roles: { chat: null, background: { connection: "primary", model: MODEL, capabilities: { tools: true, checked: 1 } }, vision: null } };
    const kept = runHere.carryOver(before, fromSettings);
    assert.equal(kept.roles.background.here, true);
    assert.deepEqual(kept.roles.background.fallback.capabilities, { tools: true, checked: 1 }, "the fallback takes the newly checked pick");
    assert.doesNotMatch(kept.connections[kept.roles.background.connection].apiKey, /^enc:v1:/, "unsealed, for the save to seal once");
    const changed = runHere.carryOver(before, { ...fromSettings, roles: { ...fromSettings.roles, background: { connection: "primary", model: "examplelab/another" } } });
    assert.equal(changed.roles.background.model, "examplelab/another");
    assert.equal(changed.roles.background.here, undefined);
    // The save from Settings writes the changed pick; tidying stops the runner and frees the disk.
    await t.store.supabase.rpc("patch", { p_set: { model_config: { ...changed, connections: { primary: before.connections.primary } } } });
    await runHere.reconcile();
    assert.equal(t.farm.live().length, 0);
    assert.deepEqual(t.files(), []);
    assert.deepEqual(Object.keys(t.settings().model_config.connections), ["primary"]);
    assert.match(require("node:fs").readFileSync(path.join(__dirname, "..", "webapp/model-config.js"), "utf8"),
      /withConfig\(settings, runHere\.carryOver\(settings\.model_config, entry\.config\)\)/, "the save route keeps; settings-patch's listener tidies");
  } finally { t.done(); }
});

test("a model that answers wrong isn't offered again; a dropped connection may be tried again", async () => {
  let t = setup({ chat: pick() });
  try {
    t.farm.behaviour.tools = "wrong";
    await runHere.start("chat");
    assert.equal(t.settings().model_config.roles.chat.here, undefined);
    assert.deepEqual(t.state().tried, ["chat|examplelab/example-1.5b|Q4_K_M"]);
    assert.match((await runHere.status()).notes.chat, /^It couldn't be set up on the computer running Closedhand, so it stays with OpenRouter\.$/);
    assert.deepEqual((await runHere.status()).notes, {}, "said once");
    assert.deepEqual(t.files(), [], "the download goes");
    assert.equal(t.farm.live().length, 0);
  } finally { t.done(); }
  t = setup({ chat: pick() });
  try {
    t.farm.behaviour.drop = true;
    await runHere.start("chat");
    assert.equal(t.state().tried, undefined);
    assert.ok((await runHere.offers(t.settings())).chat, "still offered");
  } finally { t.done(); }
});

test("a job whose files are gone, or whose record reaches outside the models folder, returns to its provider", async () => {
  const t = setup({ background: pick() });
  try {
    await runHere.start("background");
    const outside = path.join(t.dir, "keep-me.gguf");
    fs.writeFileSync(outside, "not Closedhand's");
    const config = structuredClone(t.settings().model_config);
    config.connections[config.roles.background.connection].here.files = ["../../../keep-me.gguf"];
    await t.store.supabase.rpc("patch", { p_set: { model_config: config } });
    runHere.stopAll();
    await runHere.resume();
    assert.equal(t.settings().model_config.roles.background.connection, "primary");
    assert.match((await runHere.status()).notes.background, /^It couldn't start on the computer running Closedhand, so it's back with OpenRouter\.$/);
    assert.ok(fs.existsSync(outside), "nothing outside the models folder is touched");
    assert.equal(t.farm.live().length, 0);
  } finally { t.done(); }
});

test("any other change to the model settings tidies away a runner nothing uses", async () => {
  const t = setup({ background: pick() });
  try {
    runHere.watchSettings();
    await runHere.start("background");
    assert.equal(t.farm.live().length, 1);
    // As switching to Closedhand Managed Models does (included-ai-setup.js): a whole new model_config.
    const managed = { version: 1, included: true, connections: { primary: t.settings().model_config.connections.primary }, roles: { chat: pick(), background: pick(), vision: null } };
    await require("../webapp/settings-patch").patchSettings(t.store.supabase, "u", { set: { model_config: managed } });
    await until(async () => t.farm.live().length === 0 && t.files().length === 0);
    assert.deepEqual(Object.keys(t.settings().model_config.connections), ["primary"]);
    assert.match(fs.readFileSync(path.join(__dirname, "..", "webapp/included-ai-setup.js"), "utf8"), /patchSettings\(supabase, getAdminUserId\(\), diff\(now, modelConfig\.withConfig\(now, config\)\)\)/, "Managed Models save through settings-patch");
  } finally { t.done(); }
});

test("a runner that keeps failing is let go, and its job goes back to the provider once", async () => {
  const t = setup({ background: pick() });
  try {
    await runHere.start("background");
    t.farm.behaviour.crashOnStart = true;
    t.farm.live()[0].child.crash();
    await until(async () => t.settings().model_config.roles.background.connection === "primary", 8000);
    assert.equal(t.farm.spawned.length, 1 + 4, "four tries to start it again, then no more");
    assert.match((await runHere.status()).notes.background, /^It couldn't start on the computer running Closedhand, so it's back with OpenRouter\.$/);
    await wait(300);
    assert.equal(t.farm.spawned.length, 5);
    assert.deepEqual(t.files(), []);
  } finally { t.done(); }
});

test("without a sandbox the runner isn't started, and the job stays with the provider", async () => {
  const t = setup({ background: pick() });
  const logged = [];
  const error = console.error;
  console.error = (...a) => logged.push(a.join(" "));
  try {
    fs.rmSync(t.sandbox);
    assert.deepEqual(await runHere.offers(t.settings()), {}, "nothing is offered that could never run");
    await runHere.start("background");
    assert.equal(t.farm.spawned.length, 0);
    assert.equal(t.settings().model_config.roles.background.connection, "primary");
    assert.ok(logged.some(l => l.includes("the runner can't be sandboxed on this computer, so it wasn't started")));
    assert.match((await runHere.status()).notes.background, /couldn't be set up/);
  } finally { console.error = error; t.done(); }
});

test("going back never waits behind another job's download", async () => {
  const t = setup({ chat: pick(), background: pick("examplelab/example-1.5b"), vision: pick() });
  try {
    await runHere.start("background");
    t.hub.slow.ms = 1500;
    fs.rmSync(path.join(process.env.MODELS_DIR, "llm", "examplelab"), { recursive: true, force: true });
    const vision = runHere.start("vision");
    await until(async () => (await runHere.status()).jobs.vision?.state === "downloading");
    const began = Date.now();
    assert.equal(await runHere.undo("background"), true);
    assert.ok(Date.now() - began < 1000, "undone at once");
    await vision;
    assert.equal(t.settings().model_config.roles.vision.here, true, "the other job finished setting up");
  } finally { t.done(); }
});

test("a refused key or a passing server error doesn't mark the model; a server error twice does", async () => {
  let t = setup({ chat: pick() });
  try {
    t.farm.behaviour.unauthorized = true;
    await runHere.start("chat");
    assert.equal(t.state().tried, undefined, "401: not the model's fault");
    assert.ok(Object.keys(t.state().keep || {}).length > 0, "the verified download is kept for the next try");
    t.hub.calls.length = 0;
    t.farm.behaviour.unauthorized = false;
    await runHere.start("chat");
    assert.equal(t.settings().model_config.roles.chat.here, true);
    assert.ok(!t.hub.calls.some(u => u.includes("/resolve/") && u.endsWith(".gguf")), "and isn't downloaded again");
  } finally { t.done(); }
  t = setup({ chat: pick() });
  try {
    t.farm.behaviour.serverError = true;
    await runHere.start("chat");
    assert.deepEqual(t.state().tried, ["chat|examplelab/example-1.5b|Q4_K_M"]);
  } finally { t.done(); }
});

test("a runner whose port was taken while it was down starts on another and says where", async () => {
  const t = setup({ background: pick() });
  const squatter = http.createServer();
  try {
    await runHere.start("background");
    const id = t.settings().model_config.roles.background.connection;
    const port = Number(new URL(t.settings().model_config.connections[id].baseUrl).port);
    t.farm.live()[0].child.crash();
    await until(async () => (await runHere.status()).jobs.background.runner === "restarting");
    await new Promise(r => squatter.listen(port, "127.0.0.1", r));
    await until(async () => (await runHere.status()).jobs.background.runner === "running");
    const moved = Number(new URL(t.settings().model_config.connections[id].baseUrl).port);
    assert.notEqual(moved, port);
    assert.equal(Number(t.farm.live()[0].arg("--port")), moved);
    assert.equal(await ask(t.settings(), "background"), "ready");
  } finally { squatter.close(); t.done(); }
});

test("a shared runner left with nothing to do by an undo during another job's try is let go when that try fails", async () => {
  const t = setup({ chat: pick(), background: pick() });
  try {
    await runHere.start("chat");
    t.farm.behaviour.serverError = true;
    runHere.configure({ retryMs: 400 });
    const trying = runHere.start("background");
    await until(async () => (await runHere.status()).jobs.background?.state === "checking");
    assert.equal(await runHere.undo("chat"), true);
    assert.equal(t.farm.live().length, 1, "kept while the other job's try uses it");
    await trying;
    assert.equal(t.farm.live().length, 0);
    assert.deepEqual(t.files(), []);
    assert.deepEqual(Object.keys(t.settings().model_config.connections), ["primary"]);
  } finally { runHere.configure({ retryMs: 10 }); t.done(); }
});

test("a new port that can't be saved keeps the old one and counts as a failed start", async () => {
  const t = setup({ background: pick() });
  const squatter = http.createServer();
  try {
    await runHere.start("background");
    const id = t.settings().model_config.roles.background.connection;
    const before = t.settings().model_config.connections[id].baseUrl;
    const port = Number(new URL(before).port);
    runHere.configure({ restartDelays: [300] });
    t.farm.live()[0].child.crash();
    await until(async () => (await runHere.status()).jobs.background.runner === "restarting");
    await new Promise((r, j) => { squatter.once("error", j); squatter.listen(port, "127.0.0.1", r); });
    t.store.supabase.rpc = async () => ({ data: null, error: { message: "the database is away" } });
    await wait(800);
    assert.equal(t.farm.spawned.length, 1, "not started on a port the jobs don't know");
    assert.equal(t.settings().model_config.connections[id].baseUrl, before);
  } finally { runHere.configure({ restartDelays: [50] }); squatter.close(); t.done(); }
});

test("the Settings save compares and writes under run-here's lock on the model settings", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "webapp/model-config.js"), "utf8");
  const save = src.slice(src.indexOf('app.post("/api/model-config/save"'));
  assert.match(save, /await runHere\.editConfig\(async \(\) => \{\n\s*let settings = await profile\(id\);\n\s*if \(entry\.previous !== JSON\.stringify/);
  assert.ok(save.indexOf("patchSettings(supabase, id") < save.indexOf("receipts.delete"), "written inside the lock, before the ticket goes");
});
