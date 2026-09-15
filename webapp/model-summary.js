// Public descriptions of effective models. Never return credentials or full provider URLs.
const policy = require("./model-policy");
function location(model, baseUrl) {
  if (String(model).startsWith("local:")) return "On your computer";
  let host;
  try { host = new URL(baseUrl).hostname; } catch { return "Provider not recorded"; }
  if (["localhost", "127.0.0.1", "[::1]", "host.docker.internal"].includes(host)) return "On your computer";
  return ({ "api.x.ai": "xAI", "api.deepinfra.com": "DeepInfra", "api.deepseek.com": "DeepSeek",
    "api.anthropic.com": "Anthropic", "api.openai.com": "OpenAI", "openrouter.ai": "OpenRouter",
    "generativelanguage.googleapis.com": "Google Gemini", "api.groq.com": "Groq", "api.moonshot.ai": "Moonshot" })[host] || host;
}
function modelSummary(settings, read = key => process.env[key], local = false) {
  const runtime = read;
  read = key => runtime(key) || (local ? settings.self_host_config?.[key] : undefined);
  const config = settings.model_config;
  const rows = [];
  const add = (label, model, baseUrl) => rows.push({ label, model: model || "Not enabled", provider: model ? location(model, baseUrl) : "" });
  const configured = (label, role) => {
    const pick = policy.getRole(settings, role);
    add(label, pick?.model, pick?.baseUrl);
  };
  if (config) {
    configured("Conversations", "chat");
    configured("Titles and summaries", "background");
    configured("Reading images", "vision");
  } else {
    const requested = settings.llm_provider;
    const provider = requested === "custom" && settings.custom_base_url && settings.custom_model ? requested
      : ["anthropic", "openai", "gemini"].includes(requested) && settings[requested + "_api_key"] ? requested : "xai";
    const fallback = { xai: "grok-4.5", anthropic: "claude-sonnet-5", openai: "gpt-4o", gemini: "gemini-pro-latest" };
    const model = provider === "custom" ? settings.custom_model : provider === "xai"
      ? (read("XAI_API_KEY") ? fallback.xai : null) : settings.byok_models?.default || fallback[provider];
    add("Conversations", model, provider === "custom" ? settings.custom_base_url : policy.BASES[provider]);
    const internalKey = (local && read("INTERNAL_LLM_API_KEY")) || read("DEEPINFRA_API_KEY");
    add("Titles and summaries", internalKey ? read("INTERNAL_LLM_MODEL") || "deepseek-ai/DeepSeek-V4-Flash" : read("XAI_API_KEY") ? "grok-4.5" : null,
      internalKey ? read("INTERNAL_LLM_URL") || policy.BASES.deepinfra : policy.BASES.xai);
    const enrichKey = read("ENRICH_API_KEY") || read("DEEPINFRA_API_KEY");
    const enrichUrl = read("ENRICH_API_URL") || policy.BASES.deepinfra;
    add("Reading images", enrichKey ? read("VISION_MODEL") || "Qwen/Qwen3-VL-30B-A3B-Instruct" : null, enrichUrl);
    const enrichModel = read("ENRICH_MODEL") || "deepseek-ai/DeepSeek-V4-Flash";
    if (enrichKey && (enrichModel !== rows[1].model || location(enrichModel, enrichUrl) !== rows[1].provider)) add("Document summaries", enrichModel, enrichUrl);
  }
  const embed = read("EMBED_MODEL") || "Qwen/Qwen3-Embedding-4B";
  add("Recall", embed.startsWith("local:") || read("EMBED_API_KEY") || read("DEEPINFRA_API_KEY") ? embed : null,
    read("EMBED_API_URL") || policy.BASES.deepinfra);
  const rerank = read("RERANK_MODEL");
  const localRank = String(rerank).startsWith("local:") || (local && !read("DEEPINFRA_API_KEY"));
  const rankUrl = read("RERANK_API_URL");
  let rankModel = "Qwen/Qwen3-Reranker-8B";
  if (rankUrl) {
    try { rankModel = decodeURIComponent(new URL(rankUrl).pathname.split("/inference/")[1] || "Provider model"); }
    catch { rankModel = "Provider model"; }
  }
  add("Search ranking", localRank ? rerank || "local:jina-reranker-v1-turbo" : read("DEEPINFRA_API_KEY") ? rankModel : null,
    read("RERANK_API_URL") || policy.BASES.deepinfra);
  return rows;
}
module.exports = { modelSummary };
