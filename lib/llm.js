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

/**
 * Get an LLM client + model for internal operations (dedup, distil, context retrieval, etc.)
 * Routes through the user's configured provider, falling back to the platform default.
 * Always returns the FAST tier model (cheapest/fastest) for internal operations.
 */
// Internal machinery runs on the platform's own DeepInfra bill for every
// user, BYOK included. Two reasons. Cost: titles, summaries, routing and
// dedup were burning frontier rates (grok-4.5:low bills the same $2/$6 as
// high effort), and BYOK-Anthropic users were paying Haiku on their own key
// for chores they never asked for. Independence: the machinery must work
// identically whatever chat model the user picks, including text-only ones.
// V4-Flash cannot see images, so image blocks are stripped defensively;
// vision chores go to usi.describeImages, the platform's eyes.
let _internalClientSingleton = null;
let _internalClientSig = null;

function getInternalClient(userId, userStore) {
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
        reasoningEffort: /deepseek/i.test(model) ? "none" : undefined,
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
      client: createLLMClient({ backend: "custom", baseUrl: userSettings.custom_base_url, apiKey: userSettings.custom_api_key, model: userSettings.custom_model }),
      model: userSettings.custom_model,
    };
  }

  // No BYOK key: platform default LLM (high effort for user-facing chat)
  return { client: ctx.defaultLLMClient, model: MODEL_MAP[PLATFORM_PROVIDER].default };
}


// =============================================================================
// Anthropic -> OpenAI format conversion (used by OpenAI-compatible backends: OpenAI, xAI)
// =============================================================================

function convertToolToOpenAI(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema || { type: "object", properties: {} },
    },
  };
}

function convertMessagesToOpenAI(systemPrompt, messages) {
  const out = [];
  // System can be an array of blocks (Anthropic prompt-caching shape): flatten to string
  if (Array.isArray(systemPrompt)) systemPrompt = systemPrompt.map(b => b?.text || "").join("");
  if (systemPrompt) out.push({ role: "system", content: systemPrompt });

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content)) {
      out.push({ role: msg.role, content: String(msg.content ?? "") });
      continue;
    }

    if (msg.role === "assistant") {
      const textParts = [];
      const toolCalls = [];
      for (const block of msg.content) {
        if (block.type === "text") textParts.push(block.text);
        else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}),
            },
          });
        }
        // Skip thinking blocks
      }
      const converted = { role: "assistant", content: textParts.join("\n") || null };
      if (toolCalls.length > 0) converted.tool_calls = toolCalls;
      out.push(converted);

    } else if (msg.role === "user") {
      const toolResults = [];
      const otherParts = []; // can be strings or objects (for multimodal)
      let hasMultimodal = false;
      for (const block of msg.content) {
        if (block.type === "tool_result") toolResults.push(block);
        else if (block.type === "text") otherParts.push({ type: "text", text: block.text });
        else if (block.type === "image" && block.source?.data) {
          // Convert Anthropic image format to OpenAI image_url format
          hasMultimodal = true;
          otherParts.push({
            type: "image_url",
            image_url: { url: `data:${block.source.media_type || "image/jpeg"};base64,${block.source.data}` },
          });
        }
        else if (block.type === "document") otherParts.push({ type: "text", text: `[Document: ${block.source?.filename || block.filename || "file"}]` });
        else otherParts.push({ type: "text", text: block.text || "" });
      }
      // Images returned BY a tool need care here. The OpenAI-compatible chat
      // format has no way to put an image inside a role:"tool" message, and
      // this used to flatten them to the literal string "[Image]", so a
      // screenshot or an attachment the model had just fetched arrived as two
      // words and it stayed blind to its own tool output. They are carried
      // across as a user message straight after the tool results instead,
      // which is the only slot the format allows an image to travel in.
      const toolImages = [];
      for (const tr of toolResults) {
        let content = tr.content;
        if (typeof content === "object" && content !== null) {
          if (Array.isArray(content)) {
            content = content.map((b) => {
              if (b.type === "text") return b.text;
              if (b.type === "image" && b.source?.data) {
                toolImages.push({
                  type: "image_url",
                  image_url: { url: `data:${b.source.media_type || "image/jpeg"};base64,${b.source.data}` },
                });
                return "[image follows below]";
              }
              return JSON.stringify(b);
            }).join("\n");
          } else {
            content = JSON.stringify(content);
          }
        }
        out.push({ role: "tool", tool_call_id: tr.tool_use_id, content: (tr.is_error ? "Error: " : "") + (content || "") });
      }
      if (toolImages.length > 0) {
        out.push({
          role: "user",
          content: [
            { type: "text", text: toolImages.length === 1
                ? "This is the image returned by the tool call above."
                : `These are the ${toolImages.length} images returned by the tool calls above.` },
            ...toolImages,
          ],
        });
      }
      if (otherParts.length > 0) {
        // If there are images, send as multimodal content array; otherwise flatten to string
        if (hasMultimodal) {
          out.push({ role: "user", content: otherParts });
        } else {
          out.push({ role: "user", content: otherParts.map(p => p.text || "").join("\n") });
        }
      }

    } else {
      const text = msg.content.map((b) => b.text || "").filter(Boolean).join("\n");
      out.push({ role: msg.role, content: text || "" });
    }
  }
  return out;
}

