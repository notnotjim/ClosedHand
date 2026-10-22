// "Run it here": an LLM someone picked for a job (chat, support work,
// images) can run on this computer instead, when it plainly fits and will be
// fast (run-here-fit.js decides). One click does the rest: the model is
// downloaded from Hugging Face and checked against its published checksum,
// the bundled llama.cpp runner starts on this computer only, a real prompt of
// the job's size is timed, and only if it keeps the promise does the job
// switch. Otherwise the job stays with the person's provider and they are
// told once. A job run here keeps its provider as a fallback: whenever the
// runner isn't answering, model-wire.js sends that request to the provider.
//
// Mac app only for now (Metal). Docker on a Mac can't reach the GPU, and
// Linux with an NVIDIA card is a later step.
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const fit = require("./run-here-fit");
const policy = require("./model-policy");

const HF = "https://huggingface.co";
const OPENROUTER_MODELS = "https://openrouter.ai/api/v1/models";
const DAY = 24 * 3600 * 1000;
const JOB_NAMES = ["chat", "background", "vision"];
const PROVIDER_NAMES = { anthropic: "Anthropic", deepinfra: "DeepInfra", deepseek: "DeepSeek", gemini: "Google Gemini", groq: "Groq",
  moonshot: "Moonshot", openai: "OpenAI", openrouter: "OpenRouter", xai: "xAI", ollama: "Ollama", custom: "your provider" };

let deps = {};
function configure(next) { deps = { ...deps, ...next }; }
const fetchImpl = (...args) => (deps.fetch || fetch)(...args);
const modelsDir = () => process.env.MODELS_DIR || path.join(process.env.STORAGE_DIR || path.join(__dirname, "..", "data"), "models");
const filesDir = () => path.join(modelsDir(), "llm");

// Only where a runner ships and the GPU is reachable. RUN_HERE_FORCE=1 is
// for testing the whole path on a computer that would never qualify.
const forced = () => process.env.RUN_HERE_FORCE === "1";
function runnerBinary() {
  const bin = process.env.LLAMA_SERVER_BIN;
  return bin && fs.existsSync(bin) ? bin : null;
}
function available() {
  if (!runnerBinary()) return false;
  if (forced()) return true;
  return process.env.CLOSEDHAND_DESKTOP === "1" && (deps.platform || process.platform) === "darwin" && (deps.arch || process.arch) === "arm64";
}

function hardware() {
  if (deps.hardware) return deps.hardware();
  let brand = "";
  try { brand = execFileSync("sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf8", timeout: 3000 }).trim(); } catch (_) {}
  let freeDiskBytes = 0;
  try {
    fs.mkdirSync(modelsDir(), { recursive: true });
    const s = fs.statfsSync(modelsDir());
    freeDiskBytes = s.bavail * s.bsize;
  } catch (_) {}
  return { chip: fit.chipOf(brand), brand, memoryBytes: os.totalmem(), freeDiskBytes };
}

// --- Which model on Hugging Face, and its downloadable versions -------------

