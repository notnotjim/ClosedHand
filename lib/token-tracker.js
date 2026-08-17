// lib/token-tracker.js — Token-based context window monitoring
// Replaces message-count thresholds with token pressure estimates.
// Uses char/4 heuristic (no external deps). This is a pressure gauge, not a billing meter.

// Context windows per provider (tokens)
const CONTEXT_WINDOWS = {
  anthropic: 1_000_000,
  openai: 128_000,
  gemini: 1_000_000,
  xai: 500_000,
};
const DEFAULT_CONTEXT_WINDOW = 200_000;
const RESERVED_OUTPUT_TOKENS = 4096;

// Legacy exports for backward compat (default to anthropic)
const MODEL_CONTEXT_WINDOW = DEFAULT_CONTEXT_WINDOW;
const AVAILABLE_TOKENS = MODEL_CONTEXT_WINDOW - RESERVED_OUTPUT_TOKENS;

/**
 * Get context window size for a provider.
 */
function getContextWindow(provider) {
  return CONTEXT_WINDOWS[provider] || DEFAULT_CONTEXT_WINDOW;
}

// Token-based thresholds (percentage of available context)
const COMPRESS_TOOLS_THRESHOLD = 0.60;  // 60% — compress old tool results
const SUMMARISE_THRESHOLD = 0.75;       // 75% — vectorise and remove older history

// ============================================================================
// TOKEN ESTIMATION
// ============================================================================

/**
 * Estimate tokens for a string using char/4 heuristic.
 * Fast, zero-dependency, good enough for context pressure monitoring.
 */
function estimateStringTokens(str) {
  if (!str) return 0;
  return Math.ceil(str.length / 4);
}

/**
 * Estimate tokens for a message content block.
 * Handles text strings, arrays with base64 images/PDFs, and tool_result blocks.
 */
function estimateContentTokens(content) {
  if (!content) return 0;

  // Plain text string
  if (typeof content === "string") {
    return estimateStringTokens(content);
  }

  // Array of content blocks (e.g. tool results with images)
  if (Array.isArray(content)) {
    let total = 0;
    for (const block of content) {
      if (block.type === "text") {
        total += estimateStringTokens(block.text);
      } else if (block.type === "image" || block.type === "document") {
        // Base64 data: Anthropic counts tokens from the base64 string, not decoded size.
        // Base64 is ~33% larger than raw, and token ratio varies, but char/4 on base64 is reasonable.
        const b64Len = block.source?.data?.length || 0;
        total += Math.ceil(b64Len / 4);
      } else if (block.type === "tool_use") {
        total += estimateStringTokens(block.name || "");
        total += estimateStringTokens(JSON.stringify(block.input || {}));
      } else if (block.type === "tool_result") {
        total += estimateContentTokens(block.content);
      } else {
        // Fallback: stringify the whole thing
        total += estimateStringTokens(JSON.stringify(block));
      }
    }
    return total;
  }

  // Object (shouldn't happen often, but just in case)
  return estimateStringTokens(JSON.stringify(content));
}

/**
 * Estimate tokens for a single conversation message.
 */
function estimateMessageTokens(msg) {
  if (!msg) return 0;
  // Role overhead (~4 tokens for role marker)
  let tokens = 4;
  tokens += estimateContentTokens(msg.content);
  return tokens;
}

/**
 * Estimate tokens for the system prompt string.
 */
function estimateSystemPromptTokens(systemPrompt) {
  if (!systemPrompt) return 0;
  // System can be a string or an array of {type:"text", text} blocks (prompt caching)
  const text = Array.isArray(systemPrompt) ? systemPrompt.map(b => b?.text || "").join("") : systemPrompt;
  // System prompt has some overhead (~10 tokens for framing)
  return 10 + estimateStringTokens(text);
}

/**
 * Estimate tokens for the tool definitions array.
 * This varies per call thanks to Haiku routing and on-demand tool loading.
 */
