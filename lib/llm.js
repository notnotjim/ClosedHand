// lib/llm.js — LLM abstraction layer
// All backends return { messages: { create(anthropicParams) -> anthropicResponse } }
// Internally translates to/from each provider's format so the rest of the codebase
// only ever deals with Anthropic-shaped params and responses.

// --- Model tier mapping ---
// ClosedHand code references tiers (fast/default/strong) not model names.
// This maps tiers to specific model names per provider.
// Users are either on the platform default LLM (PLATFORM_PROVIDER, ClosedHand's key)
// or bring-your-own-key (llm_provider setting + their API key).
const PLATFORM_PROVIDER = "xai";

// Model ids go stale two ways and the defences differ. Point releases are
// handled by using each provider's alias form (undated ids track the newest
// snapshot; Gemini has true -latest aliases that track across generations).
// Generation jumps cannot be aliased at Anthropic or OpenAI, so those are
// resolved against the provider's live model list when a key is saved, and
// the result lands in settings.byok_models, which wins over this table.
const MODEL_MAP = {
  anthropic: { fast: "claude-haiku-4-5", default: "claude-sonnet-5", strong: "claude-opus-5" },
  openai:    { fast: "gpt-4o-mini", default: "gpt-4o", strong: "o3" },
  gemini:    { fast: "gemini-flash-latest", default: "gemini-pro-latest", strong: "gemini-pro-latest" },
  // Platform default: one model, tiers differ by reasoning effort ("model:effort").
  // default=medium: high effort on every chat message made big-context tool
  // loops take 2+ min per iteration (mutex timeouts for queued messages, 2026-07-25).
  // Deep work goes through agents/teams on the strong tier.
  xai:       { fast: "grok-4.5:low", default: "grok-4.5:medium", strong: "grok-4.5:high" },
};

function resolveModel(anthropicModel, provider) {
  if (!anthropicModel) return MODEL_MAP[provider]?.default;
  if (provider !== "anthropic" && !anthropicModel.startsWith("claude-")) return anthropicModel;
  if (provider === "anthropic") return anthropicModel;
  // Already provider-native (e.g. "grok-4.5:low" from a tier lookup): pass through
  if (Object.values(MODEL_MAP[provider] || {}).includes(anthropicModel)) return anthropicModel;
  const tier = anthropicModel.includes("haiku") ? "fast"
    : anthropicModel.includes("opus") ? "strong"
    : "default";
  return MODEL_MAP[provider]?.[tier] || MODEL_MAP[provider]?.default || anthropicModel;
}

// =============================================================================
// Provider-aware helpers for internal + user-facing LLM calls
// =============================================================================

/**
 * Resolve the correct model name for a given tier based on the current user's provider.
 * @param {string} userId - User ID (uses ctx.activeUserStore)
 * @param {"fast"|"default"|"strong"} tier - Model tier
 * @returns {string} Model name
 */
function resolveUserModel(userId, tier = "default", userStore) {
  const ctx = require("./context");
  const store = userStore || ctx.activeUserStore;
  const settings = store?.profile?.settings || {};
  const selected = require("./model-policy").getRole(settings, "chat");
  if (selected !== undefined) {
    if (!selected) throw new Error("Choose a chat model in Settings.");
    return selected.model;
  }
  const provider = settings.llm_provider;
  // BYOK providers only apply when the user actually holds a key; otherwise platform default
  const resolved = settings.byok_models || {};
  if (provider === "anthropic" && settings.anthropic_api_key) return resolved[tier] || MODEL_MAP.anthropic[tier];
  if (provider === "openai" && settings.openai_api_key) return resolved[tier] || MODEL_MAP.openai[tier];
  if (provider === "gemini" && settings.gemini_api_key) return resolved[tier] || MODEL_MAP.gemini[tier];
  if (provider === "custom" && settings.custom_base_url && settings.custom_model) {
    // One endpoint can still have a cheap sibling: the user may name a fast
    // model for the quick internal work, and the main one covers the rest.
    if (tier === "fast" && settings.custom_model_fast) return settings.custom_model_fast;
    return settings.custom_model;
  }
  return MODEL_MAP[PLATFORM_PROVIDER][tier];
}

