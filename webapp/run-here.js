// "Run it here": an LLM someone picked for a job (chat, support work,
// images) can run on the computer running Closedhand instead, when it plainly
// fits and will be fast (run-here-fit.js decides). One click does the rest:
// the model is downloaded from Hugging Face and checked against its
// published checksum, the bundled llama.cpp runner starts on that computer
// only, the job's own check passes, a real prompt of the job's size is timed,
// and only if it keeps the promise does the job switch. Otherwise the job
// stays with the person's provider and they are told once.
//
// A job run there keeps its provider as a fallback: whenever the runner
// isn't answering (starting up, restarting after a crash), model-wire.js
// sends the request to the provider, and Settings says so. A runner that
// stops is started again, sooner at first and then every five minutes.
//
// Mac app only for now (Metal). Docker on a Mac can't reach the GPU, and
// Linux with an NVIDIA card is a later step.
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { spawn, execFileSync } = require("child_process");
const fit = require("./run-here-fit");
const policy = require("./model-policy");

const HF = "https://huggingface.co";
const OPENROUTER_MODELS = "https://openrouter.ai/api/v1/models";
const DAY = 24 * 3600 * 1000;
const JOB_NAMES = ["chat", "background", "vision"];
const PROVIDER_NAMES = { anthropic: "Anthropic", deepinfra: "DeepInfra", deepseek: "DeepSeek", gemini: "Google Gemini", groq: "Groq",
  moonshot: "Moonshot", openai: "OpenAI", openrouter: "OpenRouter", xai: "xAI", ollama: "Ollama", custom: "your provider" };
// Where a GGUF may come from: the model's makers, or quantizers whose
// versions the llama.cpp community relies on. Anyone can publish one, and
// its file runs with access to the person's mail, so nobody else's is used.
const QUANTIZERS = ["ggml-org", "unsloth", "bartowski", "lmstudio-community"];
const RESTART_DELAYS = [5000, 15000, 60000, 300000];
const HOME = "the computer running Closedhand";

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
  // Without the sandbox the runner never starts, so nothing is offered.
  if (!runnerBinary() || !fs.existsSync(deps.sandboxExec || "/usr/bin/sandbox-exec")) return false;
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

// --- Names and paths that come from Hugging Face ------------------------------

