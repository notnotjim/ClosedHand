// "Run it here" (webapp/run-here.js, run-here-fit.js): an LLM someone picked
// for a job is offered to run on this computer only when it plainly fits and
// will be fast, worked out from public facts with no list of models; and a
// job run here falls back to the person's provider whenever its runner isn't
// answering. Models, repositories and numbers below are invented.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const fit = require("../webapp/run-here-fit");
const GB = 1e9;

// An invented mixture of experts shaped like the common 30B-total, 3B-active kind.
const MOE_CONFIG = { num_hidden_layers: 48, num_attention_heads: 32, num_key_value_heads: 4, head_dim: 128, hidden_size: 2048,
  num_experts: 128, num_experts_per_tok: 8, moe_intermediate_size: 768, max_position_embeddings: 262144 };
const MOE_TOTAL = 30.5e9;
// And an invented small dense model, about 1.5B.
const SMALL_CONFIG = { num_hidden_layers: 28, num_attention_heads: 12, num_key_value_heads: 2, hidden_size: 1536, max_position_embeddings: 32768 };
const SMALL_TOTAL = 1.54e9;
const big = (gb, brand) => ({ chip: fit.chipOf(brand), memoryBytes: gb * GB, freeDiskBytes: 900 * GB });

test("the hardware table knows Apple's chips by name and nothing else", () => {
  assert.equal(fit.chipOf("Apple M2").bandwidth, 100 * GB);
  assert.equal(fit.chipOf("Apple M4 Max").bandwidth, 410 * GB, "the smaller of the Max's two figures");
  assert.equal(fit.chipOf("Apple M3 Ultra").compute, 25.6e12);
  assert.equal(fit.chipOf("Apple M9 Pro"), null, "a chip not listed gets no offer");
  assert.equal(fit.chipOf("Intel(R) Core(TM) i7"), null);
});

test("versions are read from file names, 4 to 8 bits, split files kept together", () => {
  assert.deepEqual(fit.quantOf("Example-7B-Q4_K_M.gguf"), { label: "Q4_K_M", bits: 4, rank: 3 });
  assert.equal(fit.quantOf("Example-7B-UD-Q4_K_XL.gguf").bits, 4);
  assert.equal(fit.quantOf("Example-7B-IQ4_XS.gguf").bits, 4);
  assert.equal(fit.quantOf("Example-7B-Q8_0.gguf").label, "Q8_0");
  assert.equal(fit.quantOf("Example-7B-Q3_K_M.gguf"), null, "below 4 bits");
  assert.equal(fit.quantOf("Example-7B-f16.gguf"), null, "16-bit");
  assert.equal(fit.quantOf("Example-7B-Q4_0_4_4.gguf"), null, "old ARM repack");
  assert.equal(fit.quantOf("mmproj-Example-7B-f16.gguf"), null, "the image part is not a version");
  const groups = fit.quantizations([
    { path: "Q6_K/Example-Q6_K-00001-of-00002.gguf", size: 10 }, { path: "Q6_K/Example-Q6_K-00002-of-00002.gguf", size: 5 },
    { path: "Example-Q4_K_M.gguf", size: 8 }, { path: "Example-Q4_K_S.gguf", size: 7 },
    { path: "Q8_0/Example-Q8_0-00001-of-00003.gguf", size: 9 },
  ]);
  assert.deepEqual(groups.map(g => [g.label, g.bytes, g.files.length]), [["Q6_K", 15, 2], ["Q4_K_M", 8, 1], ["Q4_K_S", 7, 1]], "an incomplete split is left out");
});

test("a mixture of experts counts only the weights each word uses", () => {
  const shape = fit.shapeOf(MOE_CONFIG, MOE_TOTAL);
  assert.ok(Math.abs(shape.activeParams - 3.3e9) < 0.1e9, `active ${shape.activeParams}`);
  assert.equal(shape.kvPerToken, 2 * 48 * 4 * 128 * 2);
  assert.equal(shape.maxContext, 262144);
  assert.equal(fit.shapeOf({ num_hidden_layers: 4, num_experts: 8 }, 1e9).activeParams, 1e9, "unknown expert shape counts every weight");
  assert.equal(fit.shapeOf({ text_config: MOE_CONFIG }, MOE_TOTAL).kvPerToken, shape.kvPerToken, "a model with an image part keeps its text shape inside");
});

