// webapp/provider-capabilities.js — what each provider's key can actually do.
//
// "One key covers everything" is only true for complete providers (chat +
// embeddings + a cheap enrichment model + vision). Chat-only providers need a
// second key for the memory machinery, and the wizard says so by name instead
// of assuming. Model choices prefer the provider's LIVE model list (fetched at
// save time, which doubles as key verification); the static entries here are
// fallbacks so a fetch hiccup or a renamed model never blocks setup.
//
// Machinery is OpenAI wire format everywhere (embeddings + chat completions),
// so a complete provider's machinery is just three URLs on the same base.

const PROVIDERS = {
  deepinfra: {
    label: "DeepInfra",
    complete: true,
    chatBackend: "custom",
    base: "https://api.deepinfra.com/v1/openai",
    auth: "bearer",
    chat: { prefer: [/^deepseek-ai\/DeepSeek-V4$/, /DeepSeek-V4(?!-Flash)/], fallback: "deepseek-ai/DeepSeek-V4" },
    embed: { prefer: [/^Qwen\/Qwen3-Embedding-4B$/, /Qwen3-Embedding/], fallback: "Qwen/Qwen3-Embedding-4B" },
    enrich: { prefer: [/DeepSeek-V4-Flash/, /^Qwen\/Qwen3-30B/], fallback: "deepseek-ai/DeepSeek-V4-Flash" },
    vision: { prefer: [/^Qwen\/Qwen3-VL-30B-A3B-Instruct$/, /Qwen3-VL.*Instruct/, /-VL-/], fallback: "Qwen/Qwen3-VL-30B-A3B-Instruct" },
  },
  openai: {
    label: "OpenAI",
    complete: true,
    chatBackend: "openai", // chat model comes from MODEL_MAP, not saved here
    chatDisplay: "gpt-4o", // mirrors MODEL_MAP.openai.default (display only)
    base: "https://api.openai.com/v1",
    auth: "bearer",
    embed: { prefer: [/^text-embedding-3-small$/, /^text-embedding-3/, /^text-embedding/], fallback: "text-embedding-3-small" },
    enrich: { prefer: [/^gpt-4o-mini$/, /^gpt-\d[\w.]*-mini$/], fallback: "gpt-4o-mini" },
    vision: { prefer: [/^gpt-4o$/, /^gpt-4o-mini$/], fallback: "gpt-4o" },
  },
  gemini: {
    label: "Google Gemini",
    complete: true,
    chatBackend: "gemini", // chat model comes from MODEL_MAP
    chatDisplay: "gemini-pro-latest", // mirrors MODEL_MAP.gemini.default (display only)
    // Gemini's OpenAI-compatible layer serves models/embeddings/chat completions
    base: "https://generativelanguage.googleapis.com/v1beta/openai",
    auth: "bearer",
    embed: { prefer: [/^gemini-embedding-001$/, /gemini-embedding/, /text-embedding/], fallback: "gemini-embedding-001" },
    enrich: { prefer: [/^gemini-flash-latest$/, /flash(?!.*8b)/i], fallback: "gemini-flash-latest" },
    vision: { prefer: [/^gemini-flash-latest$/, /flash/i], fallback: "gemini-flash-latest" },
  },
  anthropic: {
    label: "Anthropic",
    complete: false,
    chatBackend: "anthropic",
    chatDisplay: "claude-sonnet-5", // mirrors MODEL_MAP.anthropic.default (display only)
    localMemory: true,
    modelsUrl: "https://api.anthropic.com/v1/models",
    auth: "anthropic",
    noEmbeddings: "Anthropic doesn't offer an embedding model",
  },
  groq: {
    label: "Groq",
    complete: false,
    chatBackend: "custom",
    base: "https://api.groq.com/openai/v1",
    auth: "bearer",
    chat: { prefer: [/^llama-3\.3-70b-versatile$/, /llama-3\.3/, /llama/i], fallback: "llama-3.3-70b-versatile" },
    enrich: { prefer: [/^llama-3\.1-8b-instant$/, /8b/i, /llama-3\.1/], fallback: "llama-3.1-8b-instant" },
    localMemory: true,
    noEmbeddings: "Groq doesn't offer an embedding model",
  },
  xai: {
    label: "xAI (Grok)",
    complete: false,
    chatBackend: "custom",
    base: "https://api.x.ai/v1",
    auth: "bearer",
    // Purpose-built key check: GET returns key info on a valid key, 400/401 on
    // a bad one. Decisive without invoking a reasoning model (a one-token chat
    // probe against grok can spend the whole timeout thinking).
    keyProbe: "https://api.x.ai/v1/api-key",
    chat: { prefer: [/^grok-4\.5$/, /^grok-4/, /grok(?!.*vision)/], fallback: "grok-4.5" },
    // Same-key machinery: grok handles the light chores (low reasoning effort
    // is applied at request time) and is multimodal, so vision rides along.
    enrich: { prefer: [/^grok-4\.5$/, /^grok-4/], fallback: "grok-4.5" },
    vision: { prefer: [/^grok-4\.5$/, /^grok-4/], fallback: "grok-4.5" },
    localMemory: true,
    noEmbeddings: "xAI doesn't offer an embedding model",
  },
  ollama: {
    label: "Ollama",
    complete: "maybe", // depends on what's pulled; decided from the live list
    chatBackend: "custom",
    auth: "none", // base comes from the user
    chat: { prefer: [/llama3/i, /qwen/i, /mistral/i, /^(?!.*embed)(?!.*llava)/], fallback: null },
    embed: { prefer: [/nomic-embed/, /mxbai-embed/, /bge-m3/, /snowflake-arctic-embed/, /embed/i], fallback: null },
    // Local models are already cheap; enrichment chores ride the chat model.
    enrich: { prefer: [/llama3/i, /qwen/i, /mistral/i, /^(?!.*embed)(?!.*llava)/], fallback: null },
    vision: { prefer: [/llava/i, /moondream/i, /vision/i], fallback: null },
    noEmbeddings: "this Ollama has no embedding model pulled. Run: ollama pull nomic-embed-text, then save again",
  },
};

