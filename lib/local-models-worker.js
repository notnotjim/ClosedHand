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
const { pipeline, AutoTokenizer, AutoProcessor, AutoModelForSequenceClassification, RawImage, env } = require("@huggingface/transformers");

env.cacheDir = workerData.modelsDir;

const { embedder: spec, rerankId, dtype, sessionOptions } = workerData;

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

// The embedder as one function: framed texts in, unit vectors out.
async function embedder() {
  if (!_embedder) {
    _embedder = (spec.runner === "eg2" ? gemma2Text() : pipelineEmbedder()).catch((e) => { _embedder = null; throw e; });
  }
  return _embedder;
}

async function pipelineEmbedder() {
  const pipe = await pipeline("feature-extraction", spec.repo, {
    dtype,
    // enableCpuMemArena stays FALSE, and the memory number alone is not the
    // reason. ORT's arena keeps every block it ever allocates, so a run
    // settles at the high-water mark of the whole indexing pass rather than
    // the cost of one batch, which killed the process on a small box.
    //
    // Measured trade, same machine, same config: arena off is 1604ms median
    // per embed at 602MB resident; arena on is 840ms at 1424MB. So leaving it
    // off costs about 2x latency and saves about 800MB.
    //
    // It stays off because the failure modes are asymmetric. Since inference
    // moved to this worker, slow no longer means deaf: the bot stays
    // responsive while embedding, so latency degrades an experience. Running
    // out of memory on a 2GB VPS ends one. Revisit only if someone reports
    // the latency as a real problem in practice, not on the memory number.
    session_options: { ...sessionOptions, enableCpuMemArena: false },
    progress_callback: progress("embedder"),
  });
  return async (framed) => {
    const out = await pipe(framed, { pooling: "mean", normalize: true });
    const rows = out.tolist();
    // Same native-buffer problem as before: the tensor holds memory V8 cannot
    // see, so nothing puts the GC under pressure. Hand it back explicitly.
    try { out.dispose(); } catch (_) {}
    return rows;
  };
}

// EmbeddingGemma 2 for text: its text part alone, run with ONNX Runtime
// directly, because transformers.js's loader for this model insists on the
// picture and sound parts too (another 510MB nobody indexing mail needs). The
// part takes the token ids and, empty here, the features pictures and sound
// would add, and gives the finished sentence embedding (the same vector
// transformers.js returns, checked to the fifth decimal). Arena off, as above.
// The text part is loaded once and shared with pictures and sound.
let _gemma2 = null;
function gemma2Core() {
  if (!_gemma2) {
    _gemma2 = (async () => {
      const { ensureFiles } = require("./model-files");
      const report = progress("embedder");
      await ensureFiles(workerData.modelsDir, spec, spec.files.text, (p) => report({ status: "progress", file: p.file, loaded: p.loaded, total: p.total }));
      const ort = require("onnxruntime-node");
      const session = await ort.InferenceSession.create(require("path").join(workerData.modelsDir, spec.repo, "onnx", "model_quantized.onnx"),
        { ...sessionOptions, enableCpuMemArena: false });
      return { ort, session };
    })().catch((e) => { _gemma2 = null; throw e; });
  }
  return _gemma2;
}

async function gemma2Text() {
  const { ort, session } = await gemma2Core();
  const tokenizer = await AutoTokenizer.from_pretrained(spec.repo, { local_files_only: true });
  const none = () => new ort.Tensor("float32", new Float32Array(0), [0, 512]);
  return async (framed) => {
    const enc = tokenizer(framed, { padding: true, truncation: true, max_length: 2048 });
    const out = await session.run({
      input_ids: new ort.Tensor("int64", enc.input_ids.data, enc.input_ids.dims),
      attention_mask: new ort.Tensor("int64", enc.attention_mask.data, enc.attention_mask.dims),
      image_features: none(), video_features: none(), audio_features: none(),
    }, ["sentence_embedding"]);
    const e = out.sentence_embedding, width = e.dims[1], rows = [];
    for (let i = 0; i < e.dims[0]; i++) {
      const v = Array.from(e.data.subarray(i * width, (i + 1) * width));
      const norm = Math.hypot(...v) || 1;
      rows.push(v.map((x) => x / norm));
    }
    return rows;
  };
}