test("the offer needs room to spare and speed, judged against the job", () => {
  const moe = fit.shapeOf(MOE_CONFIG, MOE_TOTAL), small = fit.shapeOf(SMALL_CONFIG, SMALL_TOTAL);
  const q4 = { label: "Q4_K_M", bits: 4, rank: 3, bytes: 18.6 * GB }, smallQ4 = { label: "Q4_K_M", bits: 4, rank: 3, bytes: 1.1 * GB };
  const eight = fit.judge("background", q4, moe, big(8, "Apple M2"));
  assert.equal(eight.ok, false);
  assert.ok(eight.reasons.includes("it would take more than half of this computer's memory"));
  assert.ok(eight.reasons.includes("it would take too long to read the prompt"));
  // Pessimistic on purpose: even the biggest Mac doesn't get a 30B model with
  // 3B weights per word, for chat (4.4 s to read against 4) or support work (24.5 s against 20).
  const ultra = big(192, "Apple M3 Ultra");
  assert.deepEqual(fit.judge("chat", q4, moe, ultra).reasons, ["it would take too long to read the prompt"]);
  assert.deepEqual(fit.judge("background", q4, moe, ultra).reasons, ["it would take too long to read the prompt"]);
  const fine = fit.judge("background", smallQ4, small, big(64, "Apple M4 Max"));
  assert.equal(fine.ok, true, fine.reasons.join("; "));
  assert.ok(fine.estimate.firstSeconds < 20 && fine.estimate.tokensPerSecond >= 25);
  assert.equal(fit.judge("background", smallQ4, small, big(48, "Apple M4 Pro")).ok, false, "a Pro reads 15,000 tokens too slowly by this count");
  const noDisk = fit.judge("background", smallQ4, small, { ...big(64, "Apple M4 Max"), freeDiskBytes: 2 * GB });
  assert.ok(noDisk.reasons.includes("it would take more than half of the free disk space"));
  assert.ok(fit.judge("vision", smallQ4, small, big(64, "Apple M4 Max")).reasons.includes("no image part to run it with"));
  assert.ok(fit.judge("chat", smallQ4, small, big(64, "Apple M4 Max")).reasons.includes("the model can't take a long enough prompt for this job"), "chat needs 65,536 tokens");
  assert.ok(fit.judge("background", smallQ4, small, big(64, "Apple M9")).reasons.includes("this computer's chip isn't one Closedhand can judge"));
  // The run measured on an 8 GB M2 (0.5B model, 15,001 tokens): read in 19.3 s
  // and wrote 44 a second. The estimate must not promise more than that.
  const measured = fit.judge("background", { label: "Q4_0", bits: 4, rank: 9, bytes: 0.429 * GB },
    fit.shapeOf({ num_hidden_layers: 24, num_attention_heads: 14, num_key_value_heads: 2, hidden_size: 896, max_position_embeddings: 32768 }, 0.494e9), big(8, "Apple M2"));
  assert.ok(measured.estimate.firstSeconds > 19.3 && measured.estimate.tokensPerSecond < 44, JSON.stringify(measured.estimate));
});

test("the most bits that still pass are picked, and a measured run must keep the promise", () => {
  const shape = fit.shapeOf(SMALL_CONFIG, SMALL_TOTAL);
  const quants = [{ label: "Q8_0", bits: 8, rank: 0, bytes: 1.65 * GB }, { label: "Q4_K_M", bits: 4, rank: 3, bytes: 1.1 * GB }];
  assert.equal(fit.pick("background", quants, shape, big(64, "Apple M4 Max")).quant.label, "Q8_0");
  assert.equal(fit.pick("background", quants, shape, { ...big(64, "Apple M4 Max"), freeDiskBytes: 3 * GB }).quant.label, "Q4_K_M", "Q8 would take more than half the free disk");
  assert.equal(fit.pick("background", quants, shape, big(8, "Apple M2")).ok, false);
  assert.equal(fit.keepsPromise("background", { prompt_per_second: 1500, predicted_per_second: 60 }), true);
  assert.equal(fit.keepsPromise("background", { prompt_per_second: 500, predicted_per_second: 60 }), false, "15,000 tokens in 30 seconds");
  assert.equal(fit.keepsPromise("chat", { prompt_per_second: 5000, predicted_per_second: 30 }), false, "chat writes at 40 or more");
  assert.equal(fit.keepsPromise("chat", {}), false);
});