async function getJson(url, ms = 15000) {
  const res = await fetchImpl(url, { headers: { Accept: "application/json", "User-Agent": "Closedhand" }, signal: AbortSignal.timeout(ms), redirect: "follow" });
  if (!res.ok) throw Object.assign(new Error(`${new URL(url).hostname} answered ${res.status}`), { status: res.status });
  return res.json();
}
let routerList = null;
async function openRouterRepo(model) {
  if (!routerList || routerList.at < Date.now() - DAY) routerList = { at: Date.now(), data: (await getJson(OPENROUTER_MODELS)).data || [] };
  const id = String(model).replace(/:[a-z]+$/, "");
  const found = routerList.data.find(m => m.id === model) || routerList.data.find(m => m.id === id);
  return found?.hugging_face_id || null;
}
// The model's Hugging Face repository, when its weights are published there.
// Providers that don't name models by repository (and closed models) have
// none, so they are never offered.
async function repoFor(conn, model) {
  if (!conn || !model || conn.provider === "here" || conn.provider === "ollama") return null;
  if (isLocal(conn.baseUrl)) return null;
  if (conn.provider === "openrouter") return openRouterRepo(model);
  if (["deepinfra", "custom"].includes(conn.provider) && /^[\w.-]+\/[\w.-]+$/.test(model)) return model;
  return null;
}
function isLocal(baseUrl) {
  try { return ["localhost", "127.0.0.1", "[::1]", "host.docker.internal"].includes(new URL(baseUrl).hostname); } catch (_) { return false; }
}
// Everything run-here-fit needs about a model: its shape, its 4-bit-or-better
// GGUF files with sizes and checksums, and its image part.
async function describe(repo) {
  const info = await getJson(`${HF}/api/models/${repo}`);
  if (info.gated || info.private || info.disabled) return { none: "its download needs a Hugging Face account" };
  const config = await getJson(`${HF}/${repo}/resolve/${info.sha}/config.json`).catch(() => null);
  const found = await getJson(`${HF}/api/models?filter=base_model:quantized:${encodeURIComponent(repo)}&filter=gguf&sort=downloads&direction=-1&limit=6`).catch(() => []);
  for (const candidate of found) {
    const gguf = await getJson(`${HF}/api/models/${candidate.id}`).catch(() => null);
    if (!gguf || gguf.gated || gguf.private || gguf.disabled) continue;
    const tree = await getJson(`${HF}/api/models/${candidate.id}/tree/${gguf.sha}?recursive=true`).catch(() => []);
    const files = tree.filter(f => f.type === "file" && /\.gguf$/i.test(f.path) && f.lfs?.oid && f.size > 0)
      .map(f => ({ path: f.path, size: f.size, sha256: f.lfs.oid }));
    const quants = fit.quantizations(files);
    if (!quants.length) continue;
    const total = Number(info.safetensors?.total) || Number(gguf.gguf?.total) || null;
    const shape = fit.shapeOf(config, total, Number(gguf.gguf?.context_length) || null);
    return { repo, gguf: { repo: candidate.id, sha: gguf.sha }, quants, projector: fit.projectorOf(files), shape };
  }
  return { none: "no 4-bit or better version is published" };
}
const described = new Map();
async function cachedDescribe(repo) {
  const held = described.get(repo);
  if (held && held.at > Date.now() - (held.value.none ? DAY / 4 : DAY)) return held.value;
  const value = await describe(repo).catch(e => ({ none: e.message }));
  described.set(repo, { at: Date.now(), value });
  return value;
}

// --- The state kept between runs ----------------------------------------------

// self_host_config RUN_HERE: { attempts: { job: { state, pct, ... } }, notes: { job: text }, tried: [key] }
async function readState() {
  if (deps.state) return deps.state.read();
  const { getConf } = require("./config");
  return (await getConf("RUN_HERE")) || {};
}
async function writeState(change) {
  const next = change(await readState());
  if (deps.state) await deps.state.write(next);
  else await require("./config").setConf({ RUN_HERE: next });
  return next;
}
const progress = new Map(); // job -> { state, pct, bytes, totalBytes } while a run is under way

async function readSettings() {
  const { data, error } = await deps.supabase.from("profiles").select("settings").eq("id", deps.getAdminUserId()).single();
  if (error || !data) throw new Error("Could not load model settings.");
  return data.settings || {};
}
async function saveConfig(settings, config) {
  await require("./settings-patch").patchSettings(deps.supabase, deps.getAdminUserId(), { set: { model_config: config } });
  return { ...settings, model_config: config };
}

// --- Offers -------------------------------------------------------------------

