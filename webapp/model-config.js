// Model configuration is per profile. Validation uses synthetic input, never user data.
const { randomUUID } = require("crypto");
const policy = require("./model-policy");
const wire = require("./model-wire");
const receipts = new Map();
function legacyConfig(settings) {
  const provider = settings.llm_provider;
  const model = provider === "custom" ? settings.custom_model : settings.byok_models?.default;
  if (!model) return null;
  const primary = policy.connection({ provider, baseUrl: settings.custom_base_url,
    apiKey: settings[provider === "custom" ? "custom_api_key" : provider + "_api_key"] });
  return { version: 1, connections: { primary }, roles: {
    chat: { connection: "primary", model, capabilities: policy.capabilities(primary, model) },
    background: { connection: "primary", model: settings.custom_model_fast || settings.byok_models?.fast || model },
    vision: null,
  } };
}
function resolveConnection(input, saved, id) {
  const conn = policy.connection(input);
  if (input.useSavedKey) {
    const previous = saved?.connections?.[id];
    if (!previous || previous.baseUrl !== conn.baseUrl || previous.backend !== conn.backend) throw new Error("Paste a key for the newly selected provider.");
    conn.apiKey = previous.apiKey;
  }
  if (!conn.apiKey && !["ollama", "custom"].includes(conn.provider)) throw new Error("Paste your provider's API key.");
  return conn;
}
async function checkModel(conn, model, purpose, catalog) {
  if (!model || model.length > 200) throw new Error("Choose a model for " + purpose + ".");
  const meta = catalog.find(m => m.id === model)?.metadata || {};
  const cap = policy.capabilities(conn, model, meta);
  const base = { model, max_tokens: 1024, effort: "fast" };
  if (purpose === "chat") {
    if (cap.tools === false) throw new Error("This provider lists the chosen model without tool calling. Choose a tool-capable chat model.");
    const response = await wire.request({ ...conn, capabilities: cap }, { ...base,
      messages: [{ role: "user", content: "Call capability_check with value 4. Do not answer in text." }],
      tools: [{ name: "capability_check", description: "Return a number. This is a synthetic connection test.",
        input_schema: { type: "object", properties: { value: { type: "number" } }, required: ["value"] } }],
    }, { signal: AbortSignal.timeout(45000) });
    const tool = response.content?.find(b => b.type === "tool_use" && b.name === "capability_check" && b.input?.value === 4);
    if (!tool) throw new Error("The model answered, but the tool-calling check did not pass. Retry or choose another model.");
    // Also prove the tool-result round trip, including provider reasoning state.
    const followup = await wire.request({ ...conn, capabilities: cap }, { ...base,
      messages: [{ role: "user", content: "Call capability_check with value 4." },
        { role: "assistant", content: response.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: tool.id, content: "4" }] }],
      tools: [{ name: "capability_check", description: "Return a number", input_schema: { type: "object", properties: { value: { type: "number" } } } }],
    }, { signal: AbortSignal.timeout(45000) });
    if (!followup.content?.some(b => b.type === "text" && b.text?.trim())) throw new Error("The model could not finish after a tool result. Retry or choose another model.");
    cap.tools = true;
  } else if (purpose === "summaries") {
    const response = await wire.request({ ...conn, capabilities: cap }, { ...base, messages: [{ role: "user", content: "Reply with the word ready." }] }, { signal: AbortSignal.timeout(45000) });
    if (!response.content?.some(b => b.type === "text" && b.text?.trim())) throw new Error("The summaries model returned no answer. Retry or choose another model.");
  }
  return cap;
}
async function prepare(input, settings) {
  const saved = settings.model_config || legacyConfig(settings);
  const connections = { primary: resolveConnection(input.primary || {}, saved, "primary") };
  const catalog = await wire.listModels(connections.primary).catch(() => []);
  const model = String(input.model || "").trim();
  const chat = await checkModel(connections.primary, model, "chat", catalog);
  const backgroundModel = String(input.backgroundModel || model).trim();
  const background = backgroundModel === model ? chat : await checkModel(connections.primary, backgroundModel, "summaries", catalog);
  const roles = {
    chat: { connection: "primary", model, capabilities: chat },
    background: { connection: "primary", model: backgroundModel, capabilities: background },
    vision: null,
  };
  const mode = input.visionMode || "same";
  if (!["same", "separate", "off"].includes(mode)) throw new Error("Choose how ClosedHand should read images.");
  if (mode !== "off") {
    let conn = connections.primary, visionModel = model, visionCap = chat, connectionId = "primary";
    if (mode === "separate") {
      if (input.vision?.provider) {
        connections.vision = resolveConnection(input.vision, saved, "vision");
        conn = connections.vision; connectionId = "vision";
      }
      visionModel = String(input.visionModel || "").trim();
      if (!visionModel) throw new Error("Choose a model for images.");
      const models = connectionId === "primary" ? catalog : await wire.listModels(conn).catch(() => []);
      visionCap = policy.capabilities(conn, visionModel, models.find(m => m.id === visionModel)?.metadata);
    }
    if (visionCap.vision === false) throw Object.assign(new Error("This model does not accept images. Choose an image model from this provider or another provider, or continue without images."), { visionNeeded: true });
    // An advertised capability is checked against the actual endpoint before saving.
    const imageReply = await wire.request({ ...conn, capabilities: visionCap }, { model: visionModel, effort: "fast", max_tokens: 1024,
      messages: [{ role: "user", content: [{ type: "text", text: "What is the main colour in this image? Answer in one word." },
        { type: "image", source: { type: "base64", media_type: "image/png", data: RED_IMAGE } }] }],
    }, { signal: AbortSignal.timeout(45000) }).catch(error => { throw Object.assign(error, { visionNeeded: true }); });
    if (!imageReply.content?.some(b => b.type === "text" && /\bred\b/i.test(b.text))) throw Object.assign(new Error("The image check did not pass. Retry, choose another image model, or continue without images."), { visionNeeded: true });
    roles.vision = { connection: connectionId, model: visionModel, capabilities: { ...visionCap, vision: true } };
    if (connectionId === "primary" && visionModel === model) roles.chat.capabilities.vision = true;
  }
  return { version: 1, connections, roles };
}
function withConfig(settings, config) {
  const next = { ...settings, model_config: config };
  for (const field of ["anthropic_api_key", "openai_api_key", "gemini_api_key", "custom_api_key", "custom_base_url", "custom_model", "custom_model_fast", "byok_models"]) delete next[field];
  const conn = config.connections.primary;
  next.llm_provider = conn.backend === "custom" ? "custom" : conn.backend;
  if (conn.backend === "custom") Object.assign(next, { custom_base_url: conn.baseUrl, custom_model: config.roles.chat.model, custom_api_key: conn.apiKey });
  else { next[conn.backend + "_api_key"] = conn.apiKey; next.byok_models = { fast: config.roles.chat.model, default: config.roles.chat.model, strong: config.roles.chat.model }; }
  return next;
}
function install(app, deps) {
  const { supabase, authorize, ensureMemory } = deps;
  async function profile(id) {
    const { data, error } = await supabase.from("profiles").select("settings").eq("id", id).single();
    if (error || !data) throw new Error("Could not load model settings.");
    return data.settings || {};
  }
  const route = fn => async (req, res) => {
    try { const id = await authorize(req, res); if (!id) return; await fn(req, res, id); }
    catch (e) { res.status(400).json({ error: e.message || "Could not check the model.", visionNeeded: !!e.visionNeeded }); }
  };
  app.get("/api/model-config", route(async (req, res, id) => {
    const settings = await profile(id);
    res.set("Cache-Control", "no-store").json({ config: policy.publicConfig(settings.model_config || legacyConfig(settings)), legacy: !settings.model_config, allowDefault: !!deps.allowDefault });
  }));
  app.post("/api/model-config/default", route(async (req, res, id) => {
    if (!deps.allowDefault) return res.status(400).json({ error: "This installation needs its own model connection." });
    const settings = { ...await profile(id) };
    for (const key of ["model_config", "llm_provider", "anthropic_api_key", "openai_api_key", "gemini_api_key", "custom_api_key", "custom_base_url", "custom_model", "custom_model_fast", "byok_models"]) delete settings[key];
    const { error } = await supabase.from("profiles").update({ settings, updated_at: new Date().toISOString() }).eq("id", id);
    if (error) throw new Error("Could not change the models. Your previous setup is still active.");
    res.json({ success: true });
  }));
  app.post("/api/model-config/models", route(async (req, res, id) => {
    const settings = await profile(id);
    const connectionId = req.body.connection === "vision" ? "vision" : "primary";
    const conn = resolveConnection(req.body[connectionId] || {}, settings.model_config || legacyConfig(settings), connectionId);
    const models = await wire.listModels(conn);
    res.json({ models: models.map(m => ({ id: m.id, capabilities: policy.capabilities(conn, m.id, m.metadata) })) });
  }));
  app.post("/api/model-config/check", route(async (req, res, id) => {
    const settings = await profile(id);
    const config = await prepare(req.body, settings);
    for (const [key, entry] of receipts) if (entry.expires < Date.now()) receipts.delete(key);
    if (receipts.size >= 100) receipts.delete(receipts.keys().next().value);
    const ticket = randomUUID();
    receipts.set(ticket, { id, config, previous: JSON.stringify(settings.model_config || null), expires: Date.now() + 10 * 60000 });
    res.set("Cache-Control", "no-store").json({ ticket, config: policy.publicConfig(config),
      memory: await deps.memorySummary?.() || "Context Brain and File Search keep their existing model provider. This change does not rebuild your stored information." });
  }));
  app.post("/api/model-config/save", route(async (req, res, id) => {
    const entry = receipts.get(req.body.ticket);
    if (!entry || entry.id !== id || entry.expires < Date.now()) throw new Error("Check the models again before saving.");
    let settings = await profile(id);
    if (entry.previous !== JSON.stringify(settings.model_config || null)) throw new Error("The models changed in another session. Check again before saving.");
    if (ensureMemory) {
      await ensureMemory();
      settings = await profile(id);
      if (entry.previous !== JSON.stringify(settings.model_config || null)) throw new Error("The models changed in another session. Check again before saving.");
    }
    const { error } = await supabase.from("profiles").update({ settings: withConfig(settings, entry.config), updated_at: new Date().toISOString() }).eq("id", id);
    if (error) throw new Error("Could not save the models. Your previous setup is still active.");
    receipts.delete(req.body.ticket);
    res.json({ success: true });
  }));
}
const RED_IMAGE = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC";
module.exports = { install, prepare, withConfig, legacyConfig };
