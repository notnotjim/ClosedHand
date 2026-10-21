// Setting up Closedhand Managed Models (included-ai.js) on this
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

// Keep the key a claim brought (or closedhand.com later handed over), and set
// the models up with it in the background: the claim never waits for the
// model check. keep: what is already known about it (its plan).
async function receive(included, { keep = {} } = {}) {
  const chat = included?.models?.chat;
  if (!KEY.test(String(included?.key || "")) || !MODEL.test(String(chat || ""))) return false;
  const background = MODEL.test(String(included.models.background || "")) ? included.models.background : chat;
  const { supabase } = require("./db");
  const { getAdminUserId } = require("./admin");
  await require("./settings-patch").patchSettings(supabase, getAdminUserId(), { set: {
    included_api_key: require("./model-policy").sealKey(included.key),
    included_ai: { ...keep, models: { chat, background }, name: await modelName(chat), at: new Date().toISOString() },
  } });
  // A check that fails is recorded, so setup asks for an LLM provider instead
  // of waiting for one that will not come.
  use({ unlessOwn: true }).catch(async (e) => {
    console.error("[included ai] the models were not set up:", e.message);
    await require("./settings-patch").patchSettings(supabase, getAdminUserId(), { set: { included_ai: { ...keep, models: { chat, background }, at: new Date().toISOString(), error: String(e.message || "check failed").slice(0, 200) } } }).catch(() => {});
  });
  return true;
}

// Use the included key for the models. unlessOwn: leave an LLM provider the
// person set up themselves in place.
async function use({ unlessOwn = false } = {}) {
  const before = await settings();
  const key = require("./model-policy").openKey(before.included_api_key);
  const models = before.included_ai?.models;
  if (!key || !models?.chat) throw new Error("This Closedhand has no Managed Models to switch to.");
  const own = () => unlessOwn && (before.model_config ? !before.model_config.included : !!before.llm_provider);
  if (own()) return false;
  const modelConfig = require("./model-config");
  const input = {
    primary: { provider: "openrouter", apiKey: key }, model: models.chat,
    backgroundMode: models.background === models.chat ? "same" : "separate", backgroundModel: models.background,
  };
  // Images too, when the chat LLM reads them (checked with a real image);
  // without images otherwise, so an image check never stops it being used.
  const config = await modelConfig.prepare({ ...input, visionMode: "same" }, before).catch(error => {
    if (!error.visionNeeded) throw error;
    return modelConfig.prepare({ ...input, visionMode: "off" }, before);
  });
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

// The plan closedhand.com gives this computer's account, as Closedhand keeps
// it: what it is, when it ends or renews, whether this month was carried on,
// and whether Closedhand's own email comes with it. An ended plan remembers
// what it was, so the words for it fit. Anything unknown keeps what was known.
const PLANS = ["first-month", "plus", "ended", "none"];
function cleanPlan(plan, previous) {
  if (!plan || !PLANS.includes(plan.name)) return previous || null;
  const date = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null;
  const out = { name: plan.name, email: plan.email === true };
  if (date(plan.ends_at)) out.ends_at = date(plan.ends_at);
  if (date(plan.renews_at)) out.renews_at = date(plan.renews_at);
  if (plan.extended === true) out.extended = true;
  if (plan.name === "ended") {
    const was = previous?.name === "ended" ? previous.was : previous?.name;
    if (was === "first-month" || was === "plus") out.was = was;
  }
  return out;
}

// Notices for this account not yet kept or sent: each { id, text }, said as
// written. The ones already sent (included-credit.js records them) are let go.
function keptNotices(given, before) {
  const sent = new Set(before.included_notices_sent || []);
  const kept = (before.included_notices || []).filter((n) => n?.id && !sent.has(n.id));
  const known = new Set(kept.map((n) => n.id));
  const fresh = (Array.isArray(given) ? given : [])
    .filter((n) => n && typeof n.id === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(n.id) && typeof n.text === "string" && n.text.trim() && !sent.has(n.id) && !known.has(n.id))
    .slice(0, 10).map((n) => ({ id: n.id, text: n.text.trim().slice(0, 1000) }));
  return { list: [...kept, ...fresh].slice(-20), changed: fresh.length > 0 || kept.length !== (before.included_notices || []).length };
}

// Every hour this computer asks closedhand.com about Closedhand Managed
// Models for it (phone-registration.js): the models Closedhand picks, switched
// to when they change (if they are in use) and named; its account's plan, for
// what Closedhand says and the dashboard shows; a key waiting for it, kept as a
// claim's is; and notices for its account, left for the bot to send
// (included-credit.js). True when anything changed.
async function refresh() {
  const answer = await require("./phone-registration").includedAiState();
  if (!answer) return false;
  const before = await settings();
  const had = before.included_ai || {};
  const plan = cleanPlan(answer.plan, had.plan);
  const pick = MODEL.test(String(answer.models?.chat || ""))
    ? { chat: answer.models.chat, background: MODEL.test(String(answer.models.background || "")) ? answer.models.background : answer.models.chat } : null;
  const { supabase } = require("./db");
  const { getAdminUserId } = require("./admin");
  const patch = (set) => require("./settings-patch").patchSettings(supabase, getAdminUserId(), { set });
  const notices = keptNotices(answer.notices, before);
  if (notices.changed) await patch({ included_notices: notices.list });
  // A key closedhand.com kept for this computer (a subscriber's account held
  // none): taken once, and set up exactly as a claim's.
  if (pick && KEY.test(String(answer.key || ""))) {
    await receive({ key: answer.key, models: pick }, { keep: plan ? { plan } : {} });
    return true;
  }
  const next = { ...had };
  if (plan && JSON.stringify(plan) !== JSON.stringify(had.plan)) next.plan = plan;
  let switchTo = false;
  if (before.included_api_key && pick && (had.models?.chat !== pick.chat || had.models?.background !== pick.background || !had.name)) {
    next.models = pick;
    next.name = await modelName(pick.chat);
    switchTo = !!before.model_config?.included;
  }
  const changed = JSON.stringify(next) !== JSON.stringify(had);
  if (changed) await patch({ included_ai: next });
  if (switchTo) await use();
  return changed || notices.changed;
}

function start() {
  const run = () => refresh().catch(e => console.error("[included ai] could not check with closedhand.com:", e.message));
  setTimeout(run, 2 * 60 * 1000).unref?.();
  setInterval(run, 60 * 60 * 1000).unref?.();
}

module.exports = { receive, use, refresh, start, modelName };