const triedKey = (job, model, quant) => [job, model, quant].join("|");
async function offers(settings) {
  const result = {};
  const config = settings.model_config;
  if (!available() || !config || config.included) return result;
  const hw = hardware();
  const state = await readState();
  for (const job of JOB_NAMES) {
    const role = config.roles?.[job];
    if (!role || role.here) continue;
    const conn = config.connections?.[role.connection];
    const repo = await repoFor(conn, role.model).catch(() => null);
    if (!repo) continue;
    const model = await cachedDescribe(repo);
    if (model.none) continue;
    const choice = forced() ? forcedChoice(job, model, hw) : fit.pick(job, model.quants, model.shape, hw, model.projector);
    if (!choice.ok || (state.tried || []).includes(triedKey(job, role.model, choice.quant.label))) continue;
    result[job] = { bytes: choice.estimate.downloadBytes, quant: choice.quant.label,
      estimate: { firstSeconds: round(choice.estimate.firstSeconds), tokensPerSecond: Math.round(choice.estimate.tokensPerSecond) } };
  }
  return result;
}
const round = (n) => Math.round(n * 10) / 10;
// Testing only: the smallest 4-bit-or-better version, whatever the computer.
function forcedChoice(job, model, hw) {
  const quant = [...model.quants].sort((a, b) => a.bytes - b.bytes)[0];
  const verdict = fit.judge(job, quant, model.shape, { ...hw, chip: hw.chip || fit.chipOf("Apple M1") });
  return { ok: !!quant, quant, estimate: verdict.estimate || { downloadBytes: quant.bytes, firstSeconds: 0, tokensPerSecond: 0 } };
}

// --- Downloading ----------------------------------------------------------------

// Resumable: a part already on disk is hashed and continued. Kept only when
// the whole file matches the checksum Hugging Face publishes for it.
async function download(url, dest, size, sha256, onBytes) {
  if (fs.existsSync(dest) && fs.statSync(dest).size === size) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + ".part";
  let have = 0, hash = crypto.createHash("sha256");
  if (fs.existsSync(part)) {
    have = fs.statSync(part).size;
    if (have > size) { fs.rmSync(part, { force: true }); have = 0; }
    else for await (const chunk of fs.createReadStream(part)) hash.update(chunk);
  }
  const res = await fetchImpl(url, { headers: have ? { Range: `bytes=${have}-` } : {}, redirect: "follow" });
  if (have && res.status !== 206) { have = 0; hash = crypto.createHash("sha256"); }
  if (!res.ok || !res.body) throw new Error(`the download stopped (${res.status})`);
  const out = fs.createWriteStream(part, { flags: have ? "a" : "w" });
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      have += chunk.length;
      if (!out.write(chunk)) await new Promise(r => out.once("drain", r));
      onBytes(have);
    }
    await new Promise((resolve, reject) => out.end(e => (e ? reject(e) : resolve())));
  } catch (e) {
    out.destroy();
    throw e;
  }
  if (have !== size || hash.digest("hex") !== sha256) {
    fs.rmSync(part, { force: true });
    throw new Error("the download didn't match its published checksum, so it was not kept");
  }
  fs.renameSync(part, dest);
}
const localPath = (gguf, file) => path.join(filesDir(), gguf.repo, gguf.sha, file.path);

// --- The runner -----------------------------------------------------------------

