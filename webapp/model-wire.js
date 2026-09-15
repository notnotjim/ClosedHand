// Shared bot/web transport. Internal requests and responses use content blocks.
const { createHash } = require("crypto");
const policy = require("./model-policy");
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

function convertMessagesToOpenAI(systemPrompt, messages, identity) {
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
      // A turn with neither text nor a tool call still has to carry content:
      // DeepSeek refuses null there ("content or tool_calls must be set").
      const converted = { role: "assistant", content: textParts.join("\n") || (toolCalls.length > 0 ? null : "") };
      if (toolCalls.length > 0) converted.tool_calls = toolCalls;
      const replay = msg.content.find(b => b.type === "provider_state" && b.identity === identity);
      if (replay) Object.assign(converted, replay.value);
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

function convertResponseFromOpenAI(openaiResponse, identity) {
  const choice = openaiResponse.choices?.[0];
  if (!choice) return { content: [{ type: "text", text: "" }], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } };

  const message = choice.message || {};
  const content = [];
  const state = {};
  for (const field of ["reasoning_content", "reasoning_details"]) {
    if (message[field] !== undefined) state[field] = message[field];
  }
  if (Object.keys(state).length) content.push({ type: "provider_state", identity, value: state });
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
      output_tokens: Math.max(openaiResponse.usage?.completion_tokens || 0,
        (openaiResponse.usage?.total_tokens || 0) - (openaiResponse.usage?.prompt_tokens || 0)),
      reasoning_tokens: openaiResponse.usage?.completion_tokens_details?.reasoning_tokens || 0,
      cost_in_usd_ticks: openaiResponse.usage?.cost_in_usd_ticks ?? null,
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

function convertMessagesToGemini(systemPrompt, messages, identity) {
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
        if (block._geminiPart && block._identity === identity) {
          parts.push(block._geminiPart);
        } else if (block.type === "provider_state") {
          if (block.identity === identity && block.geminiPart) parts.push(block.geminiPart);
        } else if (block.type === "text") {
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

function convertResponseFromGemini(geminiResponse, identity) {
  const candidate = geminiResponse.candidates?.[0];
  if (!candidate) return { content: [{ type: "text", text: "" }], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } };

  const content = [];
  let hasToolCalls = false;

  for (const part of candidate.content?.parts || []) {
    if (part.thought) {
      content.push({ type: "provider_state", identity, geminiPart: part });
    } else if (part.text) {
      content.push({ type: "text", text: part.text, _identity: identity, _geminiPart: part });
    } else if (part.functionCall) {
      hasToolCalls = true;
      content.push({
        type: "tool_use", _identity: identity, _geminiPart: part,
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
    output_tokens: (geminiResponse.usageMetadata?.candidatesTokenCount || 0) + (geminiResponse.usageMetadata?.thoughtsTokenCount || 0),
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


function identity(conn, model) {
  return createHash("sha256").update([conn.baseUrl, conn.apiKey || "", model].join("|")).digest("hex");
}
async function request(conn, params, options = {}) {
  const model = params.model || conn.model;
  const cap = conn.capabilities || policy.capabilities(conn, model);
  const id = identity(conn, model);
  const effort = params.effort || (params.thinking?.type === "enabled" ? "strong" : "default");
  const max = params.max_tokens || 4096;
  const controls = policy.effortOptions(cap, effort, max);
  const headers = { "Content-Type": "application/json" };
  let url, body, convert;
  if (conn.backend === "anthropic") {
    headers["x-api-key"] = conn.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    const messages = (params.messages || []).map(m => ({ ...m, content: Array.isArray(m.content) ? m.content.filter(b =>
      b.type !== "provider_state" && (!["thinking", "redacted_thinking"].includes(b.type) || b._identity === id)
    ).map(b => {
      const { _geminiPart, _identity, ...clean } = b; return clean;
    }) : m.content }));
    body = { model, messages, max_tokens: max, ...controls };
    if (params.system) body.system = params.system;
    if (params.tools?.length) body.tools = params.tools;
    if (params.tool_choice) body.tool_choice = params.tool_choice;
    url = conn.baseUrl + "/messages";
    convert = data => ({ ...data, content: data.content?.map(b => ["thinking", "redacted_thinking"].includes(b.type) ? { ...b, _identity: id } : b) });
  } else if (conn.backend === "gemini") {
    const source = structuredClone(params.messages || []);
    enrichToolResults(source);
    const { contents, systemInstruction } = convertMessagesToGemini(params.system, source, id);
    body = { contents, generationConfig: { maxOutputTokens: max, ...controls } };
    if (systemInstruction) body.systemInstruction = systemInstruction;
    if (params.tools?.length) body.tools = [{ functionDeclarations: params.tools.map(convertToolToGemini) }];
    if (params.tool_choice?.type === "any") body.toolConfig = { functionCallingConfig: { mode: "ANY" } };
    headers["x-goog-api-key"] = conn.apiKey;
    url = conn.baseUrl + "/models/" + encodeURIComponent(model) + ":generateContent";
    convert = data => convertResponseFromGemini(data, id);
  } else {
    if (conn.apiKey) headers.Authorization = "Bearer " + conn.apiKey;
    body = { model, messages: convertMessagesToOpenAI(params.system, params.messages || [], id), ...controls };
    body[cap.reasoning === "openai" ? "max_completion_tokens" : "max_tokens"] = max;
    if (params.tools?.length) {
      body.tools = params.tools.map(convertToolToOpenAI);
      body.tool_choice = params.tool_choice?.type === "any" ? "required" : params.tool_choice?.type === "tool"
        ? { type: "function", function: { name: params.tool_choice.name } } : "auto";
    }
    url = conn.baseUrl + "/chat/completions"; convert = data => convertResponseFromOpenAI(data, id);
  }
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body),
    signal: options.signal || AbortSignal.timeout(90000), redirect: "error" });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    if (response.status === 400 && /context.*(?:length|window)|maximum.*(?:prompt|tokens)/i.test(detail.error?.message || "")) {
      throw Object.assign(new Error("The model context window was exceeded."), { status: 400, code: "context_length_exceeded" });
    }
    // The provider's own message goes to the log, trimmed, so a 400 can be
    // diagnosed; never to the user, and never the body, which can carry the request.
    if (detail.error?.message) console.warn(`[model-wire] ${conn.provider || conn.backend} HTTP ${response.status}: ${String(detail.error.message).slice(0, 200)}`);
    const error = new Error("The model provider returned HTTP " + response.status + ". " + providerProblem(response.status, "Check the model, access and balance."));
    error.status = response.status; throw error;
  }
  return convert(await response.json());
}
// What a provider's status code means for the person reading it. Bodies are never echoed.
function providerProblem(status, fallback) {
  return { 401: "The provider rejected the API key.", 402: "The provider says this account needs payment or more credit.",
    403: "The provider refused this key access to the model.", 404: "The provider has no model with this ID.",
    429: "The provider is limiting requests right now. Try again shortly." }[status] || fallback;
}
async function listModels(conn) {
  const headers = {};
  if (conn.backend === "anthropic") Object.assign(headers, { "x-api-key": conn.apiKey, "anthropic-version": "2023-06-01" });
  else if (conn.backend === "gemini") headers["x-goog-api-key"] = conn.apiKey;
  else if (conn.apiKey) headers.Authorization = "Bearer " + conn.apiKey;
  const response = await fetch(conn.baseUrl + "/models", { headers, signal: AbortSignal.timeout(12000), redirect: "error" });
  if (!response.ok) { const e = new Error("Could not load models (HTTP " + response.status + "). " + providerProblem(response.status, "You can enter the model ID.")); e.status = response.status; throw e; }
  const data = await response.json();
  return (data.data || data.models || []).map(m => ({ id: (m.id || m.name || "").replace(/^models\//, ""), metadata: m })).filter(m => m.id);
}
function responseText(response) { return (response?.content || []).filter(b => b.type === "text").map(b => b.text || "").join("\n"); }
module.exports = { responseText, request, listModels, convertToolToOpenAI, convertMessagesToOpenAI, convertResponseFromOpenAI, convertToolToGemini, convertMessagesToGemini, convertResponseFromGemini };