// Internal jobs use the checked background role at fast effort. Only profiles
// without model_config retain the legacy installation/platform machinery.
// A configured role never falls through to another provider after an error.
let _internalClientSingleton = null;
let _internalClientSig = null;

function getInternalClient(userId, userStore) {
  const configured = getConfiguredRole("background", userStore);
  if (configured !== undefined) { if (!configured) throw new Error("Choose a model for summaries in Settings."); return configured; }
  // URL/model/key resolve env → runtime config (the wizard's provider save) →
  // the DeepInfra defaults; the singleton rebuilds when any of them change.
  const conf = (k) => require("./config").getConfCached(k);
  const url = process.env.INTERNAL_LLM_URL || conf("INTERNAL_LLM_URL") || "https://api.deepinfra.com/v1/openai";
  const model = process.env.INTERNAL_LLM_MODEL || conf("INTERNAL_LLM_MODEL") || "deepseek-ai/DeepSeek-V4-Flash";
  const key = process.env.INTERNAL_LLM_API_KEY || conf("INTERNAL_LLM_API_KEY") || process.env.DEEPINFRA_API_KEY || conf("DEEPINFRA_API_KEY");
  if (key) {
    const sig = `${url}|${model}|${key}`;
    if (!_internalClientSingleton || _internalClientSig !== sig) {
      _internalClientSingleton = createLLMClient({
        backend: "custom",
        baseUrl: url,
        apiKey: key,
        model,
        // reasoningEffort only for the model families that accept it; an
        // unknown param 400s on stricter OpenAI-compatible providers.
        effort: "fast",
        stripImages: true,
        usageFeature: "machinery",
      });
      _internalClientSig = sig;
    }
    return { client: _internalClientSingleton, model };
  }

  // No DeepInfra key (dev environments): platform default, fast tier.
  const ctx = require("./context");
  return { client: ctx.defaultLLMClient, model: MODEL_MAP[PLATFORM_PROVIDER].fast };
}

/**
 * Get an LLM client + model for the main conversation (default tier).
 */
function getUserLLMClient(userId, userStore) {
  const configured = getConfiguredRole("chat", userStore);
  if (configured !== undefined) {
    if (!configured) throw new Error("Choose a chat model in Settings.");
    return configured;
  }
  const ctx = require("./context");
  const store = userStore || ctx.activeUserStore;
  const userSettings = store?.profile?.settings || {};
  const provider = userSettings.llm_provider || "";

  if (provider === "anthropic" && userSettings.anthropic_api_key) {
    return { client: createLLMClient({ backend: "anthropic", anthropicApiKey: userSettings.anthropic_api_key }), model: (userSettings.byok_models || {}).default || MODEL_MAP.anthropic.default };
  }

  if (provider === "openai" && userSettings.openai_api_key) {
    return { client: createLLMClient({ backend: "openai", apiKey: userSettings.openai_api_key }), model: (userSettings.byok_models || {}).default || MODEL_MAP.openai.default };
  }

  if (provider === "gemini" && userSettings.gemini_api_key) {
    return { client: createLLMClient({ backend: "gemini", apiKey: userSettings.gemini_api_key }), model: (userSettings.byok_models || {}).default || MODEL_MAP.gemini.default };
  }

  if (provider === "custom" && userSettings.custom_base_url && userSettings.custom_model) {
    return {
      client: createLLMClient({ backend: "custom", baseUrl: userSettings.custom_base_url, apiKey: userSettings.custom_api_key, model: userSettings.custom_model, allowedModels: [userSettings.custom_model, userSettings.custom_model_fast].filter(Boolean) }),
      model: userSettings.custom_model,
    };
  }

  // No BYOK key: platform default LLM (high effort for user-facing chat)
  return { client: ctx.defaultLLMClient, model: MODEL_MAP[PLATFORM_PROVIDER].default };
}