const runners = new Map(); // connection id -> { child, port, ctx }
const inFlight = new Set(); // files a run in progress is downloading or loading
const pendingRunners = new Set(); // runners a run in progress has started
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}
function portFree(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}
async function health(port, key, ms = 3000) {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/health`, { headers: { Authorization: "Bearer " + key }, signal: AbortSignal.timeout(ms) });
    return res.ok;
  } catch (_) { return false; }
}
// llama-server on this computer only, behind its own key, with every layer
// on the GPU, never reaching the network, one request at a time with the
// whole context, and a modest cache of earlier prompts.
async function startRunner(id, { model, ctx, key, port, alias }) {
  await stopRunner(id);
  const bin = runnerBinary();
  if (!bin) throw new Error("the runner isn't part of this Closedhand");
  const args = ["-m", model.file, "--host", "127.0.0.1", "--port", String(port), "-c", String(ctx), "-np", "1",
    "-ngl", "999", "--alias", alias, "--no-webui", "--offline", "-cram", "1024", "--jinja"];
  if (model.projector) args.push("--mmproj", model.projector);
  const env = { PATH: process.env.PATH || "/usr/bin:/bin", HOME: process.env.HOME || os.homedir(), TMPDIR: process.env.TMPDIR || os.tmpdir(), LLAMA_API_KEY: key };
  const child = (deps.spawn || spawn)(bin, args, { env, stdio: ["ignore", "ignore", "pipe"] });
  try { fs.mkdirSync(filesDir(), { recursive: true }); fs.writeFileSync(path.join(filesDir(), `runner-${id}.pid`), String(child.pid)); } catch (_) {}
  let tail = "";
  child.stderr?.on("data", d => { tail = (tail + d).slice(-2000); });
  runners.set(id, { child, port, ctx });
  child.on("exit", () => { if (runners.get(id)?.child === child) runners.delete(id); });
  const until = Date.now() + 180000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error("the runner stopped while loading: " + tail.split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 200));
    if (await health(port, key)) return;
    await new Promise(r => setTimeout(r, 1000));
  }
  await stopRunner(id);
  throw new Error("the runner didn't finish loading");
}
async function stopRunner(id) {
  fs.rmSync(path.join(filesDir(), `runner-${id}.pid`), { force: true });
  const held = runners.get(id);
  if (!held) return;
  runners.delete(id);
  held.child.kill("SIGTERM");
  await new Promise(r => { const t = setTimeout(() => { held.child.kill("SIGKILL"); r(); }, 5000); held.child.once("exit", () => { clearTimeout(t); r(); }); });
}
function stopAll() { for (const held of runners.values()) held.child.kill("SIGTERM"); runners.clear(); }
process.once("exit", stopAll);

// --- Checking and timing ----------------------------------------------------------

// A prompt of about n tokens of ordinary text, counted by the model's own
// tokenizer.
async function promptOf(port, key, n) {
  const words = "the river ran past the old mill near the station while a letter about the spring meeting waited on the table beside two cups and a map of the coast".split(" ");
  let seed = 7;
  const sentence = () => Array.from({ length: 14 }, () => words[(seed = (seed * 48271) % 2147483647) % words.length]).join(" ") + ". ";
  let text = "";
  for (let i = 0; i < 40; i++) text += sentence();
  const res = await fetchImpl(`http://127.0.0.1:${port}/tokenize`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({ content: text }), signal: AbortSignal.timeout(30000) });
  const per = (await res.json()).tokens?.length || 600;
  return text.repeat(Math.max(1, Math.round(n / per)));
}
async function timeIt(port, key, job) {
  const want = fit.JOBS[job];
  const prompt = await promptOf(port, key, want.fresh);
  const res = await fetchImpl(`http://127.0.0.1:${port}/completion`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({ prompt, n_predict: 128, ignore_eos: true, cache_prompt: false, temperature: 0 }), signal: AbortSignal.timeout(300000) });
  if (!res.ok) throw new Error(`the timing run failed (${res.status})`);
  return (await res.json()).timings || {};
}
// The same checks the model got when it was first chosen: tool calls for
// chat, a plain answer for support work, a picture for images.
async function checkJob(job, conn, model) {
  const config = require("./model-config");
  if (job === "vision") {
    const reply = await require("./model-wire").request({ ...conn, capabilities: { vision: true } }, { model, effort: "fast", max_tokens: 256,
      messages: [{ role: "user", content: [{ type: "text", text: "What is the main colour in this image? Answer in one word." },
        { type: "image", source: { type: "base64", media_type: "image/png", data: config.RED_IMAGE } }] }] }, { signal: AbortSignal.timeout(120000) });
    if (!/\bred\b/i.test(require("./model-wire").responseText(reply))) throw new Error("it didn't pass the image check here");
    return;
  }
  await config.checkModel(conn, model, job === "chat" ? "chat" : "support", []);
}

// --- One click ----------------------------------------------------------------------