// A repository, a commit and a file path are used in addresses and on disk
// only when they have these shapes, and every path stays inside filesDir().
const REPO = /^[\w.-]+\/[\w.-]+$/;
const SHA = /^[0-9a-f]{40}$/;
const SEGMENT = /^[\w.+@-]+$/;
const safeRepo = (r) => REPO.test(String(r)) && !String(r).split("/").some(s => s === "." || s === "..");
const safeFile = (p) => { const parts = String(p).split("/"); return parts.length <= 4 && parts.every(s => SEGMENT.test(s) && s !== "." && s !== ".."); };
function inside(...parts) {
  const root = path.resolve(filesDir());
  const full = path.resolve(root, ...parts);
  if (!full.startsWith(root + path.sep)) throw new Error("a model file outside the models folder was refused");
  return full;
}
const encoded = (p) => String(p).split("/").map(encodeURIComponent).join("/");
const fileUrl = (repo, sha, file) => `${HF}/${encoded(repo)}/resolve/${sha}/${encoded(file)}`;
// Where a connection's files live, after checking every name it holds.
function placeOf(here) {
  if (!here || !safeRepo(here.gguf?.repo) || !SHA.test(String(here.gguf?.sha)) || !Array.isArray(here.files) || !here.files.length
    || !here.files.every(safeFile) || (here.projector && !safeFile(here.projector))) throw new Error("its record was refused");
  const dir = inside(here.gguf.repo, here.gguf.sha);
  return { dir, files: here.files.map(f => inside(here.gguf.repo, here.gguf.sha, f)),
    projector: here.projector ? inside(here.gguf.repo, here.gguf.sha, here.projector) : null,
    template: inside(here.gguf.repo, here.gguf.sha, "chat-template.jinja") };
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
  return safeRepo(found?.hugging_face_id) ? found.hugging_face_id : null;
}
function isLocal(baseUrl) {
  try { return ["localhost", "127.0.0.1", "[::1]", "host.docker.internal"].includes(new URL(baseUrl).hostname); } catch (_) { return false; }
}
// The model's Hugging Face repository, when its weights are published there.
// Only names that are Hugging Face's own are looked up: OpenRouter's list
// links a model to its repository, and DeepInfra's names are repositories.
// Other providers' models (and closed models) are never offered.
async function repoFor(conn, model) {
  if (!conn || !model || conn.provider === "here" || conn.provider === "ollama") return null;
  if (isLocal(conn.baseUrl)) return null;
  if (conn.provider === "openrouter") return openRouterRepo(model);
  // DeepInfra names its models by their Hugging Face repository. A custom
  // provider's names may be private, so they are never looked up.
  if (conn.provider === "deepinfra" && safeRepo(model)) return model;
  return null;
}
// The chat template the model's makers publish, read at their pinned
// commit, so a quantizer's GGUF never decides how prompts are wrapped.
async function templateOf(repo, sha) {
  const tree = await getJson(`${HF}/api/models/${encoded(repo)}/tree/${sha}`).catch(() => []);
  for (const name of ["chat_template.jinja", "tokenizer_config.json"]) {
    const entry = tree.find(f => f.type === "file" && f.path === name && f.size > 0 && f.size < 2e6);
    if (entry) return { file: name, size: entry.size };
  }
  return null;
}
async function fetchTemplate(repo, sha, template) {
  const res = await fetchImpl(fileUrl(repo, sha, template.file), { redirect: "follow", signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`the chat template didn't download (${res.status})`);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length !== template.size) throw new Error("the chat template wasn't the size its makers list");
  if (template.file === "chat_template.jinja") return body.toString("utf8");
  const config = JSON.parse(body.toString("utf8"));
  const chosen = Array.isArray(config.chat_template)
    ? (config.chat_template.find(t => t.name === "default") || config.chat_template[0])?.template : config.chat_template;
  if (typeof chosen !== "string" || !chosen.trim()) throw new Error("the model publishes no chat template");
  return chosen;
}
// Everything run-here-fit needs about a model: its shape, its 4-bit-or-better
// GGUF files with sizes and checksums, its image part and its chat template.
async function describe(repo) {
  if (!safeRepo(repo)) return { none: "not a repository name" };
  const info = await getJson(`${HF}/api/models/${encoded(repo)}`);
  if (info.gated || info.private || info.disabled || !SHA.test(String(info.sha))) return { none: "its download needs a Hugging Face account" };
  const template = await templateOf(repo, info.sha);
  if (!template) return { none: "its makers publish no chat template" };
  const config = await getJson(fileUrl(repo, info.sha, "config.json")).catch(() => null);
  const makers = repo.split("/")[0];
  const found = await getJson(`${HF}/api/models?filter=base_model:quantized:${encodeURIComponent(repo)}&filter=gguf&sort=downloads&direction=-1&limit=50`).catch(() => []);
  const trusted = found.map(m => m.id).filter(id => safeRepo(id) && [makers, ...QUANTIZERS].includes(id.split("/")[0]))
    .sort((a, b) => (a.split("/")[0] === makers ? 0 : 1) - (b.split("/")[0] === makers ? 0 : 1));
  for (const id of trusted) {
    const gguf = await getJson(`${HF}/api/models/${encoded(id)}`).catch(() => null);
    if (!gguf || gguf.gated || gguf.private || gguf.disabled || !SHA.test(String(gguf.sha))) continue;
    const tree = await getJson(`${HF}/api/models/${encoded(id)}/tree/${gguf.sha}?recursive=true`).catch(() => []);
    const files = tree.filter(f => f.type === "file" && /\.gguf$/i.test(f.path) && safeFile(f.path) && /^[0-9a-f]{64}$/.test(String(f.lfs?.oid)) && f.size > 0)
      .map(f => ({ path: f.path, size: f.size, sha256: f.lfs.oid }));
    const quants = fit.quantizations(files);
    if (!quants.length) continue;
    const total = Number(info.safetensors?.total) || Number(gguf.gguf?.total) || null;
    const shape = fit.shapeOf(config, total, Number(gguf.gguf?.context_length) || null);
    return { repo, sha: info.sha, template, gguf: { repo: id, sha: gguf.sha }, quants, projector: fit.projectorOf(files), shape };
  }
  return { none: "no 4-bit or better version from its makers or an established quantizer" };
}
const described = new Map();
async function cachedDescribe(repo) {
  const held = described.get(repo);
  if (held && held.at > Date.now() - (held.value.none ? DAY / 4 : DAY)) return held.value;
  const value = await describe(repo).catch(e => ({ none: e.message }));
  described.set(repo, { at: Date.now(), value });
  return value;
}

// --- State kept between runs --------------------------------------------------

// self_host_config RUN_HERE: { notes: { job: text }, tried: [key] }
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
const say = (job, text) => writeState(s => ({ ...s, notes: { ...(s.notes || {}), [job]: text } })).catch(() => {});
const triedKey = (job, model, quant) => [job, model, quant].join("|");
const markTried = (key) => writeState(s => ({ ...s, tried: [...new Set([...(s.tried || []), key])] })).catch(() => {});

async function readSettings() {
  const { data, error } = await deps.supabase.from("profiles").select("settings").eq("id", deps.getAdminUserId()).single();
  if (error || !data) throw new Error("Could not load model settings.");
  return data.settings || {};
}
async function saveConfig(settings, config) {
  await require("./settings-patch").patchSettings(deps.supabase, deps.getAdminUserId(), { set: { model_config: config }, by: "run-here" });
  return { ...settings, model_config: config };
}

// Setting jobs up, and starting runners again after a restart, go one at a
// time: they never share a half-written file or start the same runner twice.
// Changes to the model settings are short and go one at a time too; undoing
// a job and tidying up need only those, so they never wait behind a
// download, and they leave alone what a run in progress is using.
let chain = Promise.resolve();
function exclusive(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}
let edits = Promise.resolve();
function editConfig(fn) {
  const next = edits.then(fn, fn);
  edits = next.catch(() => {});
  return next;
}
const activeRunners = new Set(); // runners a run in progress has started or is changing
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// --- Offers -------------------------------------------------------------------

