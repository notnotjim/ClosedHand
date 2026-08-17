// lib/local-models.js — local fallback models, fetched on first need.
//
// Providers without an embedding model (xAI, Anthropic, Groq) get memory from
// a local embedder instead of a dead end; reranking gets a local cross-encoder
// the same way. Nothing here is baked into the Docker image: the golden-path
// majority never downloads a byte. Models fetch on first use into the shared
// storage volume (MODELS_DIR), report progress through runtime config so the
// wizard and dashboard can show an honest "downloading (~XMB), N%", and load
// at boot like any other component once present.
//
// Defaults (override via config/env LOCAL_EMBED_MODEL_ID / LOCAL_RERANK_MODEL_ID):
//   embedder: EmbeddingGemma-300M ONNX q8 (~300MB, 768d, multilingual;
//             Gemma license — fetched from HF at the user's request, not shipped)
//   reranker: jina-reranker-v1-turbo-en (~40MB, Apache-2.0; the stronger
//             jina v2 is CC-BY-NC, so it is NOT the default in an MIT product)
//
// EmbeddingGemma expects task prefixes; queries and documents are framed
// differently, which usi signals via opts.query.

const path = require("path");

const MODELS_DIR = process.env.MODELS_DIR ||
  path.join(process.env.STORAGE_DIR || path.join(__dirname, "..", "data"), "models");

const EMBED_ID = () => process.env.LOCAL_EMBED_MODEL_ID ||
  require("./config").getConfCached("LOCAL_EMBED_MODEL_ID") || "onnx-community/embeddinggemma-300m-ONNX";
const RERANK_ID = () => process.env.LOCAL_RERANK_MODEL_ID ||
  require("./config").getConfCached("LOCAL_RERANK_MODEL_ID") || "jinaai/jina-reranker-v1-turbo-en";

// The conf names the *logical* model ("local:embeddinggemma-300m"); the loader
// maps it to the HF repo above. Keeps the lock value stable if repos move.
const LOCAL_PREFIX = "local:";

// --- Download/progress state, visible to the wizard and dashboard -----------

// Throttled: progress writes hit the DB at most once a second.
let _lastStatusWrite = 0;
async function _writeStatus(role, patch, force) {
  const now = Date.now();
  // Progress writes contend with the wizard for one settings blob, so they
  // are deliberately rare: a progress bar that updates every ten seconds
  // is fine, losing the user's model choice is not.
  if (!force && now - _lastStatusWrite < 10000) return;
  _lastStatusWrite = now;
  try {
    const { getConf, setConf } = require("./config");
    const cur = (await getConf("LOCAL_MODELS_STATUS")) || {};
    cur[role] = { ...(cur[role] || {}), ...patch, at: new Date().toISOString() };
    await setConf({ LOCAL_MODELS_STATUS: cur });
  } catch (_) { /* status is best-effort; the model work continues */ }
}

function _progressCallback(role) {
  const totals = {};
  return (p) => {
    if (p.status === "progress" && p.total) {
      totals[p.file] = { loaded: p.loaded, total: p.total };
      let loaded = 0, total = 0;
      for (const f of Object.values(totals)) { loaded += f.loaded; total += f.total; }
      _writeStatus(role, {
        state: "downloading",
        pct: total ? Math.round((loaded / total) * 100) : 0,
        mb: Math.round(loaded / 1048576),
        totalMb: Math.round(total / 1048576),
      });
    }
  };
}

// Which numeric precision to run the embedder at.
//
// q8, and the alternatives are worse for reasons worth recording so nobody
// repeats the experiment:
//
//   fp16 IS BROKEN on the CPU execution provider. It loads, it runs, it is
//   twice as fast as q8 and uses half the memory, and every component of every
//   vector it returns is NaN. 768 of 768. It was benchmarked before it was
//   validated, which is exactly how a fast wrong answer gets recommended.
//
//   fp32 is correct and genuinely faster than q8 on ARM (34ms vs 73ms for a
//   single short query, 762MB vs 1543MB resident), because ORT's int8 kernels
//   are weak on ARM while fp32 GEMM is well optimised. It costs a 1.23GB
//   download against q8's 309MB, a four-fold break of what the wizard
//   promises, so it is not the default.
//
// x86 was never measured. int8 is strong there thanks to VNNI, which is why q8
// was chosen originally, so x86 keeps it on the same reasoning.
//
// LOCAL_EMBED_DTYPE overrides. Anything set here MUST be checked for NaN output
// before being trusted: node scripts/check-embedder-output.js
function embedDtype() {
  return (process.env.LOCAL_EMBED_DTYPE || "").trim() || "q8";
}