const connectionId = (gguf, quant) => "here-" + crypto.createHash("sha256").update(gguf.repo + "|" + quant.label).digest("hex").slice(0, 10);
function providerName(settings, role) {
  const conn = settings.model_config?.connections?.[role?.connection];
  return PROVIDER_NAMES[conn?.provider] || "your provider";
}
const running = new Map(); // job -> promise
function start(job) {
  if (!JOB_NAMES.includes(job)) throw new Error("Unknown job.");
  if (running.has(job)) return running.get(job);
  const work = run(job).finally(() => { running.delete(job); progress.delete(job); });
  running.set(job, work);
  work.catch(() => {});
  return work;
}
async function run(job) {
  let settings = await readSettings();
  const role = settings.model_config?.roles?.[job];
  const conn = settings.model_config?.connections?.[role?.connection];
  const provider = providerName(settings, role);
  const say = (text) => writeState(s => ({ ...s, notes: { ...(s.notes || {}), [job]: text } }));
  const repo = await repoFor(conn, role?.model);
  const model = repo ? await cachedDescribe(repo) : { none: "not published" };
  if (!role || model.none) return say(`It couldn't be set up on this computer, so it stays with ${provider}.`);
  const hw = hardware();
  const choice = forced() ? forcedChoice(job, model, hw) : fit.pick(job, model.quants, model.shape, hw, model.projector);
  if (!choice.ok) return say(`It no longer fits on this computer, so it stays with ${provider}.`);
  const quant = choice.quant;
  const id = connectionId(model.gguf, quant);
  const files = quant.files.map(f => ({ ...f, dest: localPath(model.gguf, f) }));
  const projector = job === "vision" && model.projector ? { ...model.projector, dest: localPath(model.gguf, model.projector) } : null;
  const all = projector ? [...files, projector] : files;
  const totalBytes = all.reduce((n, f) => n + f.size, 0);
  // Another job already running this model here shares its runner and key.
  const shared = settings.model_config.connections?.[id];
  const key = shared ? policy.openKey(shared.apiKey) : crypto.randomBytes(24).toString("hex");
  for (const f of all) inFlight.add(f.dest);
  pendingRunners.add(id);
  try {
    let done = 0;
    for (const f of all) {
      const url = `${HF}/${model.gguf.repo}/resolve/${model.gguf.sha}/${f.path}`;
      for (let attempt = 1; ; attempt++) {
        try {
          await download(url, f.dest, f.size, f.sha256,
            (bytes) => progress.set(job, { state: "downloading", pct: Math.floor(((done + bytes) / totalBytes) * 100), totalBytes }));
          break;
        } catch (e) {
          if (attempt >= 3 || /checksum/.test(e.message)) throw e;
          await new Promise(r => setTimeout(r, attempt * 5000));
        }
      }
      done += f.size;
    }
    progress.set(job, { state: "checking", totalBytes });
    const ctx = Math.max(fit.JOBS[job].context, ...JOB_NAMES.filter(j => settings.model_config.roles?.[j]?.connection === id).map(j => fit.JOBS[j].context));
    const port = runners.get(id)?.port || (shared ? Number(new URL(shared.baseUrl).port) : 0) || await freePort();
    await startRunner(id, { model: { file: files[0].dest, projector: projector?.dest }, ctx, key, port, alias: role.model });
    const here = { provider: "here", backend: "custom", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: key };
    // A model that fails its job's check here won't pass next time either.
    await checkJob(job, here, role.model).catch(e => { throw Object.assign(e, { failedCheck: true }); });
    const timings = await timeIt(port, key, job);
    if (!fit.keepsPromise(job, timings)) {
      if (!shared) await stopRunner(id);
      for (const f of all) inFlight.delete(f.dest);
      pendingRunners.delete(id);
      await writeState(s => ({ ...s, tried: [...new Set([...(s.tried || []), triedKey(job, role.model, quant.label)])], last: { job, timings: brief(timings) } }));
      removeUnused(settings);
      return say(`It ran slower on this computer than promised, so it stays with ${provider}.`);
    }
    settings = await readSettings();
    const config = structuredClone(settings.model_config);
    const current = config.roles[job];
    if (!current || current.model !== role.model || current.connection !== role.connection) throw new Error("the models changed while this was set up");
    config.connections[id] = { ...here, apiKey: policy.sealKey(key) };
    config.roles[job] = {
      connection: id, model: role.model,
      capabilities: { tools: job === "chat" ? true : current.capabilities?.tools ?? null, vision: job === "vision", video: false, videoLinks: false, contextWindow: ctx, reasoning: null },
      fallback: { connection: current.connection, model: current.model, capabilities: current.capabilities },
      here: { repo: model.repo, gguf: model.gguf, quant: quant.label, files: files.map(f => f.path), projector: projector?.path || null, bytes: totalBytes, ctx },
    };
    // Every job on this model shares one runner and its key.
    for (const j of JOB_NAMES) if (j !== job && config.roles[j]?.connection === id) config.connections[id] = { ...here, apiKey: policy.sealKey(key) };
    await saveConfig(settings, config);
    await writeState(s => ({ ...s, last: { job, timings: brief(timings) } }));
    for (const f of all) inFlight.delete(f.dest);
    pendingRunners.delete(id);
  } catch (e) {
    console.error(`[run-here] ${job}: ${e.message}`);
    if (e.failedCheck) await writeState(s => ({ ...s, tried: [...new Set([...(s.tried || []), triedKey(job, role.model, quant.label)])] })).catch(() => {});
    if (!shared) await stopRunner(id).catch(() => {});
    for (const f of all) inFlight.delete(f.dest);
    pendingRunners.delete(id);
    removeUnused(await readSettings().catch(() => settings));
    return say(`It couldn't be set up on this computer, so it stays with ${provider}.`);
  }
}
const brief = (t) => ({ promptPerSecond: Math.round(Number(t.prompt_per_second) || 0), writePerSecond: Math.round(Number(t.predicted_per_second) || 0), promptTokens: t.prompt_n || null });