// Hugging Face and OpenRouter, answered from invented data.
function hub({ gated = false } = {}) {
  const calls = [];
  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  const impl = async (url) => {
    calls.push(String(url));
    const u = new URL(url);
    if (u.hostname === "openrouter.ai") return json({ data: [{ id: "examplelab/example-30b-a3b", hugging_face_id: "examplelab/Example-30B-A3B" },
      { id: "examplelab/example-1.5b", hugging_face_id: "examplelab/Example-1.5B" }, { id: "closedco/secret-model", hugging_face_id: "" }] });
    if (u.pathname === "/api/models/examplelab/Example-1.5B") return json({ id: "examplelab/Example-1.5B", sha: "f".repeat(40), gated: false, safetensors: { total: SMALL_TOTAL } });
    if (u.pathname === `/examplelab/Example-1.5B/resolve/${"f".repeat(40)}/config.json`) return json(SMALL_CONFIG);
    if (u.pathname === "/api/models" && u.searchParams.getAll("filter").includes("base_model:quantized:examplelab/Example-1.5B")) return json([{ id: "quantfolk/Example-1.5B-GGUF" }]);
    if (u.pathname === "/api/models/quantfolk/Example-1.5B-GGUF") return json({ id: "quantfolk/Example-1.5B-GGUF", sha: "9".repeat(40), gated: false });
    if (u.pathname === `/api/models/quantfolk/Example-1.5B-GGUF/tree/${"9".repeat(40)}`) return json([
      { type: "file", path: "Example-1.5B-Q4_K_M.gguf", size: 1.1 * GB, lfs: { oid: "8".repeat(64) } },
      { type: "file", path: "Example-1.5B-Q8_0.gguf", size: 1.65 * GB, lfs: { oid: "7".repeat(64) } },
    ]);
    if (u.pathname === "/api/models/examplelab/Example-30B-A3B") return json({ id: "examplelab/Example-30B-A3B", sha: "a".repeat(40), gated, safetensors: { total: MOE_TOTAL } });
    if (u.pathname === `/examplelab/Example-30B-A3B/resolve/${"a".repeat(40)}/config.json`) return json(MOE_CONFIG);
    if (u.pathname === "/api/models" && u.searchParams.getAll("filter").includes("base_model:quantized:examplelab/Example-30B-A3B")) return json([{ id: "lockedfolk/Example-GGUF" }, { id: "quantfolk/Example-30B-A3B-GGUF" }]);
    if (u.pathname === "/api/models/lockedfolk/Example-GGUF") return json({ id: "lockedfolk/Example-GGUF", sha: "b".repeat(40), gated: "manual" });
    if (u.pathname === "/api/models/quantfolk/Example-30B-A3B-GGUF") return json({ id: "quantfolk/Example-30B-A3B-GGUF", sha: "c".repeat(40), gated: false, gguf: { total: MOE_TOTAL, context_length: 262144 } });
    if (u.pathname === `/api/models/quantfolk/Example-30B-A3B-GGUF/tree/${"c".repeat(40)}`) return json([
      { type: "file", path: "Example-30B-A3B-Q4_K_M.gguf", size: 18.6 * GB, lfs: { oid: "d".repeat(64) } },
      { type: "file", path: "Example-30B-A3B-Q3_K_M.gguf", size: 14 * GB, lfs: { oid: "e".repeat(64) } },
      { type: "file", path: "README.md", size: 900 },
    ]);
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { impl, calls };
}

test("a provider's model is traced to its published weights, or isn't offered at all", async () => {
  const runHere = require("../webapp/run-here");
  const { impl, calls } = hub();
  runHere.configure({ fetch: impl });
  assert.equal(await runHere.repoFor({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }, "examplelab/example-30b-a3b:free"), "examplelab/Example-30B-A3B");
  assert.equal(await runHere.repoFor({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }, "closedco/secret-model"), null, "no published weights");
  assert.equal(await runHere.repoFor({ provider: "anthropic", baseUrl: "https://api.anthropic.com/v1" }, "claude-example"), null);
  assert.equal(await runHere.repoFor({ provider: "deepinfra", baseUrl: "https://api.deepinfra.com/v1/openai" }, "examplelab/Example-30B-A3B"), "examplelab/Example-30B-A3B");
  assert.equal(await runHere.repoFor({ provider: "custom", baseUrl: "http://localhost:11434/v1" }, "examplelab/Example-30B-A3B"), null, "already on this computer");
  assert.equal(await runHere.repoFor({ provider: "ollama", baseUrl: "http://localhost:11434/v1" }, "example:30b"), null);
  const model = await runHere.describe("examplelab/Example-30B-A3B");
  assert.equal(model.gguf.repo, "quantfolk/Example-30B-A3B-GGUF", "a gated version is passed over");
  assert.deepEqual(model.quants.map(q => q.label), ["Q4_K_M"], "3-bit is left out");
  assert.equal(model.quants[0].files[0].sha256, "d".repeat(64));
  assert.ok(Math.abs(model.shape.activeParams - 3.3e9) < 0.1e9);
  assert.ok(calls.every(u => /^https:\/\/(huggingface\.co|openrouter\.ai)\//.test(u)), "only Hugging Face and OpenRouter are asked");
  runHere.configure({ fetch: hub({ gated: true }).impl });
  assert.match((await runHere.describe("examplelab/Example-30B-A3B")).none, /Hugging Face account/);
});

function profileStore(settings) {
  const db = { settings };
  return {
    db,
    supabase: {
      from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { settings: db.settings }, error: null }) }) }) }),
      rpc: async (_name, { p_set }) => { db.settings = { ...db.settings, ...p_set }; return { data: db.settings, error: null }; },
    },
  };
}