// ONNX Runtime sizes its thread pool from cpuinfo, and cpuinfo cannot identify
// the CPU inside this container: every run logs "cpuid_info warning: Unknown
// CPU vendor", so the pool it falls back to behaves like a fraction of the
// machine.
//
// HALF the box, never more than four, sized for the smallest machine this ships
// to rather than the largest. A 2-core VPS gets 1 thread and keeps a core for
// everything else; 4 cores get 2; 8 or more get 4, past which a 300M model sees
// little benefit (single-query latency was flat from 1 to 8 threads; only batch
// throughput improved). interOpNumThreads stays 1: these are single-graph
// sequential models and a second pool would only contend with the first.
// LOCAL_ORT_THREADS overrides.
function sessionThreads() {
  const cores = Math.max(1, require("os").cpus().length);
  const configured = parseInt(process.env.LOCAL_ORT_THREADS || "", 10);
  const n = Number.isFinite(configured) && configured > 0
    ? configured
    : Math.max(1, Math.min(4, Math.floor(cores / 2)));
  return { intraOpNumThreads: n, interOpNumThreads: 1 };
}

// --- Worker client -----------------------------------------------------------
//
// Inference runs in lib/local-models-worker.js, not here. onnxruntime-node's
// run() returns a Promise but does not yield the event loop: measured against
// controls, time inside it is indistinguishable from a pure-JS busy loop, 0%
// loop availability. On the main thread that means the bot goes deaf while it
// works, and indexing a mailbox is minutes of it, landing on a new user right
// after they connect their mail.
//
// This side keeps everything that is not inference: model ids, runtime config,
// the status row, and the download-progress writes, all of which already live
// on the main thread and need the database.

const { Worker } = require("worker_threads");

let _worker = null;
let _nextId = 1;
const _pending = new Map();

function _startWorker() {
  const worker = new Worker(require("path").join(__dirname, "local-models-worker.js"), {
    workerData: {
      modelsDir: MODELS_DIR,
      embedId: EMBED_ID(),
      rerankId: RERANK_ID(),
      dtype: embedDtype(),
      sessionOptions: sessionThreads(),
    },
  });

  const progressFor = { embedder: _progressCallback("embedder"), reranker: _progressCallback("reranker") };

  worker.on("message", (msg) => {
    if (msg && msg.type === "progress") {
      // Shaped like transformers.js's own callback so the existing aggregation
      // keeps working unchanged.
      const cb = progressFor[msg.role];
      if (cb) cb({ status: msg.status, file: msg.file, loaded: msg.loaded, total: msg.total, progress: msg.pct });
      return;
    }
    const entry = _pending.get(msg.id);
    if (!entry) return;
    _pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new Error(msg.error));
  });

  // A worker that dies takes every in-flight request with it. Fail them loudly
  // rather than leaving callers awaiting a promise that can never settle, which
  // is the failure mode that cost a day earlier this week.
  const die = (why) => {
    for (const [, entry] of _pending) entry.reject(new Error(`local model worker ${why}`));
    _pending.clear();
    if (_worker === worker) _worker = null; // next call starts a fresh one
  };
  worker.on("error", (e) => { console.error(`[local-models] worker error: ${e.message}`); die(`failed: ${e.message}`); });
  worker.on("exit", (code) => { if (code !== 0) console.error(`[local-models] worker exited: ${code}`); die(`exited (${code})`); });
  worker.unref(); // never hold the process open on its own

  return worker;
}

// Per-call timing, left on deliberately.
//
// Local inference on a contended machine is slow in a way no benchmark session
// reproduces honestly: the same configuration measured 89ms at host load 0.9
// and 564ms at load 3.4, and within one run ranged 106ms to 1971ms. The cause
// is CPU contention rather than anything in this code, and the way to confirm
// that on real installs is to watch it happen rather than to measure it again
// on one laptop.
//
// So: quiet in normal operation, loud when a call is an outlier, plus a
// periodic summary. Each line carries what the machine was doing at the time,
// because a duration without load is the number that started this hunt.
let _statCount = 0;
let _statSlow = 0;
let _statTotalMs = 0;
let _recent = [];

function _loadavg() {
  try { return parseFloat(require("fs").readFileSync("/proc/loadavg", "utf8").split(" ")[0]); }
  catch (_) { return null; } // not Linux; the rest of the line still tells us something
}