const hereConnections = (config) => Object.entries(config?.connections || {}).filter(([, c]) => c?.provider === "here");
// What runners already there take, apart from the one a job would share.
function reserved(config, except) {
  return hereConnections(config).filter(([id]) => id !== except).reduce((n, [, c]) => n + (Number(c.here?.memoryBytes) || 0), 0);
}
const connectionId = (gguf, quant) => "here-" + crypto.createHash("sha256").update(gguf.repo + "|" + quant.label).digest("hex").slice(0, 10);
// Each version is judged beside the LLMs already running there, apart from
// the runner that version would share.
function choose(job, model, hw, config) {
  if (forced()) return forcedChoice(job, model, hw);
  return fit.pick(job, model.quants, model.shape, hw, model.projector, (q) => reserved(config, connectionId(model.gguf, q)));
}
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
    const choice = choose(job, model, hw, config);
    if (!choice.ok || (state.tried || []).includes(triedKey(job, role.model, choice.quant.label))) continue;
    result[job] = { bytes: choice.estimate.downloadBytes, quant: choice.quant.label, provider: PROVIDER_NAMES[conn?.provider] || "your provider" };
  }
  return result;
}
// Testing only: the smallest 4-bit-or-better version, whatever the computer.
function forcedChoice(job, model, hw) {
  const quant = [...model.quants].sort((a, b) => a.bytes - b.bytes)[0];
  const verdict = fit.judge(job, quant, model.shape, { ...hw, chip: hw.chip || fit.chipOf("Apple M1") });
  const downloadBytes = quant.bytes + (job === "vision" && model.projector ? model.projector.size : 0);
  return { ok: !!quant, quant, estimate: { downloadBytes, memoryBytes: verdict.estimate?.memoryBytes || downloadBytes } };
}

// --- Downloading ----------------------------------------------------------------