test("offers appear only in the Mac app, for a job whose model fits, once per tried version", async () => {
  const runHere = require("../webapp/run-here");
  const bin = path.join(os.tmpdir(), "run-here-test-llama-server");
  fs.writeFileSync(bin, "");
  const settings = { model_config: { version: 1, connections: { primary: { provider: "openrouter", backend: "custom", baseUrl: "https://openrouter.ai/api/v1", apiKey: "enc:v1:x" } },
    roles: { chat: { connection: "primary", model: "examplelab/example-30b-a3b" }, background: { connection: "primary", model: "examplelab/example-1.5b" }, vision: null } } };
  let state = {};
  const { supabase } = profileStore(settings);
  const env = { ...process.env };
  try {
    process.env.LLAMA_SERVER_BIN = bin; process.env.CLOSEDHAND_DESKTOP = "1"; delete process.env.RUN_HERE_FORCE;
    runHere.configure({ fetch: hub().impl, supabase, getAdminUserId: () => "u", platform: "darwin", arch: "arm64",
      hardware: () => big(64, "Apple M4 Max"), state: { read: async () => state, write: async (s) => { state = s; } } });
    const offered = await runHere.offers(settings);
    assert.deepEqual(Object.keys(offered), ["background"], "the 30B chat model is too slow to start here; no image role");
    assert.equal(offered.background.quant, "Q8_0");
    assert.equal(offered.background.bytes, 1.65 * GB);
    runHere.configure({ hardware: () => big(8, "Apple M2") });
    assert.deepEqual(await runHere.offers(settings), {}, "an 8 GB M2 never qualifies");
    runHere.configure({ hardware: () => big(48, "Apple M4 Pro") });
    assert.deepEqual(await runHere.offers(settings), {}, "a Pro reads 15,000 tokens too slowly by this count");
    runHere.configure({ hardware: () => big(64, "Apple M4 Max"), platform: "linux" });
    assert.deepEqual(await runHere.offers(settings), {}, "Docker and Linux: not yet");
    runHere.configure({ platform: "darwin" });
    assert.deepEqual(await runHere.offers({ model_config: { ...settings.model_config, included: true } }), {}, "Managed Models stay as Closedhand picks them");
    state = { tried: ["background|examplelab/example-1.5b|Q8_0"] };
    assert.deepEqual(await runHere.offers(settings), {}, "a version that ran too slowly here isn't offered again");
  } finally {
    process.env = env;
    fs.rmSync(bin, { force: true });
  }
});