function estimateToolTokens(tools) {
  if (!tools || tools.length === 0) return 0;
  let total = 0;
  for (const tool of tools) {
    // Each tool: name + description + JSON schema
    total += estimateStringTokens(tool.name || "");
    total += estimateStringTokens(tool.description || "");
    total += estimateStringTokens(JSON.stringify(tool.input_schema || {}));
    // Per-tool overhead (~20 tokens for framing/formatting)
    total += 20;
  }
  return total;
}

// ============================================================================
// CONTEXT ESTIMATION
// ============================================================================

/**
 * Estimate total context tokens before an API call.
 * @param {Array} conversation - The messages array to send
 * @param {string} systemPrompt - The system prompt string
 * @param {Array} tools - The tools array (may be empty for light/quick mode)
 * @param {string} [provider] - LLM provider name (determines context window size)
 * @returns {Object} { total, breakdown, fillRate, level }
 */
function estimateContextTokens(conversation, systemPrompt, tools, provider) {
  const contextWindow = getContextWindow(provider);
  const available = contextWindow - RESERVED_OUTPUT_TOKENS;
  const systemTokens = estimateSystemPromptTokens(systemPrompt);
  const toolTokens = estimateToolTokens(tools);

  let messageTokens = 0;
  for (const msg of conversation) {
    messageTokens += estimateMessageTokens(msg);
  }

  const total = systemTokens + toolTokens + messageTokens + RESERVED_OUTPUT_TOKENS;
  const fillRate = total / contextWindow;

  let level = "healthy";
  if (fillRate >= SUMMARISE_THRESHOLD) level = "summarising";
  else if (fillRate >= COMPRESS_TOOLS_THRESHOLD) level = "compressing";

  return {
    total,
    available,
    window: contextWindow,
    fillRate,
    level,
    breakdown: {
      system: systemTokens,
      tools: toolTokens,
      messages: messageTokens,
      reserved: RESERVED_OUTPUT_TOKENS,
    },
    messageCount: conversation.length,
  };
}

/**
 * Log the current context fill rate.
 */
function logContextUsage(estimate) {
  const pct = (estimate.fillRate * 100).toFixed(1);
  const totalK = Math.round(estimate.total / 1000);
  const windowK = Math.round(estimate.window / 1000);
  const b = estimate.breakdown;
  const label = estimate.level === "healthy" ? "healthy"
    : estimate.level === "compressing" ? "compressing tool responses"
    : "vectorising history";
  console.log(`[TokenTracker] ${pct}% (${totalK}K/${windowK}K) ${estimate.messageCount} msgs — ${label} [sys:${Math.round(b.system/1000)}K tools:${Math.round(b.tools/1000)}K msgs:${Math.round(b.messages/1000)}K]`);
}

// ============================================================================
// THRESHOLD CHECKS (used by agent loop)
// ============================================================================

/**
 * Check if tool response compression should be triggered.
 */
function shouldCompressTools(estimate) {
  return estimate.fillRate >= COMPRESS_TOOLS_THRESHOLD;
}

/**
 * Check if conversation summarisation should be triggered.
 */
function shouldSummarise(estimate) {
  return estimate.fillRate >= SUMMARISE_THRESHOLD;
}

// ============================================================================
// SYSTEM PROMPT CACHE
// ============================================================================

let _cachedSystemPromptTokens = 0;
let _cachedSystemPromptHash = "";

/**
 * Get cached system prompt token count. Only recalculates if prompt changed.
 */
function getCachedSystemTokens(systemPrompt) {
  // Simple hash: first 100 + last 100 chars + length
  const hash = (systemPrompt || "").substring(0, 100) + (systemPrompt || "").slice(-100) + String((systemPrompt || "").length);
  if (hash !== _cachedSystemPromptHash) {
    _cachedSystemPromptTokens = estimateSystemPromptTokens(systemPrompt);
    _cachedSystemPromptHash = hash;
  }
  return _cachedSystemPromptTokens;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  estimateContextTokens,
  estimateMessageTokens,
  estimateToolTokens,
  estimateSystemPromptTokens,
  logContextUsage,
  shouldCompressTools,
  shouldSummarise,
  getCachedSystemTokens,
  getContextWindow,
  MODEL_CONTEXT_WINDOW,
  AVAILABLE_TOKENS,
  CONTEXT_WINDOWS,
};