async function sha256Of(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
// Resumable: a part already on disk is continued. Kept only when the file
// on disk matches the checksum Hugging Face publishes for it. A download
// that sends nothing for a minute is stopped, to be tried again.
async function download(url, dest, size, sha256, onBytes, idleMs = 60000) {
  if (fs.existsSync(dest) && fs.statSync(dest).size === size) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + ".part";
  let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  if (have > size) { fs.rmSync(part, { force: true }); have = 0; }
  if (have < size) {
    const abort = new AbortController();
    let idle = null;
    const touch = () => { clearTimeout(idle); idle = setTimeout(() => abort.abort(new Error("the download stalled")), idleMs); };
    touch();
    try {
      let res = await fetchImpl(url, { headers: have ? { Range: `bytes=${have}-` } : {}, redirect: "follow", signal: abort.signal });
      if (res.status === 416) {
        fs.rmSync(part, { force: true }); have = 0;
        res = await fetchImpl(url, { redirect: "follow", signal: abort.signal });
      }
      if (have && res.status !== 206) have = 0;
      if (!res.ok || !res.body) throw new Error(`the download stopped (${res.status})`);
      const source = typeof res.body.getReader === "function" ? Readable.fromWeb(res.body) : Readable.from(res.body);
      let count = have;
      await pipeline(source, async function* (chunks) {
        for await (const chunk of chunks) { count += chunk.length; touch(); onBytes(count); yield chunk; }
      }, fs.createWriteStream(part, { flags: have ? "a" : "w" }));
    } finally {
      clearTimeout(idle);
    }
  }
  if (fs.statSync(part).size !== size || (await sha256Of(part)) !== sha256) {
    fs.rmSync(part, { force: true });
    throw Object.assign(new Error("the download didn't match its published checksum, so it was not kept"), { checksum: true });
  }
  fs.renameSync(part, dest);
}
const inFlight = new Map(); // file -> how many runs are using it
const hold = (files) => files.forEach(f => inFlight.set(f, (inFlight.get(f) || 0) + 1));
const release = (files) => files.forEach(f => { const n = (inFlight.get(f) || 1) - 1; if (n > 0) inFlight.set(f, n); else inFlight.delete(f); });

// --- The runner -----------------------------------------------------------------

// connection id -> { child, port, key, spec, state: loading|running|restarting, supervised, stopping, restarts, timer }
const runners = new Map();
const MAX_FAILURES = 4;
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
// The runner is sandboxed: it may run only its own program and start
// nothing else, reads only that program's folder and the models folder in
// the home folder, writes only temporary files, listens on this computer
// only, reaches no network, and can't open apps, send Apple events or touch
// the pasteboard. Without the sandbox it doesn't run at all.
const SANDBOX = `(version 1)
(allow default)
(deny process-fork)
(deny process-exec*)
(allow process-exec (literal (param "BIN")))
(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd") (global-name "com.apple.coreservices.appleevents") (global-name-prefix "com.apple.pasteboard"))
(deny network*)
(allow network-bind (local ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
(deny file-write*)
(allow file-write* (subpath "/private/var/folders") (subpath "/private/tmp") (literal "/dev/null"))
(deny file-read* (subpath "/Users") (subpath "/Volumes"))
(allow file-read* (subpath (param "MODELS")) (subpath (param "RUNNER")))`;
function command(bin, args) {
  const sandbox = deps.sandboxExec || "/usr/bin/sandbox-exec";
  if (!fs.existsSync(sandbox)) throw new Error("the runner can't be sandboxed on this computer, so it wasn't started");
  const real = fs.realpathSync(bin);
  return [sandbox, ["-D", `MODELS=${path.resolve(modelsDir())}`, "-D", `RUNNER=${path.dirname(real)}`, "-D", `BIN=${real}`, "-p", SANDBOX, real, ...args]];
}
// llama-server on this computer only, behind its own key, with every layer
// on the GPU, never reaching the network, one request at a time with the
// whole context, the makers' chat template, and a modest prompt cache.
function launch(id, held) {
  const { spec, port, key } = held;
  const args = ["-m", spec.file, "--host", "127.0.0.1", "--port", String(port), "-c", String(spec.ctx), "-np", "1",
    "-ngl", "999", "--alias", spec.alias, "--no-webui", "--offline", "-cram", "1024", "--jinja", "--chat-template-file", spec.template];
  if (spec.projector) args.push("--mmproj", spec.projector);
  const env = { PATH: process.env.PATH || "/usr/bin:/bin", HOME: process.env.HOME || os.homedir(), TMPDIR: process.env.TMPDIR || os.tmpdir(), LLAMA_API_KEY: key };
  held.tail = "";
  held.ended = false;
  let file, argv;
  try { [file, argv] = command(runnerBinary(), args); }
  catch (e) {
    console.error(`[run-here] ${e.message}`);
    held.tail = e.message;
    held.child = { exitCode: 1, signalCode: null, kill() {} };
    return stopped(id, held, held.child);
  }
  const child = (deps.spawn || spawn)(file, argv, { env, stdio: ["ignore", "ignore", "pipe"] });
  held.child = child;
  child.stderr?.on("data", d => { held.tail = (held.tail + d).slice(-2000); });
  child.on("exit", () => stopped(id, held, child));
  child.on("error", (e) => { held.tail += `\n${e.message}`; stopped(id, held, child); });
  try { fs.mkdirSync(filesDir(), { recursive: true }); fs.writeFileSync(path.join(filesDir(), `runner-${id}.pid`), String(child.pid || "")); } catch (_) {}
}
// A supervised runner that stops on its own is started again, sooner at
// first and then every five minutes; until then the provider answers. After
// four failures in a row its jobs go back to their provider.
function stopped(id, held, child) {
  if (held.child !== child || held.ended) return;
  held.ended = true;
  if (held.stopping || runners.get(id) !== held || !held.supervised) return;
  if (held.restarts >= MAX_FAILURES) { giveUp(id); return; }
  held.state = "restarting";
  const delays = deps.restartDelays || RESTART_DELAYS;
  const delay = delays[Math.min(held.restarts, delays.length - 1)];
  held.restarts += 1;
  console.error(`[run-here] the runner stopped; starting it again in ${delay / 1000} s`);
  held.timer = setTimeout(() => { relaunch(id, held).catch(() => {}); }, delay);
  held.timer.unref?.();
}
async function relaunch(id, held) {
  if (held.stopping || runners.get(id) !== held) return;
  // Something else may have taken its port meanwhile. A new port that can't
  // be saved is no use to the jobs: the old one stays, and this counts as a
  // failed start.
  if (!(await portFree(held.port))) {
    const port = await freePort();
    const saved = await editConfig(async () => {
      const settings = await readSettings();
      const conn = settings.model_config?.connections?.[id];
      if (!conn) return;
      const next = structuredClone(settings.model_config);
      next.connections[id] = { ...conn, baseUrl: `http://127.0.0.1:${port}/v1` };
      await saveConfig(settings, next);
    }).then(() => true, () => false);
    if (!saved) {
      held.ended = false;
      held.child = { exitCode: 1, signalCode: null, kill() {} };
      return stopped(id, held, held.child);
    }
    held.port = port;
  }
  if (held.stopping || runners.get(id) !== held) return;
  launch(id, held);
  watchUp(held);
}
// Up and answering: running. Not up in time: stopped, which counts as a failure.
function watchUp(held) {
  waitUntilUp(held).then(() => { held.state = "running"; held.restarts = 0; })
    .catch(() => { if (held.child.exitCode === null && held.child.signalCode === null) held.child.kill("SIGKILL"); });
}
async function waitUntilUp(held, ms = 180000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (held.ended || held.child.exitCode !== null || held.child.signalCode !== null) {
      throw new Error("the runner stopped while loading: " + String(held.tail || "").split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 200));
    }
    if (await health(held.port, held.key)) return;
    await wait(1000);
  }
  throw new Error("the runner didn't finish loading");
}
async function startRunner(id, spec, { key, port, supervised }) {
  await stopRunner(id);
  if (!runnerBinary()) throw new Error("the runner isn't part of this Closedhand");
  const held = { spec, key, port, state: "loading", supervised, stopping: false, restarts: 0, ended: false };
  runners.set(id, held);
  launch(id, held);
  try {
    await waitUntilUp(held);
  } catch (e) {
    await stopRunner(id);
    throw e;
  }
  held.state = "running";
  return held;
}
async function stopRunner(id) {
  fs.rmSync(path.join(filesDir(), `runner-${id}.pid`), { force: true });
  const held = runners.get(id);
  if (!held) return;
  runners.delete(id);
  held.stopping = true;
  clearTimeout(held.timer);
  const child = held.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise(r => { const t = setTimeout(() => { child.kill("SIGKILL"); r(); }, 5000); child.once("exit", () => { clearTimeout(t); r(); }); });
}
function stopAll() {
  for (const held of runners.values()) { held.stopping = true; clearTimeout(held.timer); held.child?.kill("SIGTERM"); }
  runners.clear();
}
process.once("exit", stopAll);
// A runner left behind when the app was stopped hard still holds its
// memory; it goes before anything starts again.
function stopLeftBehind() {
  let names = [];
  try { names = fs.readdirSync(filesDir()).filter(n => /^runner-here-[0-9a-f]{10}\.pid$/.test(n)); } catch (_) { return; }
  for (const name of names) {
    const file = path.join(filesDir(), name);
    const pid = Number(fs.readFileSync(file, "utf8"));
    if (pid > 1 && !deps.spawn) {
      try {
        const command = execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", timeout: 3000 }).trim();
        if (/(llama-server|sandbox-exec)$/.test(command)) process.kill(pid, "SIGTERM");
      } catch (_) { /* not running */ }
    }
    fs.rmSync(file, { force: true });
  }
}
// What a connection's runner needs: the biggest context any job on it
// wants, and the image part if any job on it has one.
function specOf(config, id, place, alias) {
  const jobs = JOB_NAMES.filter(j => config.roles?.[j]?.connection === id);
  const here = config.connections[id].here;
  return { file: place.files[0], template: place.template, alias,
    ctx: Math.max(Number(here.ctx) || 0, ...jobs.map(j => fit.JOBS[j].context)),
    projector: here.projector ? place.projector : null };
}
// A runner that keeps failing is let go: its jobs go back to their provider,
// and the person is told once.
function giveUp(id) {
  console.error("[run-here] the runner kept stopping; its jobs go back to their provider");
  return editConfig(async () => {
    await stopRunner(id);
    const settings = await readSettings();
    const config = structuredClone(settings.model_config || {});
    for (const job of JOB_NAMES.filter(j => config.roles?.[j]?.connection === id && config.roles[j].fallback)) {
      config.roles[job] = config.roles[job].fallback;
      await say(job, `It couldn't start on ${HOME}, so it's back with ${providerName(config, config.roles[job])}.`);
    }
    if (config.connections) delete config.connections[id];
    return saveConfig(settings, config);
  }).then(removeUnused).catch(e => console.error("[run-here] letting the runner go:", e.message));
}

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
// chat, a plain answer for support work, a picture for images. A runner
// that fails with a server error is asked once more before that counts.
async function checkJob(job, conn, model) {
  const once = async () => {
    const config = require("./model-config");
    const wire = require("./model-wire");
    if (job === "vision") {
      const reply = await wire.request({ ...conn, capabilities: { vision: true, reasoning: "here" } }, { model, effort: "fast", max_tokens: 256,
        messages: [{ role: "user", content: [{ type: "text", text: "What is the main colour in this image? Answer in one word." },
          { type: "image", source: { type: "base64", media_type: "image/png", data: config.RED_IMAGE } }] }] }, { signal: AbortSignal.timeout(120000) });
      if (!/\bred\b/i.test(wire.responseText(reply))) throw new Error("it didn't pass the image check there");
      return;
    }
    await config.checkModel(conn, model, job === "chat" ? "chat" : "support", []);
  };
  try { await once(); }
  catch (e) {
    if (!(Number(e?.status) >= 500)) throw e;
    await wait(deps.retryMs ?? 3000);
    await once().catch(again => { throw Object.assign(again, { serverErrorTwice: Number(again?.status) >= 500 }); });
  }
}
// Only a model that answered and got it wrong is remembered as failing, or
// a runner that failed with a server error twice; a timeout, a dropped
// connection or a refused key may go better next time.
function answeredWrong(e) {
  const code = e?.cause?.code || e?.code;
  if (e?.serverErrorTwice) return true;
  if (["TimeoutError", "AbortError"].includes(e?.name) || /fetch failed|timed? ?out|aborted/i.test(String(e?.message))) return false;
  if (["ECONNREFUSED", "ECONNRESET", "UND_ERR_SOCKET", "UND_ERR_CLOSED"].includes(code)) return false;
  if ([401, 403].includes(Number(e?.status)) || Number(e?.status) >= 500) return false;
  return true;
}