test("a job run here keeps its provider as the fallback, and Settings' form edits the provider", () => {
  const policy = require("../lib/model-policy");
  const settings = { model_config: { connections: {
    primary: { provider: "openrouter", backend: "custom", baseUrl: "https://openrouter.ai/api/v1", apiKey: "router-key" },
    "here-1": { provider: "here", backend: "custom", baseUrl: "http://127.0.0.1:41001/v1", apiKey: "runner-key" } },
    roles: { chat: { connection: "primary", model: "examplelab/example-30b-a3b" },
      background: { connection: "here-1", model: "examplelab/example-30b-a3b", capabilities: { tools: null }, here: { files: ["x.gguf"] },
        fallback: { connection: "primary", model: "examplelab/example-30b-a3b", capabilities: { tools: true } } } } } };
  const role = policy.getRole(settings, "background");
  assert.equal(role.baseUrl, "http://127.0.0.1:41001/v1");
  assert.deepEqual([role.fallback.baseUrl, role.fallback.apiKey, role.fallback.model], ["https://openrouter.ai/api/v1", "router-key", "examplelab/example-30b-a3b"]);
  const pub = policy.publicConfig(settings.model_config);
  assert.equal(pub.roles.background.connection, "primary");
  assert.equal(pub.roles.background.runsHere, true);
  assert.equal(pub.connections["here-1"], undefined, "the runner's connection isn't shown or editable");
  assert.equal(read("lib/model-policy.js"), read("webapp/model-policy.js"));
  assert.equal(read("lib/model-wire.js"), read("webapp/model-wire.js"));
});

test("a request goes to the provider whenever the runner on this computer isn't answering", async () => {
  const wire = require("../lib/model-wire");
  const seen = [];
  const provider = http.createServer((req, res) => {
    let body = ""; req.on("data", c => body += c); req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, model: JSON.parse(body).model });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id: "x", model: "m", choices: [{ index: 0, message: { role: "assistant", content: "from the provider" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  await new Promise(r => provider.listen(0, "127.0.0.1", r));
  const closed = await new Promise(r => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
  const busy = http.createServer((req, res) => { res.statusCode = 503; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ error: { message: "Loading model" } })); });
  await new Promise(r => busy.listen(0, "127.0.0.1", r));
  const refuses = http.createServer((req, res) => { res.statusCode = 400; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ error: { message: "bad" } })); });
  await new Promise(r => refuses.listen(0, "127.0.0.1", r));
  const fallback = { provider: "custom", backend: "custom", baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "provider-key", model: "examplelab/example-30b-a3b", capabilities: {} };
  const here = (port) => ({ provider: "here", backend: "custom", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "runner-key", capabilities: {}, fallback });
  const ask = (conn) => wire.request(conn, { model: "examplelab/example-30b-a3b", max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
  try {
    assert.equal(wire.responseText(await ask(here(closed))), "from the provider", "the runner stopped");
    assert.equal(wire.responseText(await ask(here(busy.address().port))), "from the provider", "the runner is still loading");
    assert.deepEqual(seen.map(s => s.auth), ["Bearer provider-key", "Bearer provider-key"]);
    await assert.rejects(ask(here(refuses.address().port)), /HTTP 400/, "a request the runner refuses is not sent elsewhere");
    assert.equal(seen.length, 2);
  } finally {
    provider.close(); busy.close(); refuses.close();
  }
  assert.match(read("lib/llm.js"), /fallback: opts\.fallback \|\| null,/, "every client built from a role carries it");
});