function _record(op, items, ms) {
  // Per ITEM, not per call: a batch of 24 legitimately takes longer than a
  // batch of 1, and comparing raw durations across batch sizes would report
  // every large batch as an anomaly. What is worth knowing is when the same
  // unit of work suddenly costs more.
  const perItem = Math.round(ms / Math.max(1, items));
  _statCount++;
  _statTotalMs += ms;
  _recent.push(perItem);
  if (_recent.length > 50) _recent.shift();

  // "Slow" is relative to this install's own recent behaviour, not a number
  // guessed here: a 2-core VPS and a 16-core server disagree about slow.
  const sorted = [..._recent].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || perItem;
  const outlier = _recent.length >= 10 && perItem > Math.max(3 * median, 1000);

  if (outlier) {
    _statSlow++;
    console.log(`[local-models] SLOW ${op}: ${perItem}ms per item (${ms}ms for ${items}), recent median ${median}ms per item, load ${_loadavg() ?? "n/a"}, rss ${Math.round(process.memoryUsage().rss / 1048576)}MB, ${_pending.size} queued`);
  }
  // Periodic summary so a quiet install still leaves a trace to read.
  if (_statCount % 100 === 0) {
    console.log(`[local-models] ${_statCount} calls, mean ${Math.round(_statTotalMs / _statCount)}ms per call, recent median ${median}ms per item, ${_statSlow} outliers, load ${_loadavg() ?? "n/a"}`);
  }
}

function _call(op, args) {
  if (!_worker) _worker = _startWorker();
  const id = _nextId++;
  const started = Date.now();
  const items = op === "embed" ? (args.framed || []).length : op === "rerank" ? (args.docs || []).length : 0;
  return new Promise((resolve, reject) => {
    _pending.set(id, {
      resolve: (v) => { if (items) _record(op, items, Date.now() - started); resolve(v); },
      reject,
    });
    _worker.postMessage({ id, op, args });
  });
}

// Kept for the boot preload and for callers that want the model resident before
// the first real request. Loading happens in the worker either way.
async function ensureLocalEmbedder() {
  await _writeStatus("embedder", { state: "downloading", model: EMBED_ID(), pct: 0 }, true);
  try {
    await _call("preload", { which: "embedder" });
    await _writeStatus("embedder", { state: "ready", pct: 100, error: null }, true);
  } catch (e) {
    await _writeStatus("embedder", { state: "error", error: String(e.message || e).slice(0, 200) }, true);
    throw e;
  }
}

async function ensureLocalReranker() {
  await _writeStatus("reranker", { state: "downloading", model: RERANK_ID(), pct: 0 }, true);
  try {
    await _call("preload", { which: "reranker" });
    await _writeStatus("reranker", { state: "ready", pct: 100, error: null }, true);
  } catch (e) {
    await _writeStatus("reranker", { state: "error", error: String(e.message || e).slice(0, 200) }, true);
    throw e;
  }
}

// Embed texts locally. Returns unit vectors zero-padded to `dims` (cosine is
// unchanged by zero-padding, and data_vectors is fixed at vector(1536)).
// EmbeddingGemma expects task prefixes, so queries and documents are framed
// differently; the framing stays here because it is model semantics, not
// execution.
async function localEmbed(texts, { query = false, dims = 1536 } = {}) {
  const framed = texts.map((t) =>
    query ? `task: search result | query: ${t}` : `title: none | text: ${t}`);
  const rows = await _call("embed", { framed });
  return rows.map((v) => {
    if (v.length >= dims) return v.slice(0, dims);
    return v.concat(new Array(dims - v.length).fill(0));
  });
}

async function localRerankScores(query, docs) {
  return _call("rerank", { query, docs });
}

// Boot preload: called from index.js when the conf says a local model is in
// play, so a restart never waits for a download mid-request.
function preloadIfConfigured() {
  setTimeout(async () => {
    try {
      const { getConf } = require("./config");
      const embedModel = process.env.EMBED_MODEL || (await getConf("EMBED_MODEL"));
      if (String(embedModel || "").startsWith(LOCAL_PREFIX)) ensureLocalEmbedder().catch(() => {});
      // The reranker is now the default when no hosted key exists, not only
      // when RERANK_MODEL names it, so preload on that condition too. Without
      // this the first search of a fresh install pays for a 40MB download
      // while someone waits on an answer.
      const rerankModel = process.env.RERANK_MODEL || (await getConf("RERANK_MODEL"));
      const hostedRerank = process.env.DEEPINFRA_API_KEY || (await getConf("DEEPINFRA_API_KEY"));
      if (String(rerankModel || "").startsWith(LOCAL_PREFIX) || !hostedRerank) ensureLocalReranker().catch(() => {});
    } catch (_) {}
  }, 3000); // after boot settles; harmless if config isn't ready yet
}

module.exports = { LOCAL_PREFIX, MODELS_DIR, ensureLocalEmbedder, ensureLocalReranker, localEmbed, localRerankScores, preloadIfConfigured };
