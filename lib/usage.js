// lib/usage.js — BYOK spend accounting (tokens, not money).
//
// Every LLM/embedding response carries a usage block; this buffers those counts
// in memory keyed by feature|model and flushes them to token_usage every 30s
// via the atomic record_token_usage RPC. Pure accounting: no LLM calls of its
// own, no retries beyond keeping the buffer, and a hard cap so a dead DB can
// never grow memory unbounded. Features: chat / machinery / enrichment /
// vision / embeddings.

const FLUSH_MS = 30_000;
const MAX_BUFFER_KEYS = 200;

const _buffer = new Map(); // "feature|model" -> { calls, tin, tout }
let _timer = null;

// Accepts either Anthropic-shaped ({input_tokens, output_tokens}) or
// OpenAI-shaped ({prompt_tokens, completion_tokens}) usage blocks.
function recordUsage(feature, model, usage) {
  if (!usage) return;
  const tin = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const tout = usage.output_tokens ?? usage.completion_tokens ?? 0;
  if (!tin && !tout) return;

  const key = `${feature}|${model || "unknown"}`;
  if (!_buffer.has(key) && _buffer.size >= MAX_BUFFER_KEYS) return; // cap, drop
  const cur = _buffer.get(key) || { calls: 0, tin: 0, tout: 0 };
  cur.calls += 1;
  cur.tin += tin;
  cur.tout += tout;
  _buffer.set(key, cur);

  if (!_timer) {
    _timer = setInterval(() => { flushUsage().catch(() => {}); }, FLUSH_MS);
    if (_timer.unref) _timer.unref();
  }
}

async function flushUsage() {
  if (_buffer.size === 0) return;
  const { supabase, isDbConfigured } = require("./db");
  if (!isDbConfigured()) { _buffer.clear(); return; } // setup mode: nothing to bill against

  const { getAdminUserId } = require("./admin");
  const adminId = getAdminUserId();
  const day = new Date().toISOString().slice(0, 10);

  const entries = [..._buffer.entries()];
  _buffer.clear();
  for (const [key, v] of entries) {
    const [feature, model] = key.split("|");
    const { error } = await supabase.rpc("record_token_usage", {
      p_user_id: adminId,
      p_day: day,
      p_feature: feature,
      p_model: model,
      p_calls: v.calls,
      p_tokens_in: v.tin,
      p_tokens_out: v.tout,
    });
    if (error) {
      // Put it back for the next flush (unless the cap says drop).
      const cur = _buffer.get(key) || { calls: 0, tin: 0, tout: 0 };
      if (_buffer.has(key) || _buffer.size < MAX_BUFFER_KEYS) {
        _buffer.set(key, { calls: cur.calls + v.calls, tin: cur.tin + v.tin, tout: cur.tout + v.tout });
      }
      console.error(`[usage] flush failed for ${key}: ${error.message || error.code}`);
    }
  }
}

// Wrap an LLM client so every messages.create records under `feature`.
// Covers both the adapter clients and the raw Anthropic SDK: only
// messages.create is used anywhere in this codebase.
function withUsageTracking(client, feature, fallbackModel) {
  if (!client || !client.messages || typeof client.messages.create !== "function") return client;
  return {
    ...client,
    messages: {
      ...client.messages,
      create: async (params) => {
        const response = await client.messages.create(params);
        try { recordUsage(feature, fallbackModel || params?.model || response?.model, response?.usage); } catch (_) {}
        return response;
      },
    },
  };
}

module.exports = { recordUsage, flushUsage, withUsageTracking };