// --- One click ----------------------------------------------------------------------

function providerName(config, role) {
  return PROVIDER_NAMES[config?.connections?.[role?.connection]?.provider] || "your provider";
}
const relative = (p) => path.relative(filesDir(), p);
const progress = new Map(); // job -> { state, pct, totalBytes } while a run is waiting or under way
const queued = new Map(); // job -> promise
function start(job) {
  if (!JOB_NAMES.includes(job)) throw new Error("Unknown job.");
  if (queued.has(job)) return queued.get(job);
  progress.set(job, { state: "waiting" });
  const work = exclusive(() => run(job)).catch(e => console.error(`[run-here] ${job}: ${e.message}`))
    .finally(() => { queued.delete(job); progress.delete(job); });
  queued.set(job, work);
  return work;
}
async function run(job) {
  progress.set(job, { state: "starting" });
  let settings = await readSettings();
  const config0 = settings.model_config;
  const role = config0?.roles?.[job];
  const conn = config0?.connections?.[role?.connection];
  const provider = providerName(config0, role);
  if (!role || role.here) return;
  const repo = await repoFor(conn, role.model).catch(() => null);
  const model = repo ? await cachedDescribe(repo) : { none: "not published" };
  if (model.none) return say(job, `It couldn't be set up on ${HOME}, so it stays with ${provider}.`);
  const choice = choose(job, model, hardware(), config0);
  if (!choice.ok) return say(job, `It no longer fits on ${HOME}, so it stays with ${provider}.`);
  const quant = choice.quant;
  const id = connectionId(model.gguf, quant);
  const shared = config0.connections?.[id];
  const here = {
    repo: model.repo, gguf: model.gguf, quant: quant.label,
    files: quant.files.map(f => f.path),
    projector: (job === "vision" && model.projector?.path) || shared?.here?.projector || null,
    ctx: Math.max(fit.JOBS[job].context, Number(shared?.here?.ctx) || 0),
    memoryBytes: Math.max(choice.estimate.memoryBytes, Number(shared?.here?.memoryBytes) || 0),
  };
  const place = placeOf(here);
  const wanted = [...quant.files.map((f, i) => ({ ...f, dest: place.files[i] }))];
  if (job === "vision" && model.projector) wanted.push({ ...model.projector, dest: place.projector });
  const totalBytes = wanted.reduce((n, f) => n + f.size, 0);
  const before = runners.get(id);
  const beforeSpec = before?.spec;
  // The key the running runner already has, so a check never fails on it.
  const key = before?.key || (shared ? policy.openKey(shared.apiKey) : crypto.randomBytes(24).toString("hex"));
  const paths = [...wanted.map(f => f.dest), place.template];
  hold(paths);
  activeRunners.add(id);
  let outcome = "failed";
  try {
    let done = 0;
    for (const f of wanted) {
      const url = fileUrl(model.gguf.repo, model.gguf.sha, f.path);
      for (let attempt = 1; ; attempt++) {
        try {
          await download(url, f.dest, f.size, f.sha256, (bytes) => progress.set(job, { state: "downloading", pct: Math.floor(((done + bytes) / totalBytes) * 100), totalBytes }));
          break;
        } catch (e) {
          if (attempt >= 3 || e.checksum) throw e;
          await wait(attempt * 5000);
        }
      }
      done += f.size;
    }
    fs.writeFileSync(place.template, await fetchTemplate(model.repo, model.sha, model.template));
    progress.set(job, { state: "checking", totalBytes });
    // The runner as it will be: every job on it counted, this one included.
    const trial = structuredClone(config0);
    trial.connections[id] = { provider: "here", here };
    trial.roles[job] = { ...role, connection: id };
    const port = before?.port || (shared ? Number(new URL(shared.baseUrl).port) : 0) || await freePort();
    const spec = specOf(trial, id, place, role.model);
    if (!before || before.spec.ctx < spec.ctx || (spec.projector && !before.spec.projector)) await startRunner(id, spec, { key, port, supervised: !!shared });
    const conn = { provider: "here", backend: "custom", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: key, capabilities: { reasoning: "here" } };
    try {
      await checkJob(job, conn, role.model);
    } catch (e) {
      if (answeredWrong(e)) { outcome = "wrong"; await markTried(triedKey(job, role.model, quant.label)); }
      throw e;
    }
    const timings = await timeIt(port, key, job);
    console.log(`[run-here] ${job}: read ${Math.round(Number(timings.prompt_per_second) || 0)} tokens a second, wrote ${Math.round(Number(timings.predicted_per_second) || 0)}`);
    if (!fit.keepsPromise(job, timings)) {
      outcome = "slow";
      await markTried(triedKey(job, role.model, quant.label));
      throw Object.assign(new Error("slower than promised"), { slow: true });
    }
    await editConfig(async () => {
      settings = await readSettings();
      const config = structuredClone(settings.model_config);
      const current = config.roles?.[job];
      if (!current || current.model !== role.model || current.connection !== role.connection) throw new Error("the models changed while this was set up");
      config.connections[id] = { provider: "here", backend: "custom", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: policy.sealKey(key), here };
      config.roles[job] = {
        connection: id, model: role.model, here: true,
        capabilities: { tools: job === "chat" ? true : current.capabilities?.tools ?? null, vision: job === "vision", video: false, videoLinks: false, contextWindow: here.ctx, reasoning: "here" },
        fallback: { connection: current.connection, model: current.model, capabilities: current.capabilities },
      };
      await saveConfig(settings, config);
    });
    const held = runners.get(id);
    if (held) held.supervised = true;
    outcome = "switched";
  } catch (e) {
    if (!e.slow) console.error(`[run-here] ${job}: ${e.message}`);
    await putBack(id, shared, beforeSpec, key).catch(() => {});
    // A download that's verified but couldn't be used for a reason that may
    // pass (the runner didn't start, a timeout) is kept for a day for the next click.
    if (outcome === "failed") await writeState(s => ({ ...s, keep: { ...(s.keep || {}), ...Object.fromEntries(paths.filter(p => fs.existsSync(p)).map(p => [relative(p), Date.now() + DAY])) } })).catch(() => {});
  } finally {
    activeRunners.delete(id);
    release(paths);
  }
  if (outcome === "switched") return;
  // Also lets go of a shared runner another job's undo left with nothing to do.
  await tidy().catch(() => {});
  return say(job, outcome === "slow" ? `It ran slower on ${HOME} than promised, so it stays with ${provider}.` : `It couldn't be set up on ${HOME}, so it stays with ${provider}.`);
}