function convertResponseFromOpenAI(openaiResponse) {
  const choice = openaiResponse.choices?.[0];
  if (!choice) return { content: [{ type: "text", text: "" }], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } };

  const message = choice.message || {};
  const content = [];
  if (message.content) {
    // Strip reasoning tags (<think>...</think>) some models emit; keep only the visible response
    let text = message.content;
    text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    content.push({ type: "text", text });
  }
  if (message.tool_calls?.length > 0) {
    for (const tc of message.tool_calls) {
      let parsed;
      try { parsed = JSON.parse(tc.function.arguments); } catch { parsed = tc.function.arguments; }
      content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: parsed });
    }
  }
  if (content.length === 0) content.push({ type: "text", text: "" });

  const stopReason = choice.finish_reason === "tool_calls" ? "tool_use"
    : choice.finish_reason === "length" ? "max_tokens" : "end_turn";

  return {
    content,
    stop_reason: stopReason,
    usage: {
      input_tokens: openaiResponse.usage?.prompt_tokens || 0,
      output_tokens: openaiResponse.usage?.completion_tokens || 0,
      // xAI/OpenAI report automatic prefix-cache hits here; surfaced for cost logging
      cache_read_input_tokens: openaiResponse.usage?.prompt_tokens_details?.cached_tokens || 0,
    },
  };
}

// =============================================================================
// Anthropic -> Gemini format conversion
// =============================================================================

function convertToolToGemini(tool) {
  return {
    name: tool.name,
    description: tool.description || "",
    parameters: tool.input_schema || { type: "object", properties: {} },
  };
}

function convertMessagesToGemini(systemPrompt, messages) {
  // Gemini uses { contents: [...], systemInstruction: { parts: [...] } }
  // System can be an array of blocks (Anthropic prompt-caching shape): flatten to string
  if (Array.isArray(systemPrompt)) systemPrompt = systemPrompt.map(b => b?.text || "").join("");
  const contents = [];

  for (const msg of messages) {
    const role = msg.role === "assistant" ? "model" : "user";
    const parts = [];

    if (typeof msg.content === "string") {
      parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push({ text: block.text });
        } else if (block.type === "tool_use") {
          parts.push({ functionCall: { name: block.name, args: block.input || {} } });
        } else if (block.type === "tool_result") {
          // Gemini: tool results go in a user message with functionResponse parts
          parts.push({
            functionResponse: {
              name: block.name || block._toolName || "unknown",
              response: typeof block.content === "string" ? { result: block.content }
                : Array.isArray(block.content) ? { result: block.content.map(b => b.text || JSON.stringify(b)).join("\n") }
                : { result: JSON.stringify(block.content) },
            },
          });
        } else if (block.type === "image") {
          if (block.source?.data) {
            parts.push({ inlineData: { mimeType: block.source.media_type || "image/png", data: block.source.data } });
          }
        }
        // Skip thinking, document blocks
      }
    }

    if (parts.length > 0) contents.push({ role, parts });
  }

  return { contents, systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined };
}

