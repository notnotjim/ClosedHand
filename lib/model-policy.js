// Host-aware capabilities and effort translation. Unknown APIs keep their defaults.
const BASES = {
  anthropic: "https://api.anthropic.com/v1", openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  xai: "https://api.x.ai/v1", deepseek: "https://api.deepseek.com/v1",
  deepinfra: "https://api.deepinfra.com/v1/openai", openrouter: "https://openrouter.ai/api/v1",
  groq: "https://api.groq.com/openai/v1", moonshot: "https://api.moonshot.ai/v1",
};
function hostOf(base) { try { return new URL(base).hostname; } catch { return ""; } }
function connection(input) {
  const provider = String(input.provider || input.backend || "custom");
  const backend = ["anthropic", "gemini"].includes(provider) ? provider : "custom";
  const baseUrl = String(BASES[provider] || input.baseUrl || "").trim().replace(/\/+$/, "");
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Enter a base URL without a password, query or fragment.");
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]", "host.docker.internal"].includes(url.hostname)) throw new Error("Use HTTPS for a remote model provider.");
  return { provider, backend, baseUrl, apiKey: String(input.apiKey || "").trim() };
}
function capabilities(conn, model, metadata = {}) {
  const host = hostOf(conn.baseUrl || BASES[conn.backend]);
  const modalities = metadata.architecture?.input_modalities || metadata.input_modalities;
  const supported = metadata.supported_parameters;
  let vision = Array.isArray(modalities) ? modalities.includes("image") : null;
  let tools = Array.isArray(supported) ? supported.includes("tools") : null;
  const context = Number(metadata.context_length || metadata.context_window || metadata.inputTokenLimit);
  let reasoning = null;
  if (host === "openrouter.ai" && supported?.includes("reasoning")) reasoning = "router";
  if (host === "api.deepseek.com" && /^deepseek-(?:v[34]|flash|pro|chat|reasoner)/i.test(model)) reasoning = "deepseek";
  if (host === "api.deepinfra.com" && /^(?:deepseek-ai\/DeepSeek-V[34]|zai-org\/GLM-5|moonshotai\/Kimi-K3|inclusionAI\/Ling-3)/i.test(model)) reasoning = "deepinfra";
  if (host === "api.deepinfra.com" && /^Qwen\/Qwen3(?!.*(?:Instruct|Embedding|Reranker))/i.test(model)) reasoning = "qwen";
  if (host === "api.x.ai" && /^grok-4\.5(?:$|[-:])/.test(model)) reasoning = "xai";
  if (host === "api.openai.com" && /^(?:o[134](?:-|$)|gpt-[56](?:[.-]|$))/.test(model)) reasoning = "openai";
  if (conn.backend === "anthropic" && /^claude-(?:sonnet|opus)-(?:4-6|[5-9])/.test(model)) reasoning = "adaptive";
  else if (conn.backend === "anthropic" && /^claude-(?:3-7|(?:sonnet|opus)-4)/.test(model)) reasoning = "anthropic-budget";
  if (conn.backend === "gemini" && /^gemini-3/.test(model)) reasoning = "gemini-level";
  else if (conn.backend === "gemini" && /^gemini-2\.5/.test(model)) reasoning = "gemini-budget";
  // Known multimodal families, only on their original provider.
  if (vision === null && (
    (conn.backend === "anthropic" && /^claude-(?:3|sonnet|opus|haiku)/.test(model)) ||
    (conn.backend === "gemini" && /^gemini-(?:[23]|flash|pro)/.test(model)) ||
    (host === "api.openai.com" && /^(?:gpt-4o|gpt-4\.1|gpt-[56]|o[34])/.test(model)) ||
    (host === "api.x.ai" && /^grok-(?:4|.*vision)/.test(model))
  )) vision = true;
  return { vision, tools, contextWindow: Number.isFinite(context) && context >= 4096 ? context : null, reasoning };
}
function effortOptions(cap, effort = "default", maxTokens = 4096) {
  const low = effort === "fast", high = effort === "strong";
  switch (cap?.reasoning) {
    case "router": return { reasoning: { effort: low ? "low" : high ? "high" : "medium" }, provider: { require_parameters: true } };
    case "deepseek": return low ? { thinking: { type: "disabled" } } : { thinking: { type: "enabled" }, reasoning_effort: high ? "max" : "high" };
    case "deepinfra": return { reasoning_effort: low ? "none" : high ? "high" : "medium" };
    case "qwen": return { chat_template_kwargs: { enable_thinking: !low } };
    case "xai": case "openai": return { reasoning_effort: low ? "low" : high ? "high" : "medium" };
    case "adaptive": return { thinking: { type: "adaptive" }, output_config: { effort: low ? "low" : high ? "high" : "medium" } };
    case "anthropic-budget": return high && maxTokens > 1024 ? { thinking: { type: "enabled", budget_tokens: Math.min(10000, maxTokens - 1) } } : {};
    case "gemini-level": return { thinkingConfig: { thinkingLevel: low ? "low" : "high" } };
    case "gemini-budget": return { thinkingConfig: { thinkingBudget: low ? 128 : high ? Math.min(8192, Math.max(128, maxTokens - 128)) : -1 } };
    default: return {};
  }
}
function getRole(settings, role) {
  const config = settings?.model_config;
  if (!config) return undefined; // Legacy setup, intentionally distinct from disabled.
  const pick = config.roles?.[role];
  if (!pick) return null;
  const conn = config.connections?.[pick.connection];
  if (!conn) throw new Error("The model connection is missing. Check Models in Settings.");
  return { ...conn, model: pick.model, capabilities: pick.capabilities };
}
function publicConfig(config) {
  if (!config) return null;
  return { ...config, connections: Object.fromEntries(Object.entries(config.connections).map(([id, c]) =>
    [id, { provider: c.provider, backend: c.backend, baseUrl: c.baseUrl, hasKey: !!c.apiKey }])) };
}
function publicSettings(settings = {}) {
  return Object.fromEntries(Object.entries(settings).filter(([key]) =>
    key !== "self_host_config" && !/(?:api_key|secret|token)/i.test(key)
  ).map(([key, value]) => [key, key === "model_config" ? publicConfig(value) : value]));
}
module.exports = { BASES, connection, capabilities, effortOptions, getRole, publicConfig, publicSettings };