// =============================================================================
// Anthropic -> OpenAI format conversion (used by OpenAI-compatible backends: OpenAI, xAI)
// =============================================================================

function getConfiguredRole(role, userStore) {
  const store = userStore || require("./context").activeUserStore;
  const pick = require("./model-policy").getRole(store?.profile?.settings, role);
  if (pick === undefined || pick === null) return pick;
  const vision = role === "chat" ? require("./model-policy").getRole(store?.profile?.settings, "vision") : null;
  return { client: createLLMClient({ ...pick, effort: role === "background" ? "fast" : "default",
    stripImages: role === "background", routeImages: role === "chat" && (!vision || pick.capabilities?.vision !== true),
    vision,
    userId: store?.userId || store?.profile?.id,
    usageFeature: role === "background" ? "machinery" : role === "vision" ? "vision" : "chat" }), model: pick.model };
}

// Public entry: builds the backend client, then wraps it so every
// messages.create records its usage block under a feature label
// (opts.usageFeature, default "chat") for the dashboard's Usage tab.
function createLLMClient(opts = {}) {
  const { withUsageTracking } = require("./usage");
  return require("./model-capabilities").attachCapabilities(withUsageTracking(_createLLMClientRaw(opts), opts.usageFeature || "chat", opts.model), opts);
}

function _createLLMClientRaw(opts = {}) {
  const policy = require("./model-policy");
  const backend = opts.backend || "anthropic";
  if (backend === "anthropic" && opts.anthropicClient && typeof opts.anthropicClient !== "string") return opts.anthropicClient;
  const conn = {
    backend,
    baseUrl: String(opts.baseUrl || policy.BASES[backend] || "").replace(/\/+$/, ""),
    apiKey: opts.apiKey || opts.anthropicApiKey || opts.xaiApiKey || opts.geminiApiKey || opts.openaiApiKey,
  };
  return { messages: { create: async (params, options = {}) => {
    let model = backend === "custom" ? (opts.allowedModels?.includes(params.model) ? params.model : opts.model) : resolveModel(params.model || opts.model, backend);
    let effort = params.effort || (params.thinking?.type === "enabled" ? "strong" : opts.effort || "default");
    // Only the old xAI tier notation is synthetic. Router and Ollama suffixes are real IDs.
    if (backend === "xai" && /:(low|medium|high)$/.test(model)) {
      const suffix = model.slice(model.lastIndexOf(":") + 1);
      model = model.replace(/:(low|medium|high)$/, "");
      if (!params.effort && !params.thinking) effort = { low: "fast", medium: "default", high: "strong" }[suffix];
    }
    const messages = opts.stripImages ? (params.messages || []).map(m => ({ ...m, content: Array.isArray(m.content)
      ? m.content.map(b => b.type === "image" ? { type: "text", text: "[Image not supplied to this text model]" } : b) : m.content })) : params.messages;
    const routed = opts.routeImages || opts.stripImages ? await require("./model-images").substituteImages(messages, opts.routeImages ? opts.vision : null, opts.userId) : messages;
    return require("./model-wire").request({ ...conn, capabilities: opts.capabilities }, { ...params, model, effort, messages: routed }, options);
  } } };
}

// Whether the user's CHAT model can see images. The platform model and the
// big three all can; a custom endpoint is assumed text-only, because a wrong
// yes crashes the request while a wrong no still works via substitution.
function chatModelSupportsVision(userStore) {
  const settings = userStore?.profile?.settings || {};
  const selected = require("./model-policy").getRole(settings, "chat");
  if (selected) return !!settings.model_config.roles.vision && selected.capabilities?.vision === true;
  const provider = settings.llm_provider || "";
  if (provider === "custom" && settings.custom_base_url && settings.custom_model) return false;
  return true;
}

module.exports = {
  ...require("./model-wire"),
  getConfiguredRole,
  createLLMClient,
  resolveModel,
  resolveUserModel,
  getInternalClient,
  getUserLLMClient,
  chatModelSupportsVision,
  MODEL_MAP,

};
