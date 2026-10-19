// api-keys.js: keys people paste, and the services they open.
//
// Vendored: lib/api-keys.js (bot) and webapp/api-keys.js (dashboard), kept
// byte-identical (scripts/check-vendored-identical.js).
//
// Two jobs. Recognising a key: a key pasted in the Connections box needs no
// question when it says whose it is, and one pasted in a chat is kept out of
// everything Closedhand reads and stores. And reading a service's published
// API description (OpenAPI), so a key connects to any service that publishes
// one, with no code for that service.

const crypto = require("crypto");

// Keys that say whose they are by how they start. The length of the rest
// keeps a word like "sk-learn" or a bare "ghp_" in a sentence from counting.
// provider marks an AI provider, whose key belongs in Models; signed marks a
// service that needs more than a key on each request.
const SHAPES = [
  { re: /^sk-ant-[A-Za-z0-9_-]{20,}$/, service: "Anthropic", provider: "anthropic" },
  { re: /^sk-or-v1-[A-Za-z0-9]{32,}$/, service: "OpenRouter", provider: "openrouter" },
  { re: /^sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}$/, service: "OpenAI", provider: "openai" },
  { re: /^xai-[A-Za-z0-9]{20,}$/, service: "xAI", provider: "xai" },
  { re: /^gsk_[A-Za-z0-9]{20,}$/, service: "Groq", provider: "groq" },
  { re: /^AIza[A-Za-z0-9_-]{35}$/, service: "Gemini", provider: "gemini" },
  { re: /^sk_[a-f0-9]{48}$/, service: "ElevenLabs" },
  { re: /^(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}$/, service: "Stripe" },
  { re: /^(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}$|^github_pat_[A-Za-z0-9_]{40,}$/, service: "GitHub" },
  { re: /^glpat-[A-Za-z0-9_-]{20,}$/, service: "GitLab" },
  { re: /^xox[abpr]-[A-Za-z0-9-]{20,}$/, service: "Slack" },
  { re: /^SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/, service: "SendGrid" },
  { re: /^ntn_[A-Za-z0-9]{30,}$/, service: "Notion" },
  { re: /^hf_[A-Za-z0-9]{30,}$/, service: "Hugging Face" },
  { re: /^pplx-[A-Za-z0-9]{30,}$/, service: "Perplexity" },
  { re: /^r8_[A-Za-z0-9]{30,}$/, service: "Replicate" },
  { re: /^lin_api_[A-Za-z0-9]{30,}$/, service: "Linear" },
  { re: /^shpat_[a-f0-9]{32}$/, service: "Shopify" },
  { re: /^figd_[A-Za-z0-9_-]{30,}$/, service: "Figma" },
  { re: /^re_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}$/, service: "Resend" },
  { re: /^tvly-[A-Za-z0-9-]{20,}$/, service: "Tavily" },
  { re: /^pat[A-Za-z0-9]{14}\.[a-f0-9]{64}$/, service: "Airtable" },
  { re: /^ATATT[A-Za-z0-9_=-]{50,}$/, service: "Atlassian" },
  { re: /^npm_[A-Za-z0-9]{36}$/, service: "npm" },
  { re: /^\d{8,10}:[A-Za-z0-9_-]{35}$/, service: "Telegram" },
  { re: /^(?:AKIA|ASIA)[A-Z0-9]{16}$/, service: "Amazon Web Services", signed: true },
  // Many services hand out "sk-" keys (DeepSeek, Moonshot, older OpenAI
  // keys): it is a key, whose is a question.
  { re: /^sk-[A-Za-z0-9]{32,}$/, service: null },
];

// Whose a key is, by how it starts. Null when it doesn't say.
function recognise(token) {
  const t = String(token || "").trim();
  for (const s of SHAPES) if (s.re.test(t)) return { service: s.service, provider: s.provider || null, signed: !!s.signed };
  return null;
}