// Fetch the provider's live model list. Succeeding IS the key verification.
// Returns an array of model ids; throws { status } style errors on rejection.
async function listModels(provider, { apiKey, base } = {}) {
  const p = PROVIDERS[provider];
  const url = p.modelsUrl || `${base || p.base}/models`;
  const headers = {};
  if (p.auth === "bearer" && apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  if (p.auth === "anthropic") { headers["x-api-key"] = apiKey || ""; headers["anthropic-version"] = "2023-06-01"; }
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  if (!r.ok) { const e = new Error(`models list ${r.status}`); e.status = r.status; throw e; }
  const j = await r.json();
  return (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean);
}

// First live id matching a preference wins; the static fallback otherwise.
function pickModel(cap, liveIds) {
  if (!cap) return null;
  for (const re of cap.prefer || []) {
    const hit = (liveIds || []).find((id) => re.test(id));
    if (hit) return hit;
  }
  return cap.fallback || null;
}

// Ground-truth key check: a one-token chat call to the endpoint the key will
// actually be used for. Providers scope keys per endpoint (an x.ai key can be
// valid for chat while its models list refuses), so the models probe alone
// can reject working keys. Returns true when the response is anything other
// than a credential failure — a model-not-found still proves the key
// authenticated.
// Returns { valid, status } so callers can SAY what the provider answered
// instead of reporting a mystery.
async function verifyChatKey(provider, { apiKey, base } = {}) {
  const p = PROVIDERS[provider];
  if (!p) return { valid: false, status: null };
  // A dedicated key-info endpoint beats any model call when the provider has
  // one: fast, free, and immune to reasoning-model latency.
  if (p.keyProbe) {
    try {
      const r = await fetch(p.keyProbe, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(8000),
      });
      return { valid: r.ok, status: r.status };
    } catch (_) {
      return { valid: false, status: 0 };
    }
  }
  const model = (p.chat && p.chat.fallback) || p.chatDisplay || "test";
  let url, headers, body;
  if (p.auth === "anthropic") {
    url = "https://api.anthropic.com/v1/messages";
    headers = { "x-api-key": apiKey || "", "anthropic-version": "2023-06-01", "Content-Type": "application/json" };
    body = { model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] };
  } else {
    url = `${base || p.base}/chat/completions`;
    headers = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    body = { model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] };
  }
  try {
    // Generous timeout: several providers' cheap models reason by default and
    // can sit thinking before the first token even with max_tokens: 1.
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(25000) });
    if (r.ok || r.status === 404 || r.status === 429) return { valid: true, status: r.status }; // 404/429: authed far enough
    if (r.status === 401 || r.status === 403) return { valid: false, status: r.status };
    const text = await r.text().catch(() => "");
    // 400s split: "incorrect api key" is a credential failure; a model or
    // param complaint means the key itself passed.
    return { valid: !/api[ -]?key|credential|unauthoriz|authenticat/i.test(text), status: r.status };
  } catch (_) {
    return { valid: false, status: 0 };
  }
}

module.exports = { PROVIDERS, listModels, pickModel, verifyChatKey };
