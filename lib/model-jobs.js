// Job-local profile settings avoid sharing one user's provider with another.
const { AsyncLocalStorage } = require("async_hooks");
const local = new AsyncLocalStorage();
async function withSettings(userId, fn) {
  if (local.getStore()?.userId === userId) return fn();
  const { data, error } = await require("./db").supabase.from("profiles").select("settings").eq("id", userId).single();
  if (error || !data) throw new Error("Could not load model settings for this job.");
  return local.run({ userId, settings: data.settings || {} }, fn);
}
function role(name) {
  const settings = local.getStore()?.settings || require("./context").activeUserStore?.profile?.settings;
  return require("./model-policy").getRole(settings, name);
}
async function complete(name, system, content, maxTokens, timeoutMs) {
  const pick = role(name);
  if (pick === undefined) return undefined;
  if (!pick) return null;
  const result = await require("./llm").createLLMClient({ ...pick, usageFeature: name === "vision" ? "vision" : "enrichment" }).messages.create({
    model: pick.model, effort: "fast", system, messages: [{ role: "user", content }], max_tokens: maxTokens,
  }, { signal: AbortSignal.timeout(timeoutMs) });
  return result.content?.filter(b => b.type === "text").map(b => b.text).join("\n") || null;
}
module.exports = { withSettings, role, complete };
