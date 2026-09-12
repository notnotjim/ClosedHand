// Model metadata is shared only for the same endpoint and credential identity.
const { createHash } = require("crypto");
const cache = new Map();
function attachCapabilities(client, opts) {
  const backend = opts.backend;
  const base = backend === "custom" ? opts.baseUrl : backend === "xai" ? "https://api.x.ai/v1" : null;
  if (!base) return client;
  const key = opts.apiKey || opts.xaiApiKey || "";
  const signature = createHash("sha256").update(base + "|" + key).digest("hex");
  return { ...client, getModelLimits: async model => {
    let entry = cache.get(signature);
    if (!entry || entry.expires < Date.now()) {
      const promise = (async () => {
        const response = await fetch(String(base).replace(/\/$/, "") + "/models", {
          headers: key ? { Authorization: "Bearer " + key } : {}, signal: AbortSignal.timeout(4000),
        });
        if (!response.ok) return [];
        return (await response.json()).data || [];
      })().catch(() => []);
      entry = { promise, expires: Date.now() + 60 * 60 * 1000 }; cache.set(signature, entry);
      if (cache.size > 100) cache.delete(cache.keys().next().value);
    }
    const models = await entry.promise;
    const found = models.find(m => m.id === String(model).split(":")[0]);
    const context = Number(found?.context_length || found?.context_window || opts.contextWindow);
    return Number.isFinite(context) && context >= 4096 ? { contextWindow: context } : null;
  } };
}
module.exports = { attachCapabilities };
