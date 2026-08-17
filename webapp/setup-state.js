// webapp/setup-state.js — First-run setup state for the onboarding wizard.
//
// Reports what's configured and what the next unlock is, so the P3 setup UI is a
// pure rendering of this backend truth. Only booleans + service names leave here —
// never secret values. Sources: env (operator overrides) and the runtime config
// the wizard itself writes (settings.self_host_config), plus the admin's chat
// provider settings, which the dashboard has always owned.

const { supabase, isDbConfigured } = require("./db");
const { getAdminUserId } = require("./admin");

async function getSetupState() {
  const db = isDbConfigured();

  let settings = {};
  let connections = [];
  let profileCreatedAt = null;
  if (db) {
    try {
      const { data } = await supabase.from("profiles").select("settings, created_at").eq("id", getAdminUserId()).single();
      settings = (data && data.settings) || {};
      profileCreatedAt = (data && data.created_at) || null;
    } catch (_) { /* DB not reachable yet */ }
    try {
      const { data } = await supabase.from("connections").select("service").eq("user_id", getAdminUserId());
      connections = (data || []).map((r) => r.service).filter(Boolean);
    } catch (_) { /* treat as none */ }
  }
  const conf = settings.self_host_config || {};
  const envOr = (k) => (process.env[k] !== undefined && process.env[k] !== "" ? process.env[k] : conf[k]);

  // Chat is configured by any env provider key, a DeepInfra key saved in the
  // wizard, or a provider + key saved through the dashboard's own settings.
  const model = !!(
    process.env.DEEPINFRA_API_KEY ||
    process.env.XAI_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.CLAUDE_API_KEY ||
    process.env.GROQ_API_KEY ||
    process.env.OLLAMA_BASE_URL ||
    conf.DEEPINFRA_API_KEY ||
    (settings.llm_provider === "anthropic" && settings.anthropic_api_key) ||
    (settings.llm_provider === "openai" && settings.openai_api_key) ||
    (settings.llm_provider === "gemini" && settings.gemini_api_key) ||
    (settings.llm_provider === "custom" && settings.custom_base_url && settings.custom_model)
  );

  // Memory = a working embeddings config: a hosted embedder (wizard-derived or
  // DeepInfra defaults) or the local fallback embedder. memoryMode drives the
  // wizard's copy and the dashboard's hosted/local role display.
  const embedModel = envOr("EMBED_MODEL") || "";
  const memory = !!(embedModel || envOr("EMBED_API_KEY") || envOr("DEEPINFRA_API_KEY"));
  const memoryMode = !memory ? "off" : String(embedModel).startsWith("local:") ? "local" : "hosted";

  // Switching embedders is free exactly until the first vector is indexed;
  // after that it means a full re-index. The wizard offers the choice only
  // while it costs nothing.
  let memorySwitchFree = false;
  if (db && memoryMode === "local") {
    try {
      const { data: dv } = await supabase.from("data_vectors").select("id").limit(1);
      const { data: rc } = await supabase.from("rag_chunks").select("id").limit(1);
      memorySwitchFree = !(dv && dv.length) && !(rc && rc.length);
    } catch (_) { /* unknown => keep false, never promise a free switch wrongly */ }
  }

  const adminPassword = !!(process.env.ADMIN_PASSWORD || conf.DASHBOARD_PASSWORD_HASH);
  const telegram = !!envOr("TELEGRAM_BOT_TOKEN");
  const google = connections.some((s) => s === "google" || s.startsWith("google"));
  const googleCreds = !!(envOr("GOOGLE_CLIENT_ID") && envOr("GOOGLE_CLIENT_SECRET"));

  const waLinked = await (async () => {
    try {
      const { data } = await supabase.from("connections").select("config, metadata")
        .eq("user_id", getAdminUserId()).eq("service", "whatsapp_linked").single();
      if (!data) return { enabled: false, linked: false, hasQr: false };
      return { enabled: !!data.config?.enabled, linked: !!data.metadata?.linked, hasQr: !!data.metadata?.qr };
    } catch (_) { return { enabled: false, linked: false, hasQr: false }; }
  })();

  // Ordered by the onboarding spine; the first not-done is the next unlock.
  // Chat apps are one step: any connected chat surface satisfies it.
  const steps = [
    { key: "database", label: "Database", done: db, required: true },
    { key: "model", label: "Model provider", done: model, required: true },
    { key: "admin_password", label: "Admin password", done: adminPassword, required: false },
    { key: "google", label: "Google", done: google, required: false },
    { key: "chat", label: "Chat apps", done: telegram || waLinked.linked, required: false },
  ];
  const nextUnlock = steps.find((s) => !s.done) || null;

  return {
    // Minimally usable = a database + a model provider. Everything else is a
    // progressive unlock the user can add later or skip.
    ready: db && model,
    steps,
    connections,
    nextUnlock: nextUnlock ? nextUnlock.key : null,
    // Wizard form state (names and booleans only, never values):
    memory,
    memoryMode,
    memorySwitchFree,
    // Which roles run where, for the dashboard's hosted/local display, plus
    // local-model download progress for the wizard.
    roles: {
      memory: { mode: memoryMode, model: memoryMode === "hosted" ? (embedModel || "Qwen/Qwen3-Embedding-4B") : embedModel || null },
      rerank: String(envOr("RERANK_MODEL") || "").startsWith("local:") ? { mode: "local", model: envOr("RERANK_MODEL") }
        : (envOr("DEEPINFRA_API_KEY") ? { mode: "hosted", model: "Qwen/Qwen3-Reranker" } : { mode: "off", model: null }),
      vision: envOr("VISION_MODEL") ? { mode: "hosted", model: envOr("VISION_MODEL") }
        : (envOr("DEEPINFRA_API_KEY") ? { mode: "hosted", model: "Qwen/Qwen3-VL" } : { mode: "off", model: null }),
      light: { mode: "hosted", model: envOr("ENRICH_MODEL") || (envOr("DEEPINFRA_API_KEY") ? "deepseek-ai/DeepSeek-V4-Flash" : null) },
    },
    localModels: conf.LOCAL_MODELS_STATUS || null,
    chatProvider: conf.DEEPINFRA_API_KEY && (!settings.llm_provider || settings.llm_provider === "custom")
      ? "deepinfra"
      : settings.llm_provider || null,
    chatProviderLabel: conf.CHAT_PROVIDER_LABEL ||
      ({ anthropic: "Anthropic", openai: "OpenAI", gemini: "Google Gemini" })[settings.llm_provider] || null,
    botUsername: conf.TELEGRAM_BOT_USERNAME || null,
    // Identifies THIS install, so the page can keep per-install UI state
    // (skipped steps) instead of one browser's choices leaking across every
    // install that has ever answered on this address. NOT the admin user id:
    // that is a fixed sentinel, identical on every install, which is exactly
    // how a skip kept crossing installs. The admin profile's creation time is
    // written when this database gets its row and dies with the volume, so it
    // changes precisely when "a different install" is true.
    installId: profileCreatedAt,
    googleCreds,
    // The zero-project fallback tier: what is already connected, so the setup
    // page can show each block's real state instead of empty forms.
    fallback: {
      imap: connections.includes("imap"),
      ics: connections.includes("ics_calendar"),
      browserGoogle: !!settings.browser_google,
      job: settings.google_browser_job || null,
    },
    waLinked,
    sandboxVncPort: Number(process.env.SANDBOX_VNC_PORT || 6080),
    // The exact redirect URI the server will send in the Google OAuth flow
    // (mirrors server.js BASE_URL). The Google wizard renders this so the value
    // pasted into the console always matches what the server uses.
    googleRedirectUri: `${process.env.BASE_URL || "http://localhost:3000"}/auth/google/callback`,
  };
}

module.exports = { getSetupState };