// Back to the provider, and the download goes.
async function undo(job) {
  const settings = await readSettings();
  const config = structuredClone(settings.model_config || {});
  const role = config.roles?.[job];
  if (!role?.here || !role.fallback) return false;
  config.roles[job] = role.fallback;
  if (!JOB_NAMES.some(j => config.roles[j]?.connection === role.connection)) {
    delete config.connections[role.connection];
    await stopRunner(role.connection);
  }
  const saved = await saveConfig(settings, config);
  removeUnused(saved);
  return true;
}
// Files no job uses any more (a job switched back, or the models were
// saved again from Settings) are deleted, and their runner stopped.
function removeUnused(settings) {
  const keep = new Set();
  for (const j of JOB_NAMES) {
    const here = settings.model_config?.roles?.[j]?.here;
    if (!here) continue;
    for (const f of here.files) keep.add(path.join(filesDir(), here.gguf.repo, here.gguf.sha, f));
    if (here.projector) keep.add(path.join(filesDir(), here.gguf.repo, here.gguf.sha, here.projector));
  }
  const used = new Set(JOB_NAMES.map(j => settings.model_config?.roles?.[j]?.connection));
  for (const id of runners.keys()) if (!used.has(id) && !pendingRunners.has(id)) stopRunner(id).catch(() => {});
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); try { fs.rmdirSync(p); } catch (_) {} }
      else if (keep.has(p) || inFlight.has(p) || inFlight.has(p.replace(/\.part$/, ""))) continue;
      // A download cut short (the app quit) is continued by the next click,
      // for a week; after that it is let go.
      else if (p.endsWith(".part") && fs.statSync(p).mtimeMs > Date.now() - 7 * DAY) continue;
      else if (path.basename(p).startsWith("runner-") && p.endsWith(".pid")) continue;
      else fs.rmSync(p, { force: true });
    }
  };
  walk(filesDir());
}

// A runner left behind when the app was stopped hard still holds its
// memory; it goes before anything starts again.
function stopLeftBehind() {
  let names = [];
  try { names = fs.readdirSync(filesDir()).filter(n => /^runner-.+\.pid$/.test(n)); } catch (_) { return; }
  for (const name of names) {
    const file = path.join(filesDir(), name);
    const pid = Number(fs.readFileSync(file, "utf8"));
    try {
      const command = execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", timeout: 3000 }).trim();
      if (/llama-server$/.test(command)) process.kill(pid, "SIGTERM");
    } catch (_) { /* not running */ }
    fs.rmSync(file, { force: true });
  }
}