function convertResponseFromGemini(geminiResponse) {
  const candidate = geminiResponse.candidates?.[0];
  if (!candidate) return { content: [{ type: "text", text: "" }], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } };

  const content = [];
  let hasToolCalls = false;

  for (const part of candidate.content?.parts || []) {
    if (part.text) {
      content.push({ type: "text", text: part.text });
    } else if (part.functionCall) {
      hasToolCalls = true;
      content.push({
        type: "tool_use",
        id: `toolu_${Math.random().toString(36).slice(2, 14)}`,
        name: part.functionCall.name,
        input: part.functionCall.args || {},
      });
    }
  }

  if (content.length === 0) content.push({ type: "text", text: "" });

  const stopReason = hasToolCalls ? "tool_use"
    : candidate.finishReason === "MAX_TOKENS" ? "max_tokens" : "end_turn";

  const usage = {
    input_tokens: geminiResponse.usageMetadata?.promptTokenCount || 0,
    output_tokens: geminiResponse.usageMetadata?.candidatesTokenCount || 0,
  };

  return { content, stop_reason: stopReason, usage };
}

// =============================================================================
// Patch tool_result blocks with tool names (needed for Gemini which has no IDs)
// =============================================================================

function enrichToolResults(messages) {
  // Build a map of tool_use_id -> tool_name from assistant messages
  const idToName = {};
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_use") idToName[block.id] = block.name;
    }
  }
  // Patch tool_result blocks with _toolName
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool_result" && block.tool_use_id) {
        block._toolName = idToName[block.tool_use_id] || "unknown";
      }
    }
  }
}

// =============================================================================
// Client factory
// =============================================================================

// Public entry: builds the backend client, then wraps it so every
// messages.create records its usage block under a feature label
// (opts.usageFeature, default "chat") for the dashboard's Usage tab.
function createLLMClient(opts = {}) {
  const { withUsageTracking } = require("./usage");
  return withUsageTracking(_createLLMClientRaw(opts), opts.usageFeature || "chat", opts.model);
}

