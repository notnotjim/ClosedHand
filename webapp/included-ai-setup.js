// Setting up Closedhand Managed LLM (included-ai.js) on this
// computer, when claiming the personal URL brings its key
// (phone-registration.js). The key is kept sealed, then checked and saved as
// the models the way a key the person pastes in is (model-config.js), so it
// works exactly like their own. A person who has set up an LLM provider of
// their own keeps it; the included key waits beside it.
const KEY = /^sk-or-v1-[A-Za-z0-9]{20,200}$/;
const MODEL = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9._:-]+$/i;

// A model's name as people know it ("DeepSeek V4.1 Flash"), from OpenRouter's
// public list, else its ID's last part. Remembered, since it rarely changes.
const names = new Map();
async function modelName(id) {
  if (!MODEL.test(String(id || ""))) return null;
  if (names.has(id)) return names.get(id);
  let name = null;
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models/" + id.split("/").map(encodeURIComponent).join("/") + "/endpoints",
      { headers: { "HTTP-Referer": "https://closedhand.com", "X-Title": "Closedhand" }, signal: AbortSignal.timeout(8000), redirect: "error" });
    if (response.ok) name = String((await response.json())?.data?.name || "").replace(/^[^:]{1,40}:\s*/, "").trim().slice(0, 80) || null;
  } catch (_) { /* the fallback below */ }
  if (name) names.set(id, name);
  return name || id.split("/").pop();
}

async function settings() {
  const { supabase } = require("./db");
  const { getAdminUserId } = require("./admin");
  const { data, error } = await supabase.from("profiles").select("settings").eq("id", getAdminUserId()).single();
  if (error || !data) throw new Error("Could not load the settings.");
  return data.settings || {};
}

// Keep the key a claim brought, and set the models up with it in the
// background: the claim never waits for the model check.
async function receive(included) {
  const chat = included?.models?.chat;
  if (!KEY.test(String(included?.key || "")) || !MODEL.test(String(chat || ""))) return false;
  const background = MODEL.test(String(included.models.background || "")) ? included.models.background : chat;
  const { supabase } = require("./db");
  const { getAdminUserId } = require("./admin");
  await require("./settings-patch").patchSettings(supabase, getAdminUserId(), { set: {
    included_api_key: require("./model-policy").sealKey(included.key),
    included_ai: { models: { chat, background }, name: await modelName(chat), at: new Date().toISOString() },
  } });
  // A check that fails is recorded, so setup asks for an LLM provider instead
  // of waiting for one that will not come.
  use({ unlessOwn: true }).catch(async (e) => {
    console.error("[included ai] the models were not set up:", e.message);
    await require("./settings-patch").patchSettings(supabase, getAdminUserId(), { set: { included_ai: { models: { chat, background }, at: new Date().toISOString(), error: String(e.message || "check failed").slice(0, 200) } } }).catch(() => {});
  });
  return true;
}

// Use the included key for the models. unlessOwn: leave an LLM provider the
// person set up themselves in place.
async function use({ unlessOwn = false } = {}) {
  const before = await settings();
  const key = require("./model-policy").openKey(before.included_api_key);
  const models = before.included_ai?.models;
  if (!key || !models?.chat) throw new Error("This Closedhand has no Managed LLM to switch to.");
  const own = () => unlessOwn && (before.model_config ? !before.model_config.included : !!before.llm_provider);
  if (own()) return false;
  const modelConfig = require("./model-config");
  const config = await modelConfig.prepare({
    primary: { provider: "openrouter", apiKey: key }, model: models.chat,
    backgroundMode: models.background === models.chat ? "same" : "separate", backgroundModel: models.background,
    visionMode: "off",
  }, before);
  config.included = true;
  // Saved against the settings as they are now, unless the person set up an
  // LLM provider of their own while this was being checked.
  const now = await settings();
  if (unlessOwn && now.model_config && !now.model_config.included) return false;
  const { supabase } = require("./db");
  const { getAdminUserId } = require("./admin");
  const { diff, patchSettings } = require("./settings-patch");
  await patchSettings(supabase, getAdminUserId(), diff(now, modelConfig.withConfig(now, config)));
  return true;
}

// Closedhand picks the models and can change them: a few times a day this
// computer asks closedhand.com for the current pick and, when it changed,
// switches to it (if the Managed LLM is in use) and remembers its name.
async function refresh() {
  const before = await settings();
  if (!before.included_api_key) return false;
  const models = await require("./phone-registration").includedAiModels();
  if (!models || !MODEL.test(String(models.chat || ""))) return false;
  const background = MODEL.test(String(models.background || "")) ? models.background : models.chat;
  const had = before.included_ai?.models || {};
  if (had.chat === models.chat && had.background === background && before.included_ai?.name) return false;
  const { supabase } = require("./db");
  const { getAdminUserId } = require("./admin");
  await require("./settings-patch").patchSettings(supabase, getAdminUserId(), { set: {
    included_ai: { ...before.included_ai, models: { chat: models.chat, background }, name: await modelName(models.chat) },
  } });
  if (before.model_config?.included) await use();
  return true;
}

function start() {
  const run = () => refresh().catch(e => console.error("[included ai] could not check the current models:", e.message));
  setTimeout(run, 2 * 60 * 1000).unref?.();
  setInterval(run, 6 * 60 * 60 * 1000).unref?.();
}

module.exports = { receive, use, refresh, start, modelName };
