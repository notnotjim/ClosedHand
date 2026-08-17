// lib/local-models-worker.js — runs local inference off the main thread.
//
// onnxruntime-node's run() returns a Promise but does not yield the event loop:
// measured against controls, time spent inside it is indistinguishable from a
// pure-JS busy loop, 0% loop availability throughout. On the main thread that
// means the bot cannot answer a message, fire a timer or serve a request while
// it embeds, and indexing a mailbox is minutes of exactly that.
//
// So the models live here instead. This thread does one thing: load models and
// run them. It deliberately does NOT touch the database, write status, or read
// runtime config; download progress is posted to the parent, which owns all of
// that already. Keeping it to inference is what makes the change reviewable.

const { parentPort, workerData } = require("worker_threads");
const { pipeline, AutoTokenizer, AutoModelForSequenceClassification, env } = require("@huggingface/transformers");

env.cacheDir = workerData.modelsDir;

const { embedId, rerankId, dtype, sessionOptions } = workerData;

let _embedder = null;
let _reranker = null;

// Progress belongs to the parent: it is the one with the database handle and
// the status row. This just reports.
function progress(role) {
  return (p) => {
    if (!p || !p.status) return;
    parentPort.postMessage({ type: "progress", role, status: p.status, file: p.file, loaded: p.loaded, total: p.total, pct: p.progress });
  };
}

async function embedder() {
  if (!_embedder) {
    _embedder = pipeline("feature-extraction", embedId, {
      dtype,
      session_options: sessionOptions,
      progress_callback: progress("embedder"),
    }).catch((e) => { _embedder = null; throw e; });
  }
  return _embedder;
}

async function reranker() {
  if (!_reranker) {
    _reranker = (async () => {
      const tokenizer = await AutoTokenizer.from_pretrained(rerankId, { progress_callback: progress("reranker") });
      const model = await AutoModelForSequenceClassification.from_pretrained(rerankId, {
        dtype: "q8",
        session_options: sessionOptions,
        progress_callback: progress("reranker"),
      });
      return { tokenizer, model };
    })().catch((e) => { _reranker = null; throw e; });
  }
  return _reranker;
}

const OPS = {
  async embed({ framed }) {
    const pipe = await embedder();
    const out = await pipe(framed, { pooling: "mean", normalize: true });
    const rows = out.tolist();
    // Same native-buffer problem as before: the tensor holds memory V8 cannot
    // see, so nothing puts the GC under pressure. Hand it back explicitly.
    try { out.dispose(); } catch (_) {}
    return rows;
  },

  async rerank({ query, docs }) {
    const { tokenizer, model } = await reranker();
    const inputs = tokenizer(docs.map(() => query), { text_pair: docs, padding: true, truncation: true });
    const { logits } = await model(inputs);
    return logits.sigmoid().tolist().map((row) => (Array.isArray(row) ? row[0] : row));
  },

  async preload({ which }) {
    if (which === "embedder") await embedder();
    else await reranker();
    return true;
  },
};

parentPort.on("message", async (msg) => {
  const { id, op, args } = msg;
  try {
    const handler = OPS[op];
    if (!handler) throw new Error(`unknown op: ${op}`);
    const result = await handler(args || {});
    parentPort.postMessage({ id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: String((e && e.message) || e).slice(0, 300) });
  }
});