// After a try that didn't switch: a new runner goes; one other jobs already
// use goes back to how it was, so it never points at files about to go.
async function putBack(id, shared, beforeSpec, key) {
  const now = runners.get(id);
  if (!shared) return stopRunner(id);
  if (beforeSpec && now && now.spec !== beforeSpec) await startRunner(id, beforeSpec, { key, port: now.port, supervised: true });
}

// Back to the provider, and the download goes. Never waits behind another
// job's download.
async function undo(job) {
  const done = await editConfig(async () => {
    const settings = await readSettings();
    const config = structuredClone(settings.model_config || {});
    const role = config.roles?.[job];
    if (!role?.here || !role.fallback) return false;
    config.roles[job] = role.fallback;
    await saveConfig(settings, config);
    return true;
  });
  if (done) await tidy();
  return done;
}
// Connections, runners and files no job uses any more (a job switched back,
// or the models were saved from elsewhere) go; what a run in progress uses stays.
async function tidy() {
  const settings = await editConfig(async () => {
    const settings = await readSettings();
    const config = settings.model_config;
    if (!config) return settings;
    const used = new Set(JOB_NAMES.map(j => config.roles?.[j]?.connection));
    const unused = hereConnections(config).filter(([id]) => !used.has(id) && !activeRunners.has(id)).map(([id]) => id);
    if (!unused.length) return settings;
    const next = structuredClone(config);
    for (const id of unused) delete next.connections[id];
    return saveConfig(settings, next);
  });
  const used = new Set(JOB_NAMES.map(j => settings.model_config?.roles?.[j]?.connection));
  for (const id of [...runners.keys()]) if (!used.has(id) && !activeRunners.has(id)) await stopRunner(id);
  await removeUnused(settings);
  return settings;
}
async function removeUnused(settings) {
  const keep = new Set();
  for (const [, c] of hereConnections(settings?.model_config)) {
    try {
      const place = placeOf(c.here);
      [...place.files, place.template, ...(place.projector ? [place.projector] : [])].forEach(f => keep.add(f));
    } catch (_) { /* a refused record keeps nothing */ }
  }
  const state = await readState().catch(() => ({}));
  const kept = Object.entries(state.keep || {}).filter(([, until]) => until > Date.now());
  for (const [rel] of kept) { try { keep.add(inside(rel)); } catch (_) {} }
  if (kept.length !== Object.keys(state.keep || {}).length) await writeState(s => ({ ...s, keep: Object.fromEntries(kept) })).catch(() => {});
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) { fs.rmSync(p, { force: true }); continue; }
      if (e.isDirectory()) { walk(p); try { fs.rmdirSync(p); } catch (_) {} continue; }
      if (keep.has(p) || inFlight.has(p) || inFlight.has(p.replace(/\.part$/, ""))) continue;
      if (/^runner-here-[0-9a-f]{10}\.pid$/.test(e.name) && dir === filesDir()) continue;
      // A download cut short (the app quit) is continued by the next click,
      // for a week; after that it is let go.
      try {
        if (p.endsWith(".part") && fs.statSync(p).mtimeMs > Date.now() - 7 * DAY) continue;
      } catch (_) { continue; /* already gone */ }
      fs.rmSync(p, { force: true });
    }
  };
  walk(filesDir());
}
// Saving the models from Settings keeps a job run on the computer running
// Closedhand when its provider pick is the same as before; otherwise the job
// takes the new pick and its runner goes (tidy, after the save).
function carryOver(before, after) {
  if (!before?.roles || !after?.roles) return after;
  const next = structuredClone(after);
  const same = (a, b) => a && b && a.provider === b.provider && a.baseUrl === b.baseUrl;
  for (const job of JOB_NAMES) {
    const old = before.roles[job], now = after.roles[job];
    if (!old?.here || !old.fallback || !now) continue;
    if (old.fallback.model !== now.model || !same(before.connections?.[old.fallback.connection], after.connections?.[now.connection])) continue;
    const conn = before.connections?.[old.connection];
    if (!conn) continue;
    // Keys here are as the user's config holds them before sealing (model-config withConfig seals them).
    next.connections[old.connection] = { ...conn, apiKey: policy.openKey(conn.apiKey) };
    next.roles[job] = { ...old, fallback: { connection: now.connection, model: now.model, capabilities: now.capabilities } };
  }
  return next;
}
const reconcile = () => tidy();