// What a key could be when the person said it is one: a long run of letters
// and digits, both present, with nothing in it that makes it a link, an
// address or a sentence.
function keyShaped(token, min = 20) {
  const t = String(token || "");
  return t.length >= min && t.length <= 300 && /^[A-Za-z0-9][A-Za-z0-9_.:=+-]*[A-Za-z0-9=]$/.test(t)
    && /\d/.test(t) && /[A-Za-z]/.test(t);
}

// One word pasted on its own in the Connections box is a key there: the box
// is for connecting, so nothing else would be one long word. A web address
// without its https:// is still an address.
function bareKey(text) {
  const t = String(text || "").trim();
  if (recognise(t)) return true;
  if (/\s/.test(t) || /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(t) && /\.[a-z]{2,}$/i.test(t)) return false;
  return keyShaped(t, 16);
}

// The person saying a key is coming: "here's my key", "API key:", "my
// ElevenLabs token". "The key point is" is not one. Placeholders left by an
// earlier catch don't count.
const SAYS_KEY = new RegExp([
  String.raw`\b(?:api|access|auth(?:entication)?|bearer|secret|private)[\s_-]?(?:key|token)\b`,
  String.raw`\b(?:my|our)\s+(?:[\w.-]+\s+){0,2}(?:key|token|secret)\b`,
  String.raw`\bhere(?:'s|\u2019s|\s+is)\b[^.\n]{0,40}\b(?:key|token|secret)\b`,
  String.raw`\b(?:key|token|secret)\s*(?:is\s*)?[:=]`,
].join("|"), "i");
const PLACEHOLDER = /\[(?:([^\]\n]{1,40}) )?key withheld\]/g;
function saysKey(text) {
  return SAYS_KEY.test(String(text || "").replace(PLACEHOLDER, " "));
}

function placeholderFor(service) {
  return `[${service ? service + " " : ""}key withheld]`;
}

// The keys a message holds, each replaced by a placeholder naming its
// service. A token counts when it says whose it is, or when the person said
// a key is in it (in this message or, with saidBefore, the one before).
// Placeholders already there count too, so a message stored after a catch
// is answered the same way. Returns { text, keys: [{ service, provider,
// signed, digest }] }; digest identifies a key without keeping it.
function withhold(text, { saidBefore = false } = {}) {
  const src = String(text || "");
  const said = saidBefore || saysKey(src);
  const keys = [];
  const out = src.replace(/[^\s"'`<>()[\]{}]+/g, (word) => {
    const trimmed = word.replace(/^[.,;:!?*]+/, "").replace(/[.,;:!?*]+$/, "");
    // "key=sk-..." or "token:..." with the label stuck on.
    const core = recognise(trimmed) ? trimmed : trimmed.replace(/^[A-Za-z_-]{2,20}[=:]/, "");
    if (!core) return word;
    const known = recognise(core);
    if (!known && !(said && keyShaped(core))) return word;
    const found = known || { service: null, provider: null, signed: false };
    keys.push({ ...found, digest: crypto.createHash("sha256").update(core).digest("hex").slice(0, 16) });
    return word.replace(core, placeholderFor(found.service));
  });
  for (const m of src.matchAll(PLACEHOLDER)) keys.push({ service: m[1] || null, provider: null, signed: false, digest: null });
  return { text: out, keys };
}

// ---------------------------------------------------------------------------
// Reading a published API description
// ---------------------------------------------------------------------------

const METHODS = ["get", "post", "put", "patch", "delete"];
// A header that carries a key: named for one, on most of the API's endpoints.
const KEY_HEADER = /key|token|auth/i;

function refOf(spec, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return null;
  let node = spec;
  for (const part of ref.slice(2).split("/")) {
    node = node && node[part.replace(/~1/g, "/").replace(/~0/g, "~")];
    if (node === undefined) return null;
  }
  return node;
}

