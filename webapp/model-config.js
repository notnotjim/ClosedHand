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
    apiKey: policy.openKey(settings[provider === "custom" ? "custom_api_key" : provider + "_api_key"]) });
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
    conn.apiKey = policy.openKey(previous.apiKey);
  }
  if (!conn.apiKey && !["ollama", "custom"].includes(conn.provider)) throw new Error("Paste your provider's API key.");
  return conn;
}
// A provider's 400 or 404 for a model its own list doesn't include is almost
// always a mistyped ID, so the person is told that rather than a bare status.
function unlisted(error, catalog, model) {
  if (![400, 404].includes(error.status) || error.code === "model_id_is_key" || !catalog.length || catalog.some(m => m.id === model)) return error;
  return Object.assign(new Error("This provider doesn't list a model with that ID. Choose one from the list, or copy the exact ID from the provider's documentation."), { status: error.status });
}
// Ollama's default window is 4,096 tokens and its OpenAI-style interface cuts
// longer text to fit without saying so, so a model there can pass every other
// check and still lose most of ClosedHand's instructions. Once the check has
// loaded the model, Ollama reports the window it actually gives it (/api/ps)
// and the most the model itself can take (/api/show).
const OLLAMA_MIN_WINDOW = 32000;
async function ollamaWindow(conn, model) {
  if (conn.provider !== "ollama") return null;
  const root = conn.baseUrl.replace(/\/v1$/, "");
  try {
    const ps = await fetch(root + "/api/ps", { signal: AbortSignal.timeout(5000), redirect: "error" }).then(r => r.json());
    const given = Number((ps.models || []).find(m => m.name === model || m.model === model)?.context_length) || null;
    if (!given) return null;
    let most = null;
    try {
      const show = await fetch(root + "/api/show", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }),
        signal: AbortSignal.timeout(5000), redirect: "error" }).then(r => r.json());
      const key = Object.keys(show.model_info || {}).find(k => k.endsWith(".context_length"));
      most = key ? Number(show.model_info[key]) || null : null;
    } catch { /* the model's own limit stays unknown */ }
    return { given, most };
  } catch { return null; }
}
function windowProblem(window, model) {
  if (!window || window.given >= OLLAMA_MIN_WINDOW) return null;
  const tokens = (n) => n.toLocaleString("en-US");
  return window.most && window.most < OLLAMA_MIN_WINDOW
    ? `${model} can take at most ${tokens(window.most)} tokens, too few for ClosedHand's instructions. Choose a model in Ollama that takes at least 32,000.`
    : `Ollama gives ${model} a window of ${tokens(window.given)} tokens, too small for ClosedHand's instructions, and it cuts longer requests short without saying so. Set Ollama's context length to at least 32,000, in the Ollama app's settings or with OLLAMA_CONTEXT_LENGTH, restart Ollama, then check again.`;
}
async function fitsInstructions(conn, model, cap) {
  const window = await ollamaWindow(conn, model);
  if (!window) return;
  cap.contextWindow = window.given;
  const problem = windowProblem(window, model);
  if (problem) throw new Error(problem);
}
async function checkModel(conn, model, purpose, catalog) {
  try { return await probeModel(conn, model, purpose, catalog); } catch (e) { throw unlisted(e, catalog, model); }
}
async function probeModel(conn, model, purpose, catalog) {
  if (!model || model.length > 200) throw new Error("Choose a model for " + purpose + ".");
  const meta = catalog.find(m => m.id === model)?.metadata || {};
  const cap = policy.capabilities(conn, model, meta);
  const base = { model, max_tokens: 1024, effort: "fast" };
  if (purpose === "chat") {
    if (cap.tools === false) throw new Error("This provider lists the chosen model without tool calling. Choose a primary model that can use tools.");
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
  } else if (purpose === "support") {
    const response = await wire.request({ ...conn, capabilities: cap }, { ...base, messages: [{ role: "user", content: "Reply with the word ready." }] }, { signal: AbortSignal.timeout(45000) });
    if (!response.content?.some(b => b.type === "text" && b.text?.trim())) throw new Error("The support model returned no answer. Retry or choose another model.");
  }
  return cap;
}
async function prepare(input, settings) {
  const saved = settings.model_config || legacyConfig(settings);
  const connections = { primary: resolveConnection(input.primary || {}, saved, "primary") };
  const catalog = await wire.listModels(connections.primary).catch(() => []);
  const model = String(input.model || "").trim();
  const chat = await checkModel(connections.primary, model, "chat", catalog);
  await fitsInstructions(connections.primary, model, chat);
  const supportMode = input.backgroundMode || (input.backgroundModel ? "separate" : "same");
  if (!["same", "separate"].includes(supportMode)) throw new Error("Choose how ClosedHand should handle support work.");
  let supportConnection = "primary", supportCatalog = catalog;
  if (supportMode === "separate" && input.background?.provider) {
    connections.background = resolveConnection(input.background, saved, "background");
    supportConnection = "background";
    supportCatalog = await wire.listModels(connections.background).catch(() => []);
  }
  const backgroundModel = supportMode === "same" ? model : String(input.backgroundModel || "").trim();
  const background = supportConnection === "primary" && backgroundModel === model ? chat
    : await checkModel(connections[supportConnection], backgroundModel, "support", supportCatalog);
  if (background !== chat) await fitsInstructions(connections[supportConnection], backgroundModel, background);
  const roles = {
    chat: { connection: "primary", model, capabilities: chat },
    background: { connection: supportConnection, model: backgroundModel, capabilities: background },
    vision: null,
  };
  const mode = input.visionMode || "same";
  if (!["same", "separate", "off"].includes(mode)) throw new Error("Choose how ClosedHand should read images.");
  if (mode !== "off") {
    let conn = connections.primary, visionModel = model, visionCap = chat, connectionId = "primary", visionCatalog = catalog;
    if (mode === "separate") {
      if (input.vision?.provider) {
        connections.vision = resolveConnection(input.vision, saved, "vision");
        conn = connections.vision; connectionId = "vision";
      }
      visionModel = String(input.visionModel || "").trim();
      if (!visionModel) throw new Error("Choose a model for images.");
      if (connectionId !== "primary") visionCatalog = await wire.listModels(conn).catch(() => []);
      visionCap = policy.capabilities(conn, visionModel, visionCatalog.find(m => m.id === visionModel)?.metadata);
    }
    if (visionCap.vision === false) throw Object.assign(new Error("This model does not accept images. Choose an image model from this provider or another provider, or continue without images."), { visionNeeded: true });
    // An advertised capability is checked against the actual endpoint before saving.
    const imageReply = await wire.request({ ...conn, capabilities: visionCap }, { model: visionModel, effort: "fast", max_tokens: 1024,
      messages: [{ role: "user", content: [{ type: "text", text: "What is the main colour in this image? Answer in one word." },
        { type: "image", source: { type: "base64", media_type: "image/png", data: RED_IMAGE } }] }],
    }, { signal: AbortSignal.timeout(45000) }).catch(error => { throw Object.assign(unlisted(error, visionCatalog, visionModel), { visionNeeded: true }); });
    if (!imageReply.content?.some(b => b.type === "text" && /\bred\b/i.test(b.text))) throw Object.assign(new Error("The image check did not pass. Retry, choose another image model, or continue without images."), { visionNeeded: true });
    roles.vision = { connection: connectionId, model: visionModel, capabilities: { ...visionCap, vision: true } };
    // An image model needs no room for instructions, so a small window only
    // means fewer frames from a video; the panel says so.
    const visionWindow = await ollamaWindow(conn, visionModel);
    if (visionWindow) roles.vision.capabilities.contextWindow = visionWindow.given;
    if (connectionId === "primary" && visionModel === model) roles.chat.capabilities.vision = true;
  }
  // Video is checked for each model that claims it, with a made-up clip that
  // turns from red to blue. A model that fails still saves: its videos are
  // watched through frames instead, so this never blocks the setup.
  const watched = new Map();
  for (const role of [roles.chat, roles.vision]) {
    if (!role || role.capabilities?.video !== true) continue;
    const key = role.connection + "|" + role.model;
    if (!watched.has(key)) watched.set(key, await watchesVideo({ ...connections[role.connection], capabilities: role.capabilities }, role.model));
    role.capabilities = { ...role.capabilities, video: watched.get(key), videoLinks: watched.get(key) && role.capabilities.videoLinks === true };
  }
  return { version: 1, connections, roles };
}
async function watchesVideo(conn, model) {
  try {
    const reply = await wire.request(conn, { model, effort: "fast", max_tokens: 1024,
      messages: [{ role: "user", content: [{ type: "text", text: "This short video changes colour once. What colour is it at the start, and what colour at the end? Answer in two words." },
        { type: "video", source: { type: "base64", media_type: "video/mp4", data: CHECK_VIDEO } }] }],
    }, { signal: AbortSignal.timeout(60000) });
    return /\bred\b[\s\S]*\bblue\b/i.test(wire.responseText(reply));
  } catch { return false; }
}
// What is saved: keys sealed, in the config and in the older fields kept
// beside it for single-connection readers.
function withConfig(settings, config) {
  const next = { ...settings, model_config: policy.sealConfig(config) };
  for (const field of ["anthropic_api_key", "openai_api_key", "gemini_api_key", "custom_api_key", "custom_base_url", "custom_model", "custom_model_fast", "byok_models"]) delete next[field];
  const conn = config.connections.primary;
  next.llm_provider = conn.backend === "custom" ? "custom" : conn.backend;
  if (conn.backend === "custom") Object.assign(next, { custom_base_url: conn.baseUrl, custom_model: config.roles.chat.model, custom_api_key: policy.sealKey(conn.apiKey) });
  else { next[conn.backend + "_api_key"] = policy.sealKey(conn.apiKey); next.byok_models = { fast: config.roles.chat.model, default: config.roles.chat.model, strong: config.roles.chat.model }; }
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
    const download = (deps.local ? settings.self_host_config?.LOCAL_MODELS_STATUS : null)?.embedder;
    res.set("Cache-Control", "no-store").json({ config: policy.publicConfig(settings.model_config || legacyConfig(settings)), legacy: !settings.model_config, allowDefault: !!deps.allowDefault, runtime: deps.local ? (process.env.CLOSEDHAND_DESKTOP ? "desktop" : "docker") : "hosted",
      activeModels: require("./model-summary").modelSummary(settings, deps.readRuntime, !!deps.local),
      localModels: download ? { embedder: { state: download.state, pct: download.pct } } : null });
  }));
  app.post("/api/model-config/default", route(async (req, res, id) => {
    if (!deps.allowDefault) return res.status(400).json({ error: "There is no default model here. Connect a model provider for ClosedHand to use." });
    await profile(id);
    try {
      await require("./settings-patch").patchSettings(supabase, id, { unset: ["model_config", "llm_provider", "anthropic_api_key", "openai_api_key", "gemini_api_key", "custom_api_key", "custom_base_url", "custom_model", "custom_model_fast", "byok_models"] });
    } catch (_) {
      throw new Error("Could not change the models. Your previous setup is still active.");
    }
    res.json({ success: true });
  }));
  app.post("/api/model-config/models", route(async (req, res, id) => {
    const settings = await profile(id);
    const connectionId = ["vision", "background"].includes(req.body.connection) ? req.body.connection : "primary";
    const savedConfig = settings.model_config || legacyConfig(settings);
    const conn = resolveConnection(req.body[connectionId] || {}, savedConfig, connectionId);
    const models = await wire.listModels(conn);
    // A model this person's saved setup has already checked with an image
    // reads images, whatever the provider's list says about it.
    const proven = new Set(Object.values(savedConfig?.roles || {})
      .filter(r => r?.capabilities?.vision === true && savedConfig.connections[r.connection]?.baseUrl === conn.baseUrl).map(r => r.model));
    res.json({ models: models.map(m => {
      const capabilities = policy.capabilities(conn, m.id, m.metadata);
      if (proven.has(m.id)) capabilities.vision = true;
      return { id: m.id, name: m.metadata?.display_name || m.metadata?.displayName || m.metadata?.name || m.id, capabilities };
    }) });
  }));
  app.post("/api/model-config/check", route(async (req, res, id) => {
    const settings = await profile(id);
    const config = await prepare(req.body, settings);
    for (const [key, entry] of receipts) if (entry.expires < Date.now()) receipts.delete(key);
    if (receipts.size >= 100) receipts.delete(receipts.keys().next().value);
    const ticket = randomUUID();
    receipts.set(ticket, { id, config, previous: JSON.stringify(settings.model_config || null), expires: Date.now() + 10 * 60000 });
    res.set("Cache-Control", "no-store").json({ ticket, config: policy.publicConfig(config),
      memory: await deps.memorySummary?.() || { value: "Keeps its current model", local: false } });
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
    // Only the model keys that change are written (settings-patch.js).
    const { diff, patchSettings } = require("./settings-patch");
    try {
      await patchSettings(supabase, id, diff(settings, withConfig(settings, entry.config)));
    } catch (_) {
      throw new Error("Could not save the models. Your previous setup is still active.");
    }
    receipts.delete(req.body.ticket);
    res.json({ success: true });
  }));
}
const RED_IMAGE = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC";
// Seal provider keys saved before keys were stored encrypted: in the config
// and in the older *_api_key fields. Returns how many fields it sealed.
async function sealStoredKeys(supabase, id) {
  const { data, error } = await supabase.from("profiles").select("settings").eq("id", id).single();
  if (error || !data) return 0;
  const settings = data.settings || {};
  const set = {};
  if (settings.model_config) {
    const sealed = policy.sealConfig(settings.model_config);
    if (JSON.stringify(sealed) !== JSON.stringify(settings.model_config)) set.model_config = sealed;
  }
  for (const [field, value] of Object.entries(settings)) {
    if (/_api_key$/.test(field) && typeof value === "string" && value && !value.startsWith("enc:v1:")) set[field] = policy.sealKey(value);
  }
  if (!Object.keys(set).length) return 0;
  await require("./settings-patch").patchSettings(supabase, id, { set });
  return Object.keys(set).length;
}

module.exports = { install, prepare, withConfig, legacyConfig, ollamaWindow, windowProblem, sealStoredKeys };
// Four seconds at 128 pixels square: two red, then two blue (H.264, made with PyAV).
const CHECK_VIDEO = "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";
