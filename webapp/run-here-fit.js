// Whether an LLM someone picked for a job can run on this computer instead
// ("Run it here", run-here.js), worked out from public facts: the model's
// files and shape on Hugging Face, and this computer's chip, memory and disk.
// There is no list of approved models. Every estimate leans against the
// model, and the offer is made only when all of the checks below pass, so it
// appears rarely and only where the model will plainly be fast.

const GB = 1e9;

// Apple chips: memory bandwidth (GB/s, as Apple publishes it) and GPU
// compute (TFLOPS, from the GPU's core count at that generation's measured
// rate per core; Apple doesn't publish it). For a chip sold with fewer GPU
// cores, the smaller figures. The M5's Neural Accelerators aren't counted.
// A chip not listed (a newer one, or an Intel Mac) gets no offer. Linux
// with an NVIDIA card is a later step: Closedhand doesn't ship a runner
// there yet, and Docker on a Mac can't reach the GPU at all.
const CHIPS = {
  "M1": [68, 2.3], "M1 Pro": [200, 4.5], "M1 Max": [400, 7.8], "M1 Ultra": [800, 15.9],
  "M2": [100, 2.9], "M2 Pro": [200, 5.7], "M2 Max": [400, 10.7], "M2 Ultra": [800, 21.4],
  "M3": [100, 3.3], "M3 Pro": [150, 5.6], "M3 Max": [300, 14.2], "M3 Ultra": [819, 25.6],
  "M4": [120, 3.4], "M4 Pro": [273, 7.4], "M4 Max": [410, 14.7],
  "M5": [153, 3.8], "M5 Pro": [307, 6.9], "M5 Max": [460, 13.8],
};
function chipOf(brand) {
  const m = /Apple (M\d)(?: (Pro|Max|Ultra))?\b/.exec(String(brand || ""));
  const name = m ? (m[2] ? `${m[1]} ${m[2]}` : m[1]) : null;
  return name && CHIPS[name] ? { name, bandwidth: CHIPS[name][0] * GB, compute: CHIPS[name][1] * 1e12 } : null;
}

// What each job asks of a model. Measured on a real Closedhand over 30 days
// (token_usage): chat averaged 33,400 tokens in per call, support work
// 15,100, images 900. Chat's long prompts mostly repeat the instructions and
// earlier turns, which the runner keeps cached, so a fresh 4,096 tokens is
// counted against it; support work is mostly new text each time. A person
// waits on chat and images, so their first words must come within seconds;
// support work runs in the background and is allowed longer.
const JOBS = {
  chat: { context: 65536, fresh: 4096, firstSeconds: 4, tokensPerSecond: 40 },
  background: { context: 32768, fresh: 15000, firstSeconds: 20, tokensPerSecond: 25 },
  vision: { context: 8192, fresh: 1500, firstSeconds: 4, tokensPerSecond: 25 },
};

// Closedhand's own parts while a model runs: its database, the two services,
// the recall and voice models. About 1.7 GB measured idle; 4 GB allowed.
const OWN_BYTES = 4 * GB;
const WORKING_BYTES = 0.5 * GB;   // the runner's working buffers
const PROMPT_CACHE_BYTES = 1 * GB; // kept prompts (llama-server -cram 1024)
const MEMORY_SHARE = 0.5;
const DISK_SHARE = 0.5;
// How much of the chip's bandwidth and compute the runner gets. Measured on
// an M2 with a small model and a 15,000-token prompt: 0.27 of the bandwidth
// while writing and 0.44 of the compute while reading (attention included).
// Less than both is counted.
const DECODE_SHARE = 0.25;
const PREFILL_SHARE = 0.3;