test("the download is resumable and kept only when its checksum matches", async () => {
  const runHere = require("../webapp/run-here");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-here-dl-"));
  const body = Buffer.from("an invented model file, nothing more ".repeat(50));
  const sha = require("node:crypto").createHash("sha256").update(body).digest("hex");
  const ranges = [];
  runHere.configure({ fetch: async (url, opts = {}) => {
    const range = opts.headers?.Range;
    ranges.push(range || null);
    const from = range ? Number(/bytes=(\d+)-/.exec(range)[1]) : 0;
    const part = body.subarray(from);
    return { ok: true, status: range ? 206 : 200, body: (async function* () { yield part.subarray(0, 100); yield part.subarray(100); })() };
  } });
  try {
    const dest = path.join(dir, "m.gguf");
    fs.writeFileSync(dest + ".part", body.subarray(0, 700));
    let last = 0;
    await runHere.download("https://huggingface.co/x/resolve/y/m.gguf", dest, body.length, sha, (n) => { last = n; });
    assert.deepEqual(ranges, ["bytes=700-"]);
    assert.equal(last, body.length);
    assert.ok(fs.readFileSync(dest).equals(body));
    await assert.rejects(runHere.download("https://huggingface.co/x/resolve/y/n.gguf", path.join(dir, "n.gguf"), body.length, "0".repeat(64), () => {}), /checksum/);
    assert.equal(fs.existsSync(path.join(dir, "n.gguf")), false);
    assert.equal(fs.existsSync(path.join(dir, "n.gguf.part")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the runner stays on this computer, behind its own key, never online", () => {
  const src = read("webapp/run-here.js");
  assert.match(src, /if \(e\.failedCheck\) await writeState\(s => \(\{ \.\.\.s, tried:/, "a model that failed its job's check isn't offered again");
  assert.match(src, /"--host", "127\.0\.0\.1"/);
  assert.match(src, /"--offline"/);
  assert.match(src, /LLAMA_API_KEY: key/, "the key goes in its environment, not its arguments");
  assert.doesNotMatch(src, /"--api-key"/);
  const build = read("desktop/build.sh");
  assert.match(build, /LLAMA_BUILD="b11476"/);
  assert.match(build, /arm64\) LLAMA_SHA=577634a1b8a59e8dabe02ba10de1e610be0574dfaf1cf3020e6dd42853ed877e ;;/);
  assert.match(build, /shasum -a 256 -c -/);
  assert.match(read("desktop/Sources/ClosedHand/Supervisor.swift"), /env\["LLAMA_SERVER_BIN"\] = resources\.appendingPathComponent\("llama\/llama-server"\)\.path/);
});

test("the words people see", () => {
  const ui = read("webapp/public/model-settings.js");
  assert.match(ui, /"This LLM can also run on this computer for free, and nothing it reads would leave it\. It needs " \+ size\(offer\.bytes\) \+ " of space\."/);
  assert.match(ui, /go\.textContent = "Run it here";/);
  assert.match(ui, /"Downloading it to this computer: " \+ \(state\.pct \|\| 0\) \+ "% of " \+ size\(state\.totalBytes\) \+ "\."/);
  assert.match(ui, /"Checking it runs fast enough here\."/);
  assert.match(ui, /back\.textContent = "Use " \+ state\.provider \+ " again";/);
  const src = read("webapp/run-here.js");
  assert.match(src, /`It ran slower on this computer than promised, so it stays with \$\{provider\}\.`/);
  assert.match(src, /`It couldn't be set up on this computer, so it stays with \$\{provider\}\.`/);
  assert.match(src, /`It couldn't start on this computer, so it's back with \$\{provider\}\.`/);
  for (const page of ["webapp/views/privacy.html", "closedhand-com/views/privacy.html"]) {
    assert.match(read(page), /When you choose to run an LLM on the computer running Closedhand, it is downloaded from Hugging Face, which sees that computer's internet address and the model's name\./, page);
  }
});