// At start: each job run here gets its runner back. One whose files are gone
// returns to its provider, and the person is told once.
async function resume() {
  if (!deps.supabase) return;
  stopLeftBehind();
  let settings;
  try { settings = await readSettings(); } catch (_) { return; }
  const config = settings.model_config;
  if (!config?.roles) return;
  const groups = new Map();
  for (const job of JOB_NAMES) {
    const role = config.roles[job];
    if (role?.here) groups.set(role.connection, [...(groups.get(role.connection) || []), job]);
  }
  let next = null;
  for (const [id, jobs] of groups) {
    const here = config.roles[jobs[0]].here;
    const conn = config.connections[id];
    const file = path.join(filesDir(), here.gguf.repo, here.gguf.sha, here.files[0]);
    const projector = here.projector ? path.join(filesDir(), here.gguf.repo, here.gguf.sha, here.projector) : null;
    try {
      if (!available() || !here.files.every(f => fs.existsSync(path.join(filesDir(), here.gguf.repo, here.gguf.sha, f)))) throw new Error("its files are missing");
      const key = policy.openKey(conn.apiKey);
      let port = Number(new URL(conn.baseUrl).port);
      if (!(await portFree(port))) port = await freePort();
      await startRunner(id, { model: { file, projector }, ctx: here.ctx, key, port, alias: config.roles[jobs[0]].model });
      if (!conn.baseUrl.endsWith(`:${port}/v1`)) {
        next = next || structuredClone(config);
        next.connections[id] = { ...conn, baseUrl: `http://127.0.0.1:${port}/v1` };
      }
    } catch (e) {
      console.error(`[run-here] could not start again: ${e.message}`);
      next = next || structuredClone(config);
      for (const job of jobs) {
        next.roles[job] = config.roles[job].fallback;
        const provider = PROVIDER_NAMES[next.connections[next.roles[job]?.connection]?.provider] || "your provider";
        await writeState(s => ({ ...s, notes: { ...(s.notes || {}), [job]: `It couldn't start on this computer, so it's back with ${provider}.` } })).catch(() => {});
      }
      delete next.connections[id];
    }
  }
  if (next) settings = await saveConfig(settings, next).catch(() => settings);
  removeUnused(settings);
}

// --- Settings ---------------------------------------------------------------------------

async function status() {
  const settings = await readSettings();
  const state = await readState();
  const jobs = {};
  for (const job of JOB_NAMES) {
    const role = settings.model_config?.roles?.[job];
    if (role?.here) jobs[job] = { state: "here", provider: PROVIDER_NAMES[settings.model_config.connections?.[role.fallback?.connection]?.provider] || "your provider" };
    else if (progress.has(job)) jobs[job] = progress.get(job);
    else if (running.has(job)) jobs[job] = { state: "starting" };
  }
  const notes = state.notes || {};
  if (Object.keys(notes).length) await writeState(s => ({ ...s, notes: {} })).catch(() => {});
  return { available: available(), offers: await offers(settings).catch(() => ({})), jobs, notes };
}
function install(app, { supabase, getAdminUserId, authorize }) {
  configure({ supabase, getAdminUserId });
  const route = fn => async (req, res) => {
    try { if (!(await authorize(req, res))) return; await fn(req, res); }
    catch (e) { res.status(400).json({ error: e.message || "Could not do that." }); }
  };
  app.get("/api/run-here", route(async (req, res) => res.set("Cache-Control", "no-store").json(available() ? await status() : { available: false })));
  app.post("/api/run-here/start", route(async (req, res) => {
    if (!available()) return res.status(400).json({ error: "This computer can't run models itself." });
    const job = String(req.body?.job || "");
    const settings = await readSettings();
    if (!(await offers(settings))[job]) return res.status(400).json({ error: "This model isn't offered to run here." });
    start(job);
    res.status(202).json({ started: true });
  }));
  app.post("/api/run-here/undo", route(async (req, res) => res.json({ undone: await undo(String(req.body?.job || "")) })));
}

module.exports = { install, configure, resume, start, undo, offers, status, repoFor, describe, download, available, removeUnused, stopAll, _runners: runners };