// A GGUF file's quantization, from its name. Below 4 bits is too lossy and
// 16-bit is pointless here; the old ARM repacks (Q4_0_4_4 and so on) no
// longer load.
const QUANT = /(?:^|[-_.])((?:UD-)?(?:IQ|Q)(\d)(?:_[A-Z0-9]+)*|MXFP4(?:_MOE)?|BF16|F16|F32)$/i;
const PREFERRED = ["Q8_0", "Q6_K", "Q5_K_M", "Q4_K_M"];
function quantOf(file) {
  const base = String(file).split("/").pop().replace(/\.gguf$/i, "").replace(/-\d{5}-of-\d{5}$/, "");
  if (/mmproj/i.test(base)) return null;
  const m = QUANT.exec(base);
  if (!m) return null;
  const label = m[1].toUpperCase();
  if (/^Q4_0_\d_\d$/.test(label)) return null;
  const bits = /^MXFP4/.test(label) ? 4 : /^(?:B?F16)$/.test(label) ? 16 : label === "F32" ? 32 : Number(m[2]);
  if (bits < 4 || bits > 8) return null;
  const rank = PREFERRED.indexOf(label.replace(/^UD-/, ""));
  return { label, bits, rank: rank < 0 ? PREFERRED.length : rank };
}
// A model's files grouped by quantization: one file, or every part of a
// split one, with their total size.
function quantizations(files) {
  const groups = new Map();
  for (const f of files) {
    if (!/\.gguf$/i.test(f.path)) continue;
    const q = quantOf(f.path);
    if (!q) continue;
    const key = f.path.replace(/-\d{5}-of-\d{5}(\.gguf)$/i, "$1");
    if (!groups.has(key)) groups.set(key, { ...q, files: [], bytes: 0 });
    const g = groups.get(key);
    g.files.push(f);
    g.bytes += f.size;
  }
  for (const g of groups.values()) {
    g.files.sort((a, b) => a.path.localeCompare(b.path));
    const parts = /-(\d{5})-of-(\d{5})\.gguf$/i.exec(g.files[0].path);
    g.complete = !parts || g.files.length === Number(parts[2]);
  }
  return [...groups.values()].filter(g => g.complete).sort((a, b) => b.bits - a.bits || a.rank - b.rank || a.bytes - b.bytes);
}
// The image part of a model, when its repository has one.
function projectorOf(files) {
  const found = files.filter(f => /mmproj.*\.gguf$/i.test(f.path));
  return found.sort((a, b) => (/f16/i.test(b.path) - /f16/i.test(a.path)) || a.size - b.size)[0] || null;
}

// The shape that decides speed and memory, from the model's config.json.
// A mixture of experts is judged only when its expert width is published
// and every layer has experts; any other design is declined, since its share
// of weights per word can't be worked out from the config.
function shapeOf(config, totalParams, contextLength) {
  const c = config?.text_config || config?.language_config || config || {};
  const layers = Number(c.num_hidden_layers || c.n_layer || c.num_layers) || null;
  const heads = Number(c.num_attention_heads || c.n_head) || null;
  const kvHeads = Number(c.num_key_value_heads || c.n_head_kv) || heads;
  const hidden = Number(c.hidden_size || c.n_embd || c.d_model) || null;
  const headDim = Number(c.head_dim) || (hidden && heads ? hidden / heads : null);
  const experts = Number(c.num_experts || c.num_local_experts || c.n_routed_experts) || 0;
  const perToken = Number(c.num_experts_per_tok || c.moe_topk || c.num_experts_per_token) || 0;
  const expertWidth = Number(c.moe_intermediate_size || c.expert_intermediate_size || c.intermediate_size) || 0;
  const dense = Number(c.first_k_dense_replace) || 0;
  let active = totalParams, unknown = false;
  const interleaved = Number(c.interleave_moe_layer_step) > 1 || Number(c.decoder_sparse_step) > 1
    || (Array.isArray(c.mlp_only_layers) && c.mlp_only_layers.length > 0) || Number(c.moe_layer_freq) > 1;
  if (experts > 1 && (!c.moe_intermediate_size && !c.expert_intermediate_size || interleaved || !(perToken > 0))) unknown = true;
  else if (experts > 1 && perToken < experts && layers && hidden && expertWidth) {
    const moeLayers = Math.max(0, layers - dense);
    const perExpert = 3 * hidden * expertWidth;
    const allExperts = moeLayers * experts * perExpert;
    const estimate = totalParams - allExperts + moeLayers * perToken * perExpert;
    if (estimate > 0 && estimate < totalParams) active = estimate;
  }
  const kvPerToken = layers && kvHeads && headDim ? 2 * layers * kvHeads * headDim * 2 : null;
  // The smaller of what the GGUF and the config say the model can take.
  const lengths = [contextLength, c.max_position_embeddings || c.max_sequence_length || c.seq_length].map(Number).filter(n => n > 0);
  const maxContext = lengths.length ? Math.min(...lengths) : null;
  // Reading a long prompt also costs attention over everything before each
  // token, which grows with the prompt and matters most for small models.
  const attnWidth = heads && headDim ? heads * headDim : null;
  return { totalParams, activeParams: active, kvPerToken, maxContext, layers, attnWidth, unknown };
}

