// Metadata caches are scoped to both the endpoint and credential.
const { createHash } = require("crypto");
const cache = new Map();
function attachCapabilities(client, opts) {
  return { ...client, getModelLimits: async model => {
    if (opts.capabilities?.contextWindow) return { contextWindow: opts.capabilities.contextWindow };
    const baseUrl = opts.baseUrl || require("./model-policy").BASES[opts.backend];
    if (!baseUrl) return null;
    const apiKey = opts.apiKey || opts.xaiApiKey || opts.anthropicApiKey || opts.geminiApiKey || "";
    const signature = createHash("sha256").update(baseUrl + "|" + apiKey).digest("hex");
    let entry = cache.get(signature);
    if (!entry || entry.expires < Date.now()) {
      entry = { promise: require("./model-wire").listModels({ backend: opts.backend, baseUrl, apiKey }).catch(() => []), expires: Date.now() + 3600000 };
      cache.set(signature, entry);
      if (cache.size > 100) cache.delete(cache.keys().next().value);
    }
    const native = opts.backend === "xai" ? String(model).replace(/:(low|medium|high)$/, "") : model;
    const metadata = (await entry.promise).find(m => m.id === native)?.metadata;
    const cap = require("./model-policy").capabilities({ backend: opts.backend, baseUrl }, native, metadata);
    return cap.contextWindow ? { contextWindow: cap.contextWindow } : null;
  } };
}
module.exports = { attachCapabilities };