// EmbeddingGemma 2 for pictures and sound, into the same space as text, so a
// written search finds a photo by what it shows and a recording by what is
// heard. Each part is fetched the first time it is needed: its encoder turns
// the picture or sound into features, and the shared text part turns those
// into the sentence embedding. Pictures go in at 140 tokens rather than the
// default 280: half the time (about 3 s against 7 s on a laptop) for a vector
// 0.98 alike. The two encoders hold about 700 MB between them, so they are
// let go after five minutes without a picture or a sound, and loaded again
// (from disk, in seconds) when the next one comes.
const MEDIA_IDLE_MS = 5 * 60000;
let _media = null, _mediaIdle = null;
const _encoders = {};
async function mediaParts(kind) {
  if (!_media) {
    _media = (async () => {
      const { ensureFiles } = require("./model-files");
      const report = progress("media");
      await ensureFiles(workerData.modelsDir, spec, spec.files.vision.filter((f) => !f.path.startsWith("onnx/")), (p) => report({ status: "progress", file: p.file, loaded: p.loaded, total: p.total }));
      const { ort, session: text } = await gemma2Core();
      const processor = await AutoProcessor.from_pretrained(spec.repo, { local_files_only: true });
      processor.image_processor.max_soft_tokens = 140;
      return { ort, processor, text };
    })().catch((e) => { _media = null; throw e; });
  }
  const parts = await _media;
  if (!_encoders[kind]) {
    _encoders[kind] = (async () => {
      const { ensureFiles } = require("./model-files");
      const report = progress("media");
      await ensureFiles(workerData.modelsDir, spec, spec.files[kind === "image" ? "vision" : "audio"], (p) => report({ status: "progress", file: p.file, loaded: p.loaded, total: p.total }));
      const name = kind === "image" ? "vision_encoder_quantized.onnx" : "audio_encoder_quantized.onnx";
      return parts.ort.InferenceSession.create(require("path").join(workerData.modelsDir, spec.repo, "onnx", name), { ...sessionOptions, enableCpuMemArena: false });
    })().catch((e) => { delete _encoders[kind]; throw e; });
  }
  return { ...parts, encoder: await _encoders[kind] };
}

function releaseMedia() {
  _mediaIdle = null;
  for (const [kind, loading] of Object.entries(_encoders)) {
    delete _encoders[kind];
    loading.then((session) => session.release()).catch(() => {});
  }
  _media = null;
}

async function embedMedia(args) {
  clearTimeout(_mediaIdle);
  try { return await embedMediaNow(args); }
  finally { _mediaIdle = setTimeout(releaseMedia, MEDIA_IDLE_MS); }
}

async function embedMediaNow({ kind, data }) {
  if (spec.runner !== "eg2") throw new Error("Pictures and sound are embedded by EmbeddingGemma 2 only");
  const { ort, processor, text, encoder } = await mediaParts(kind);
  const T = (t) => new ort.Tensor(t.type, t.data, t.dims);
  const none = () => new ort.Tensor("float32", new Float32Array(0), [0, 512]);
  let inputs, features;
  if (kind === "image") {
    const image = await RawImage.fromBlob(new Blob([Buffer.from(data)]));
    inputs = await processor("<|image|>", [image]);
    features = { image_features: (await encoder.run({ pixel_values: T(inputs.pixel_values), pixel_position_ids: T(inputs.image_position_ids) })).image_features, video_features: none(), audio_features: none() };
  } else {
    inputs = await processor("<|audio|>", null, [data instanceof Float32Array ? data : new Float32Array(data)]);
    features = { image_features: none(), video_features: none(), audio_features: (await encoder.run({ input_features: T(inputs.input_features), input_features_mask: T(inputs.input_features_mask) })).audio_features };
  }
  const out = await text.run({ input_ids: T(inputs.input_ids), attention_mask: T(inputs.attention_mask), ...features }, ["sentence_embedding"]);
  const v = Array.from(out.sentence_embedding.data);
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
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
    const run = await embedder();
    return run(framed);
  },

  async embedMedia(args) {
    return embedMedia(args);
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