// At start: each runner comes back. A job whose files are gone returns to
// its provider, and the person is told once.
function resume() {
  return exclusive(async () => {
    if (!deps.supabase) return;
    stopLeftBehind();
    let settings;
    try { settings = await readSettings(); } catch (_) { return; }
    const config = settings.model_config;
    if (!config?.roles) return;
    // What changes, applied to the settings as they are when it's saved.
    const reverted = {}, dropped = [], moved = {};
    for (const [id, conn] of hereConnections(config)) {
      const jobs = JOB_NAMES.filter(j => config.roles[j]?.connection === id);
      if (!jobs.length) continue;
      try {
        if (!available()) throw new Error("this computer can't run it");
        const place = placeOf(conn.here);
        if (![...place.files, place.template].every(f => fs.existsSync(f)) || (conn.here.projector && !fs.existsSync(place.projector))) throw new Error("its files are missing");
        let port = Number(new URL(conn.baseUrl).port);
        if (!(await portFree(port))) port = await freePort();
        const held = { spec: specOf(config, id, place, config.roles[jobs[0]].model), key: policy.openKey(conn.apiKey), port, state: "loading", supervised: true, stopping: false, restarts: 0, ended: false };
        await stopRunner(id);
        runners.set(id, held);
        launch(id, held);
        // The provider answers while it loads; supervised from here on.
        watchUp(held);
        if (!conn.baseUrl.endsWith(`:${port}/v1`)) moved[id] = `http://127.0.0.1:${port}/v1`;
      } catch (e) {
        console.error(`[run-here] could not start again: ${e.message}`);
        for (const job of jobs) {
          reverted[job] = config.roles[job].fallback;
          await say(job, `It couldn't start on ${HOME}, so it's back with ${providerName(config, reverted[job])}.`);
        }
        dropped.push(id);
      }
    }
    if (Object.keys(reverted).length || dropped.length || Object.keys(moved).length) {
      settings = await editConfig(async () => {
        const now = await readSettings();
        const next = structuredClone(now.model_config);
        for (const [job, fallback] of Object.entries(reverted)) if (next.roles?.[job]?.here) next.roles[job] = fallback;
        for (const id of dropped) delete next.connections[id];
        for (const [id, baseUrl] of Object.entries(moved)) if (next.connections[id]) next.connections[id] = { ...next.connections[id], baseUrl };
        return saveConfig(now, next);
      }).catch(() => settings);
    }
    await tidy().catch(() => removeUnused(settings));
  });
}