function deref(spec, node, depth = 0) {
  let n = node;
  for (let i = 0; n && n.$ref && i < 8; i++) n = refOf(spec, n.$ref);
  if (!n || depth > 3) return n || null;
  if (Array.isArray(n.allOf)) {
    const merged = { type: "object", properties: {}, required: [] };
    for (const part of n.allOf) {
      const p = deref(spec, part, depth + 1) || {};
      Object.assign(merged.properties, p.properties || {});
      merged.required.push(...(p.required || []));
    }
    return merged;
  }
  const one = n.oneOf || n.anyOf;
  if (Array.isArray(one)) {
    const real = one.map((x) => deref(spec, x, depth + 1)).find((x) => x && x.type !== "null");
    return real ? { ...real, description: n.description || real.description } : n;
  }
  return n;
}

function typeOf(spec, schema) {
  const s = deref(spec, schema) || {};
  if (Array.isArray(s.enum)) return "one of " + s.enum.slice(0, 8).map((v) => JSON.stringify(v)).join(", ") + (s.enum.length > 8 ? ", …" : "");
  if (s.type === "array") return "list of " + (deref(spec, s.items)?.type || "values");
  return s.format === "binary" ? "file" : s.type || "value";
}

// What a schema says about one value, kept for checking a call against it:
// its type, the values it allows, its default and examples, and whether it
// is a file.
function facts(spec, schema, about) {
  const s = deref(spec, schema) || {};
  const out = { kind: s.type === "file" ? "string" : s.type || "string" };
  if (Array.isArray(s.enum)) out.values = s.enum.filter((v) => typeof v === "string" || typeof v === "number");
  if (s.default !== undefined) out.default = s.default;
  const examples = Array.isArray(s.examples) ? s.examples : s.example !== undefined ? [s.example] : [];
  if (examples.length) out.examples = examples.slice(0, 3);
  if (s.format === "binary" || s.type === "file") out.binary = true;
  if (about) out.about = about;
  return out;
}

function short(text, max) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max).replace(/\s+\S*$/, "") + "…" : t;
}

// The addresses an API description says it answers at. One given as a path
// ("/v2") is on the site the API is at, and so is a description that gives
// none: its paths then start at the site's root.
function serversOf(spec, origin) {
  const out = [];
  if (spec.swagger) {
    const schemes = Array.isArray(spec.schemes) && spec.schemes.length ? spec.schemes : ["https"];
    if (schemes.includes("https")) out.push(spec.host ? `https://${spec.host}${spec.basePath || ""}` : origin + (spec.basePath || ""));
  }
  for (const s of Array.isArray(spec.servers) ? spec.servers : []) {
    let url = String(s?.url || "");
    for (const [k, v] of Object.entries(s?.variables || {})) url = url.replace(`{${k}}`, String(v?.default ?? ""));
    if (url.startsWith("/")) url = origin + url;
    if (/^https:\/\/[^{}\s]+$/.test(url)) out.push(url);
  }
  return out.length ? out : [origin];
}

function hostOf(url) { try { return new URL(url).host.toLowerCase(); } catch { return ""; } }
// The last two labels of a host: api.example.com and example.com share it.
function siteOf(host) { return String(host || "").split(".").slice(-2).join("."); }