// The estimate for one job with one file on this computer, and every reason
// it falls short. ok only when there are none. hw.reservedBytes is what LLMs
// already running there take: they and this one share the half.
function judge(jobName, quant, shape, hw, projector = null) {
  const job = JOBS[jobName];
  const reasons = [];
  if (!job) return { ok: false, reasons: ["unknown job"] };
  if (!hw?.chip) reasons.push("this computer's chip isn't one Closedhand can judge");
  if (!shape?.totalParams || !shape.kvPerToken || !shape.attnWidth || shape.unknown) reasons.push("the model's size or shape isn't published");
  if (!shape?.maxContext || shape.maxContext < job.context) reasons.push("the model can't take a long enough prompt for this job");
  if (quant.bits < 4) reasons.push("only versions below 4 bits");
  if (jobName === "vision" && !projector) reasons.push("no image part to run it with");
  if (reasons.length) return { ok: false, reasons };
  const bitsPerWeight = (quant.bytes * 8) / shape.totalParams;
  const downloadBytes = quant.bytes + (jobName === "vision" ? projector.size : 0);
  const memoryBytes = downloadBytes + shape.kvPerToken * job.context + WORKING_BYTES + PROMPT_CACHE_BYTES + OWN_BYTES;
  const decodeBytes = shape.activeParams * bitsPerWeight / 8 + shape.kvPerToken * job.fresh;
  const tokensPerSecond = DECODE_SHARE * hw.chip.bandwidth / decodeBytes;
  const prefill = PREFILL_SHARE * hw.chip.compute / (2 * shape.activeParams + 2 * shape.layers * shape.attnWidth * job.fresh);
  const firstSeconds = job.fresh / prefill;
  if (memoryBytes + (hw.reservedBytes || 0) > MEMORY_SHARE * hw.memoryBytes) reasons.push("it would take more than half of this computer's memory");
  if (downloadBytes > DISK_SHARE * hw.freeDiskBytes) reasons.push("it would take more than half of the free disk space");
  if (tokensPerSecond < job.tokensPerSecond) reasons.push("it would write too slowly");
  if (firstSeconds > job.firstSeconds) reasons.push("it would take too long to read the prompt");
  return { ok: !reasons.length, reasons, estimate: { memoryBytes, downloadBytes, tokensPerSecond, firstSeconds, prefillPerSecond: prefill } };
}
// The best version that passes: the most bits that still fit and stay fast.
// reservedFor(version) is what LLMs already running there take, apart from
// the runner that version would share.
function pick(jobName, quants, shape, hw, projector = null, reservedFor = null) {
  let first = null;
  for (const q of quants) {
    const verdict = judge(jobName, q, shape, reservedFor ? { ...hw, reservedBytes: reservedFor(q) } : hw, projector);
    if (verdict.ok) return { quant: q, ...verdict };
    if (!first) first = verdict;
  }
  return first ? { quant: null, ...first, ok: false } : { quant: null, ok: false, reasons: ["no 4-bit or better version to download"] };
}
// What a measured run on this computer must reach before the job switches:
// the same promise the offer made.
function keepsPromise(jobName, timings) {
  const job = JOBS[jobName];
  const prompt = Number(timings?.prompt_per_second), write = Number(timings?.predicted_per_second);
  if (!(prompt > 0) || !(write > 0)) return false;
  return job.fresh / prompt <= job.firstSeconds && write >= job.tokensPerSecond;
}

module.exports = { CHIPS, JOBS, OWN_BYTES, chipOf, quantOf, quantizations, projectorOf, shapeOf, judge, pick, keepsPromise };