function _createLLMClientRaw(opts = {}) {
  const { backend = "anthropic" } = opts;

  // --- Anthropic (native SDK) ---
  if (backend === "anthropic") {
    const Anthropic = require("@anthropic-ai/sdk");
    const apiKey = opts.anthropicApiKey || opts.anthropicClient;
    if (!apiKey) throw new Error("createLLMClient: anthropicApiKey required");
    if (typeof apiKey === "string") return new Anthropic({ apiKey });
    return apiKey; // Already a client object
  }

  // --- OpenAI ---
  if (backend === "openai") {
    const apiKey = opts.apiKey || opts.openaiApiKey;
    if (!apiKey) throw new Error("createLLMClient: apiKey required for openai");

    return {
      messages: {
        create: async (params) => {
          const model = resolveModel(params.model, "openai");
          const tools = (params.tools || []).map(convertToolToOpenAI);
          const messages = convertMessagesToOpenAI(params.system || null, params.messages || []);

          const body = { model, messages, max_tokens: params.max_tokens || 4096 };
          if (tools.length > 0) { body.tools = tools; body.tool_choice = "auto"; }

          const resp = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
            body: JSON.stringify(body),
          });

          if (!resp.ok) {
            const errText = await resp.text().catch(() => "");
            throw new Error(`OpenAI API error ${resp.status}: ${errText.substring(0, 500)}`);
          }

          return convertResponseFromOpenAI(await resp.json());
        },
      },
    };
  }

  // --- xAI (Grok) — platform default. OpenAI-compatible chat completions. ---
  if (backend === "xai") {
    const apiKey = opts.apiKey || opts.xaiApiKey;
    if (!apiKey) throw new Error("createLLMClient: apiKey required for xai");

    return {
      messages: {
        create: async (params) => {
          // "grok-4.5:high" -> model grok-4.5, reasoning_effort high
          const mapped = resolveModel(params.model, "xai");
          const [model, effort] = mapped.split(":");
          const tools = (params.tools || []).map(convertToolToOpenAI);
          const messages = convertMessagesToOpenAI(params.system || null, params.messages || []);

          const body = { model, messages, max_tokens: params.max_tokens || 4096 };
          // Anthropic-style deepThink translates to max reasoning effort
          body.reasoning_effort = params.thinking ? "high" : (effort || "medium");
          if (tools.length > 0) { body.tools = tools; body.tool_choice = "auto"; }

          const resp = await fetch("https://api.x.ai/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
            body: JSON.stringify(body),
          });

          if (!resp.ok) {
            const errText = await resp.text().catch(() => "");
            throw new Error(`xAI API error ${resp.status}: ${errText.substring(0, 500)}`);
          }

          return convertResponseFromOpenAI(await resp.json());
        },
      },
    };
  }

  // --- Custom (any OpenAI-compatible endpoint) ---
  // Kimi, Qwen, DeepSeek, Groq, Together, OpenRouter, Mistral, a local Ollama:
  // they all copied OpenAI's wire format, so one adapter with a configurable
  // address and model covers the lot. The user names the model because the
  // endpoint cannot: /chat/completions takes "model" in the body and most
  // providers serve dozens.
  if (backend === "custom") {
    const apiKey = opts.apiKey;
    const baseUrl = String(opts.baseUrl || "").replace(/\/+$/, "");
    const fixedModel = opts.model;
    if (!baseUrl) throw new Error("createLLMClient: baseUrl required for custom");
    if (!fixedModel) throw new Error("createLLMClient: model required for custom");

    return {
      messages: {
        create: async (params) => {
          // A text-only model must never receive an image block: strip them to
          // placeholders before conversion rather than letting the endpoint 400.
          let srcMessages = params.messages || [];
          if (opts.stripImages) {
            srcMessages = srcMessages.map((m) => Array.isArray(m.content)
              ? { ...m, content: m.content.map((b) => b.type === "image" ? { type: "text", text: "[image omitted]" } : b) }
              : m);
          }
          const tools = (params.tools || []).map(convertToolToOpenAI);
          const messages = convertMessagesToOpenAI(params.system || null, srcMessages);

          const body = { model: fixedModel, messages, max_tokens: params.max_tokens || 4096 };
          if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort;
          if (tools.length > 0) { body.tools = tools; body.tool_choice = "auto"; }

          const headers = { "Content-Type": "application/json" };
          if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`; // a local Ollama has no key

          const resp = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST", headers, body: JSON.stringify(body),
          });

          if (!resp.ok) {
            const errText = await resp.text().catch(() => "");
            throw new Error(`Custom LLM error ${resp.status}: ${errText.substring(0, 500)}`);
          }

          return convertResponseFromOpenAI(await resp.json());
        },
      },
    };
  }

  // --- Gemini ---
  if (backend === "gemini") {
    const apiKey = opts.apiKey || opts.geminiApiKey;
    if (!apiKey) throw new Error("createLLMClient: apiKey required for gemini");

    return {
      messages: {
        create: async (params) => {
          const model = resolveModel(params.model, "gemini");
          const tools = (params.tools || []).map(convertToolToGemini);

          // Enrich tool results with tool names for Gemini
          enrichToolResults(params.messages || []);

          const { contents, systemInstruction } = convertMessagesToGemini(params.system || null, params.messages || []);

          const body = { contents, generationConfig: { maxOutputTokens: params.max_tokens || 4096 } };
          if (systemInstruction) body.systemInstruction = systemInstruction;
          if (tools.length > 0) body.tools = [{ functionDeclarations: tools }];

          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
          const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });

          if (!resp.ok) {
            const errText = await resp.text().catch(() => "");
            throw new Error(`Gemini API error ${resp.status}: ${errText.substring(0, 500)}`);
          }

          return convertResponseFromGemini(await resp.json());
        },
      },
    };
  }

  throw new Error(`createLLMClient: unknown backend "${backend}"`);
}

// Whether the user's CHAT model can see images. The platform model and the
// big three all can; a custom endpoint is assumed text-only, because a wrong
// yes crashes the request while a wrong no still works via substitution.
function chatModelSupportsVision(userStore) {
  const settings = userStore?.profile?.settings || {};
  const provider = settings.llm_provider || "";
  if (provider === "custom" && settings.custom_base_url && settings.custom_model) return false;
  return true;
}

module.exports = {
  createLLMClient,
  resolveModel,
  resolveUserModel,
  getInternalClient,
  getUserLLMClient,
  chatModelSupportsVision,
  MODEL_MAP,
  // Exported for testing
  convertToolToOpenAI,
  convertMessagesToOpenAI,
  convertResponseFromOpenAI,
  convertToolToGemini,
  convertMessagesToGemini,
  convertResponseFromGemini,
};
