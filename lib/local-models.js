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

// --- Embedder ----------------------------------------------------------------

let _embedderPromise = null;

function ensureLocalEmbedder() {
  if (!_embedderPromise) {
    _embedderPromise = (async () => {
      const { pipeline, env } = require("@huggingface/transformers");
      env.cacheDir = MODELS_DIR;
      await _writeStatus("embedder", { state: "downloading", model: EMBED_ID(), pct: 0 }, true);
      try {
        const pipe = await pipeline("feature-extraction", EMBED_ID(), {
          dtype: "q8",
          // ONNX Runtime's CPU arena keeps every block it has ever allocated,
          // so indexing a mailbox settles at the high-water mark of the whole
          // pass rather than the cost of one batch. On the machines this
          // edition targets that mark is most of the box. Turning the arena
          // off gives the memory back between batches; it costs a little
          // allocation time per call, which is nothing next to being killed.
          session_options: { enableCpuMemArena: false },
          progress_callback: _progressCallback("embedder"),
        });
        await _writeStatus("embedder", { state: "ready", pct: 100, error: null }, true);
        return pipe;
      } catch (e) {
        await _writeStatus("embedder", { state: "error", error: String(e.message || e).slice(0, 200) }, true);
        _embedderPromise = null; // next embed attempt retries the download
        throw e;
      }
    })();
  }
  return _embedderPromise;
}

// Embed texts locally. Returns unit vectors zero-padded to `dims` (cosine is
// unchanged by zero-padding, and data_vectors is fixed at vector(1536)).
async function localEmbed(texts, { query = false, dims = 1536 } = {}) {
  const pipe = await ensureLocalEmbedder();
  const framed = texts.map((t) =>
    query ? `task: search result | query: ${t}` : `title: none | text: ${t}`);
  const out = await pipe(framed, { pooling: "mean", normalize: true });
  const rows = out.tolist();
  // The tensor owns a native buffer that V8 cannot see, so a batch's worth of
  // memory looks free to the GC and is never reclaimed. Indexing a mailbox
  // then grows the process by hundreds of MB per batch until the kernel kills
  // it, with no error logged anywhere. Hand it back explicitly.
  try { out.dispose(); } catch (_) {}
  return rows.map((v) => {
    if (v.length >= dims) return v.slice(0, dims);
    return v.concat(new Array(dims - v.length).fill(0));
  });
}

// --- Reranker ----------------------------------------------------------------

let _rerankerPromise = null;

function ensureLocalReranker() {
  if (!_rerankerPromise) {
    _rerankerPromise = (async () => {
      // Not the text-classification pipeline: this reranker has a single-logit
      // regression head, and a softmax over one logit collapses every score to
      // 1.0. Jina's documented usage is raw logits + sigmoid.
      const { AutoTokenizer, AutoModelForSequenceClassification, env } = require("@huggingface/transformers");
      env.cacheDir = MODELS_DIR;
      await _writeStatus("reranker", { state: "downloading", model: RERANK_ID(), pct: 0 }, true);
      try {
        const tokenizer = await AutoTokenizer.from_pretrained(RERANK_ID(), {
          progress_callback: _progressCallback("reranker"),
        });
        const model = await AutoModelForSequenceClassification.from_pretrained(RERANK_ID(), {
          dtype: "q8",
          progress_callback: _progressCallback("reranker"),
        });
        await _writeStatus("reranker", { state: "ready", pct: 100, error: null }, true);
        return { tokenizer, model };
      } catch (e) {
        await _writeStatus("reranker", { state: "error", error: String(e.message || e).slice(0, 200) }, true);
        _rerankerPromise = null;
        throw e;
      }
    })();
  }
  return _rerankerPromise;
}

// Score query/document pairs locally; returns an array of scores in [0,1]
// (higher = more relevant), same order as docs.
async function localRerankScores(query, docs) {
  const { tokenizer, model } = await ensureLocalReranker();
  const inputs = tokenizer(docs.map(() => query), {
    text_pair: docs,
    padding: true,
    truncation: true,
  });
  const { logits } = await model(inputs);
  return logits.sigmoid().tolist().map((row) => (Array.isArray(row) ? row[0] : row));
}

// Boot preload: called from index.js when the conf says a local model is in
// play, so a restart never waits for a download mid-request.
function preloadIfConfigured() {
  setTimeout(async () => {
    try {
      const { getConf } = require("./config");
      const embedModel = process.env.EMBED_MODEL || (await getConf("EMBED_MODEL"));
      if (String(embedModel || "").startsWith(LOCAL_PREFIX)) ensureLocalEmbedder().catch(() => {});
      const rerankModel = process.env.RERANK_MODEL || (await getConf("RERANK_MODEL"));
      if (String(rerankModel || "").startsWith(LOCAL_PREFIX)) ensureLocalReranker().catch(() => {});
    } catch (_) {}
  }, 3000); // after boot settles; harmless if config isn't ready yet
}

module.exports = { LOCAL_PREFIX, MODELS_DIR, ensureLocalEmbedder, ensureLocalReranker, localEmbed, localRerankScores, preloadIfConfigured };