// --- Settings ---------------------------------------------------------------------------

async function status() {
  const settings = await readSettings();
  const config = settings.model_config;
  const state = await readState();
  const jobs = {};
  for (const job of JOB_NAMES) {
    const role = config?.roles?.[job];
    if (role?.here) {
      const held = runners.get(role.connection);
      jobs[job] = { state: "here", runner: held ? held.state : "stopped", provider: providerName(config, role.fallback) };
    } else if (progress.has(job)) jobs[job] = progress.get(job);
  }
  const notes = state.notes || {};
  if (Object.keys(notes).length) await writeState(s => ({ ...s, notes: {} })).catch(() => {});
  return { available: available(), offers: await offers(settings).catch(() => ({})), jobs, notes };
}
// Any other writer of the model settings (Settings' save, switching to
// Closedhand Managed Models or the default) may leave a runner no job uses:
// it goes, with its files.
let watching = false;
function watchSettings() {
  if (watching) return;
  watching = true;
  require("./settings-patch").onChange(({ keys, by }) => {
    // Nothing to tidy where no runner can run and none is running (closedhand.com, Docker).
    if (!available() && !runners.size) return;
    if (by !== "run-here" && keys.includes("model_config")) reconcile().catch(e => console.error("[run-here] tidy after a model change:", e.message));
  });
}
function install(app, { supabase, getAdminUserId, authorize }) {
  configure({ supabase, getAdminUserId });
  watchSettings();
  const route = fn => async (req, res) => {
    try { if (!(await authorize(req, res))) return; await fn(req, res); }
    catch (e) { res.status(400).json({ error: e.message || "Could not do that." }); }
  };
  app.get("/api/run-here", route(async (req, res) => res.set("Cache-Control", "no-store").json(available() ? await status() : { available: false })));
  app.post("/api/run-here/start", route(async (req, res) => {
    if (!available()) return res.status(400).json({ error: `${HOME[0].toUpperCase()}${HOME.slice(1)} can't run LLMs itself.` });
    const job = String(req.body?.job || "");
    if (!queued.has(job) && !(await offers(await readSettings()))[job]) return res.status(400).json({ error: `This LLM isn't offered to run on ${HOME}.` });
    start(job);
    res.status(202).json({ started: true });
  }));
  app.post("/api/run-here/undo", route(async (req, res) => res.json({ undone: await undo(String(req.body?.job || "")) })));
}

module.exports = { install, configure, watchSettings, editConfig, resume, reconcile, carryOver, start, undo, offers, status, repoFor, describe, download, stopAll };
