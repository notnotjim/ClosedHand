// Invented Hugging Face, OpenRouter and llama-server stand-ins for the "Run
// it here" tests (test-run-here.js, test-run-here-flow.js). Nothing here
// reaches the network: models, repositories and files are made up.
const crypto = require("node:crypto");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const bytes = (label, n = 4096) => Buffer.alloc(n, label);

// A small dense model with an image part, from its makers' own GGUF repo
// and from an unknown repo that has more downloads.
const SMALL = {
  repo: "examplelab/Example-1.5B", sha: "1".repeat(40), total: 1.54e9,
  config: { num_hidden_layers: 28, num_attention_heads: 12, num_key_value_heads: 2, hidden_size: 1536, max_position_embeddings: 131072 },
  template: Buffer.from("{% for m in messages %}{{ m.content }}{% endfor %}"),
  ggufs: [
    { repo: "strangerfolk/Example-1.5B-GGUF", sha: "2".repeat(40), files: [{ path: "Example-1.5B-Q4_K_M.gguf", body: bytes("s") }] },
    { repo: "examplelab/Example-1.5B-GGUF", sha: "3".repeat(40), files: [
      { path: "Example-1.5B-Q4_K_M.gguf", body: bytes("q") },
      { path: "mmproj-Example-1.5B-f16.gguf", body: bytes("m", 1024) },
      { path: "../escape/Example-1.5B-Q8_0.gguf", body: bytes("e") },
    ] },
  ],
};

function hub(models = [SMALL], { router = [{ id: "examplelab/example-1.5b", hugging_face_id: "examplelab/Example-1.5B" }] } = {}) {
  const calls = [];
  const slow = { ms: 0 }; // set to make each model file take this long
  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  const raw = (body, status = 200, delay = 0) => ({ ok: status < 400, status, arrayBuffer: async () => body,
    body: (async function* () { yield body.subarray(0, Math.floor(body.length / 2)); if (delay) await new Promise(r => setTimeout(r, delay)); yield body.subarray(Math.floor(body.length / 2)); })() });
  const impl = async (url, opts = {}) => {
    url = String(url);
    if (url.startsWith("http://127.0.0.1")) return fetch(url, opts);
    calls.push(url);
    const u = new URL(url);
    if (u.hostname === "openrouter.ai") return json({ data: router });
    for (const m of models) {
      if (u.pathname === `/api/models/${m.repo}`) return json({ id: m.repo, sha: m.sha, gated: false, safetensors: { total: m.total } });
      if (u.pathname === `/api/models/${m.repo}/tree/${m.sha}`) return json([{ type: "file", path: "chat_template.jinja", size: m.template.length }, { type: "file", path: "config.json", size: 10 }]);
      if (u.pathname === `/${m.repo}/resolve/${m.sha}/config.json`) return json(m.config);
      if (u.pathname === `/${m.repo}/resolve/${m.sha}/chat_template.jinja`) return raw(m.template);
      if (u.pathname === "/api/models" && u.searchParams.getAll("filter").includes(`base_model:quantized:${m.repo}`)) return json(m.ggufs.map(g => ({ id: g.repo })));
      for (const g of m.ggufs) {
        if (u.pathname === `/api/models/${g.repo}`) return json({ id: g.repo, sha: g.sha, gated: false });
        if (u.pathname === `/api/models/${g.repo}/tree/${g.sha}`) return json(g.files.map(f => ({ type: "file", path: f.path, size: f.body.length, lfs: { oid: sha256(f.body) } })));
        for (const f of g.files) {
          if (u.pathname === `/${g.repo}/resolve/${g.sha}/${f.path.split("/").map(encodeURIComponent).join("/")}`) {
            const range = opts.headers?.Range;
            if (range) {
              const from = Number(/bytes=(\d+)-/.exec(range)[1]);
              if (from >= f.body.length) return { ok: false, status: 416 };
              return raw(f.body.subarray(from), 206, slow.ms);
            }
            return raw(f.body, 200, slow.ms);
          }
        }
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { impl, calls, slow };
}

// A llama-server stand-in, started through run-here's spawn hook: it answers
// on the port it is given, checks the key, and can be made to crash, refuse
// tools or drop connections.
function runnerFarm() {
  const spawned = [];
  const behaviour = { tools: "right", prompt_per_second: 3000, predicted_per_second: 120, drop: false, crashOnStart: false, unauthorized: false, serverError: false };
  const spawn = (file, argv, opts) => {
    const arg = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv[i + 1]; };
    const port = Number(arg("--port"));
    const child = new EventEmitter();
    child.pid = 100000 + spawned.length;
    child.exitCode = null; child.signalCode = null;
    child.stderr = new PassThrough();
    const server = http.createServer((req, res) => {
      if (req.headers.authorization !== "Bearer " + opts.env.LLAMA_API_KEY || (behaviour.unauthorized && req.url !== "/health")) { res.statusCode = 401; return res.end("{}"); }
      let body = ""; req.on("data", c => body += c); req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/health") return res.end('{"status":"ok"}');
        if (req.url === "/tokenize") return res.end(JSON.stringify({ tokens: new Array(600).fill(1) }));
        if (req.url === "/completion") return res.end(JSON.stringify({ timings: { prompt_n: 4000, prompt_per_second: behaviour.prompt_per_second, predicted_per_second: behaviour.predicted_per_second } }));
        if (behaviour.drop) return req.socket.destroy();
        if (behaviour.serverError) { res.statusCode = 500; return res.end('{"error":{"message":"failed to run"}}'); }
        const b = JSON.parse(body || "{}");
        const said = (text) => res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: {} }));
        const lastMsg = b.messages?.[b.messages.length - 1];
        if (b.tools?.length && lastMsg?.role !== "tool") {
          if (behaviour.tools === "wrong") return said("I won't call tools.");
          return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "capability_check", arguments: '{"value":4}' } }] }, finish_reason: "tool_calls" }], usage: {} }));
        }
        if (JSON.stringify(b.messages).includes("image_url")) return said("Red");
        return said(lastMsg?.role === "tool" ? "Done." : "ready");
      });
    });
    const end = (code, signal) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (server.listening) { server.close(); server.closeAllConnections?.(); }
      child.exitCode = code; child.signalCode = signal;
      setImmediate(() => child.emit("exit", code, signal));
    };
    child.kill = (signal = "SIGTERM") => { end(null, signal); return true; };
    child.crash = () => end(1, null);
    spawned.push({ file, argv, arg, child });
    if (behaviour.crashOnStart) { setImmediate(() => end(1, null)); return child; }
    server.listen(port, "127.0.0.1");
    return child;
  };
  return { spawn, spawned, behaviour, live: () => spawned.filter(s => s.child.exitCode === null && s.child.signalCode === null) };
}

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

module.exports = { SMALL, hub, runnerFarm, profileStore, sha256, bytes };