// How a key is sent, from the description's own security schemes, or failing
// those, a key header most endpoints take.
function authOf(spec, operations) {
  const schemes = (spec.components && spec.components.securitySchemes) || spec.securityDefinitions || {};
  const wanted = [];
  for (const req of Array.isArray(spec.security) ? spec.security : []) wanted.push(...Object.keys(req || {}));
  const names = [...new Set([...wanted, ...Object.keys(schemes)])];
  for (const name of names) {
    const s = deref(spec, schemes[name]);
    if (!s) continue;
    if (s.type === "apiKey" && (s.in === "header" || s.in === "query") && s.name) return { in: s.in, name: String(s.name) };
    if (s.type === "http" && /^bearer$/i.test(s.scheme || "")) return { in: "header", name: "Authorization", prefix: "Bearer " };
  }
  const counts = new Map();
  for (const op of operations) {
    for (const p of op.rawParams) if (p.in === "header" && KEY_HEADER.test(p.name)) counts.set(p.name, (counts.get(p.name) || 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] >= Math.max(1, operations.length / 2)) return { in: "header", name: top[0] };
  return null;
}

// Reads an OpenAPI 3 or Swagger 2 description (already parsed from JSON) for
// the API at base. Returns { base, auth, endpoints } or null when it isn't a
// description, or describes an API somewhere else. base becomes the address
// the description's paths start from, on the same site: "https://api.x.com/v1"
// with paths written "/v1/user" is "https://api.x.com".
function readApiDescription(spec, base) {
  if (!spec || typeof spec !== "object" || !spec.paths || typeof spec.paths !== "object") return null;
  if (!(String(spec.openapi || "").startsWith("3") || String(spec.swagger || "") === "2.0")) return null;
  const want = hostOf(base);
  if (!want) return null;
  const servers = serversOf(spec, new URL(base).origin);
  const same = servers.find((s) => hostOf(s) === want) || servers.find((s) => siteOf(hostOf(s)) === siteOf(want));
  if (!same) return null;
  const at = same.replace(/\/+$/, "");
  const raw = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    if (!item || typeof item !== "object" || !path.startsWith("/")) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const m of METHODS) {
      const op = item[m];
      if (!op || typeof op !== "object") continue;
      const rawParams = [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])].map((p) => deref(spec, p)).filter((p) => p && p.name && p.in);
      raw.push({ m, path, op, rawParams });
    }
  }
  const auth = authOf(spec, raw);
  const endpoints = raw.map(({ m, path, op, rawParams }) => {
    const params = rawParams
      .filter((p) => !(auth && p.in === auth.in && p.name.toLowerCase() === auth.name.toLowerCase()))
      .filter((p) => ["path", "query", "header"].includes(p.in))
      .map((p) => ({ name: p.name, in: p.in, required: !!p.required || p.in === "path", type: typeOf(spec, p.schema || p), about: short(p.description || deref(spec, p.schema)?.description, 90), ...facts(spec, p.schema || p) }));
    let body = null;
    const content = (deref(spec, op.requestBody) || {}).content || {};
    const kind = Object.keys(content).find((k) => /json/.test(k)) || Object.keys(content)[0];
    const bodySchema = kind ? deref(spec, content[kind].schema) : null;
    if (bodySchema) {
      const req = new Set(bodySchema.required || []);
      body = { kind, fields: Object.entries(bodySchema.properties || {}).slice(0, 40).map(([name, s]) => ({ name, required: req.has(name), type: typeOf(spec, s), about: short(deref(spec, s)?.description, 90), ...facts(spec, s) })) };
    }
    const ok = (op.responses && (op.responses["200"] || op.responses["201"])) || {};
    const returns = Object.keys((deref(spec, ok) || {}).content || {})[0] || null;
    return {
      method: m.toUpperCase(), path,
      summary: short(op.summary || op.operationId || "", 120),
      about: short(op.description, 200),
      id: String(op.operationId || ""),
      tags: Array.isArray(op.tags) ? op.tags.map(String) : [],
      params, body, returns,
    };
  });
  return { base: at, auth, endpoints };
}

const STOP = new Set(["the", "and", "for", "with", "from", "into", "that", "this", "what", "get", "list", "make", "use", "using", "api", "endpoint", "call", "via"]);
// Words cut to a stem, so "voices" finds "voice" and "transcription" finds
// "transcribe".
function words(text) {
  return String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)).map((w) => w.replace(/s$/, "").slice(0, 7));
}

// How many of the wanted words follow each other, in order, in these words:
// "speech to text" is not "text to speech".
function inOrder(want, have) {
  let n = 0;
  for (let i = 0; i + 1 < want.length; i++) {
    for (let j = 0; j + 1 < have.length; j++) if (have[j] === want[i] && have[j + 1] === want[i + 1]) { n++; break; }
  }
  return n;
}

// The endpoints that best match what Closedhand wants to do, best first.
function searchEndpoints(endpoints, what, max = 6) {
  const want = words(what);
  if (!want.length) return [];
  const scored = [];
  for (const e of endpoints || []) {
    const pathWords = words(e.path.replace(/\{[^}]*\}/g, " "));
    const nameWords = words(`${e.summary} ${e.id}`);
    const inPath = new Set(pathWords);
    const inName = new Set([...nameWords, ...words(e.tags.join(" "))]);
    const inAbout = new Set(words(e.about));
    let score = 2 * Math.max(inOrder(want, pathWords), inOrder(want, nameWords));
    for (const w of want) {
      if (inPath.has(w)) score += 3;
      if (inName.has(w)) score += 2;
      if (inAbout.has(w)) score += 1;
    }
    if (score > 0) scored.push({ e, score: score - e.path.split("/").length * 0.05 });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, max).map((x) => x.e);
}

// An endpoint as a tool definition, named "POST /v1/speech", with its
// parameters and body fields as the arguments: how Closedhand's check of
// what a connection can do (webapp/connection-jobs.js) reads a service it
// reaches by its plain API.
function endpointTool(e) {
  const properties = {};
  const required = [];
  for (const f of [...e.params, ...(e.body ? e.body.fields : [])]) {
    if (properties[f.name]) continue;
    properties[f.name] = {
      type: f.kind,
      ...(f.about ? { description: f.about } : {}),
      ...(f.values ? { enum: f.values } : {}),
      ...(f.default !== undefined ? { default: f.default } : {}),
      ...(f.examples ? { examples: f.examples } : {}),
      ...(f.binary ? { format: "binary" } : {}),
    };
    if (f.required) required.push(f.name);
  }
  return { name: `${e.method} ${e.path}`, description: [e.summary, e.about].filter(Boolean).join(". "), inputSchema: { type: "object", properties, required } };
}

// The request that calls an endpoint with these arguments: path parameters
// filled in, query and header parameters set, the rest as its body (JSON, or
// a form when it takes files, given as Buffers).
function requestFor(e, base, args = {}) {
  const used = new Set();
  let missing = null;
  const path = e.path.replace(/\{([^}]+)\}/g, (all, name) => {
    used.add(name);
    if (args[name] === undefined || args[name] === null || args[name] === "") { missing = missing || name; return all; }
    return encodeURIComponent(String(args[name]));
  });
  if (missing) throw new Error(`${e.method} ${e.path} needs ${missing}`);
  const url = new URL(base.replace(/\/+$/, "") + path);
  const headers = {};
  for (const p of e.params) {
    if (p.in === "path" || args[p.name] === undefined) continue;
    used.add(p.name);
    if (p.in === "query") url.searchParams.set(p.name, String(args[p.name]));
    if (p.in === "header") headers[p.name] = String(args[p.name]);
  }
  let body;
  const fields = e.body ? e.body.fields.filter((f) => !used.has(f.name) && args[f.name] !== undefined) : [];
  if (e.body && /form-data/.test(e.body.kind)) {
    body = new FormData();
    for (const f of fields) {
      const v = args[f.name];
      if (Buffer.isBuffer(v)) body.append(f.name, new Blob([v]), `${f.name}.${args._fileExt || "bin"}`);
      else body.append(f.name, typeof v === "string" ? v : JSON.stringify(v));
    }
  } else if (e.body && fields.length) {
    body = JSON.stringify(Object.fromEntries(fields.map((f) => [f.name, args[f.name]])));
    headers["Content-Type"] = "application/json";
  }
  return { method: e.method, url: url.toString(), headers, body };
}

module.exports = { SHAPES, recognise, keyShaped, bareKey, saysKey, withhold, placeholderFor, readApiDescription, searchEndpoints, endpointTool, requestFor, hostOf };
