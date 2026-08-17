// index.js — Startup wiring for ClosedHand bot
// All logic lives in lib/ modules. This file creates clients, assigns them
// to the shared context, calls platform setup(), and starts the server.

require("dotenv").config();

// Fail fast in production if OAuth token encryption isn't configured.
// (dev/test still allowed to run without a key for local convenience.)
require("./crypto-tokens").assertReady();

// Prevent unhandled rejections from crashing the process
process.on("unhandledRejection", (reason, promise) => {
  console.error("[FATAL] Unhandled rejection:", reason?.message || reason);
});
const TelegramBot = require("node-telegram-bot-api");
const Anthropic = require("@anthropic-ai/sdk");
const { createLLMClient } = require("./lib/llm");
const { Client: DiscordClient, GatewayIntentBits, Partials } = require("discord.js");

// Shared context singleton — every module reads/writes state through this
const ctx = require("./lib/context");

// --- Environment ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const xaiApiKey = process.env.XAI_API_KEY;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const WA_PORT = process.env.PORT || 3000;

// Boot with nothing: the process starts even with no keys configured. Anything
// unconfigured is skipped here and activated later from first-run setup, rather
// than exiting. (In the hosted single-tenant build these are always present.)

// --- Create clients ---
if (xaiApiKey) {
  ctx.defaultLLMClient = createLLMClient({
    backend: "xai",
    apiKey: xaiApiKey,
  });
} else {
  console.log("[setup] No chat model provider configured. Chat stays disabled until one is set up.");
}

if (TELEGRAM_TOKEN) {
  ctx.bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
} else {
  console.log("[setup] No Telegram token yet. Watching runtime config; the wizard's save starts it live.");
  // The wizard saves the token into runtime config; start polling the moment it
  // appears, no restart. Token *changes* still need a restart (edge case).
  const tgWatcher = setInterval(async () => {
    try {
      if (ctx.bot) { clearInterval(tgWatcher); return; }
      const token = await require("./lib/config").getConf("TELEGRAM_BOT_TOKEN");
      if (!token) return;
      clearInterval(tgWatcher);
      ctx.bot = new TelegramBot(token, { polling: true });
      require("./lib/platforms/telegram").setup();
      console.log("[setup] Telegram token saved in the wizard — polling started.");
    } catch (e) {
      console.error("[setup] Telegram config watcher:", e.message);
    }
  }, 5000);
  if (tgWatcher.unref) tgWatcher.unref();
}

// Discord (optional)
if (DISCORD_BOT_TOKEN) {
  ctx.discordClient = new DiscordClient({
    intents: [GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel],
  });
  ctx.discordClient.login(DISCORD_BOT_TOKEN).catch(err => {
    console.error("Discord login failed:", err.message);
  });
  ctx.discordClient.once("ready", () => console.log(`Discord bot ready: ${ctx.discordClient.user.tag}`));
  ctx.discordClient.on("error", (err) => console.error("Discord client error:", err.message));
  ctx.discordClient.on("warn", (msg) => console.warn("Discord warning:", msg));
}

// Express (for WhatsApp + Slack webhooks)
ctx.expressApp = require("express")();
ctx.expressApp.use(require("express").json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// Gateway proxy — sandbox containers call back through this
ctx.expressApp.use("/gateway", require("./lib/gateway"));

// --- Infrastructure modules ---
const { connectAllMCPServers } = require("./lib/mcp");
const { loadAllSkills } = require("./lib/skills");
const { registerAllSchedules } = require("./lib/scheduling");
const { startFlightTracking } = require("./lib/flights-scheduler");
const { registerAutomationCrons } = require("./lib/automations");
const { startPulse } = require("./lib/pulse");
const { startDataSync } = require("./lib/services/data-sync");

// --- Platform handlers ---
const telegramHandler = require("./lib/platforms/telegram");
const whatsappHandler = require("./lib/platforms/whatsapp");
const slackHandler = require("./lib/platforms/slack-handler");
const discordHandler = require("./lib/platforms/discord");
const lineHandler = require("./lib/platforms/line");
const webHandler = require("./lib/platforms/web");

// Wire up all platform message handlers. Each platform activates only when its
// own credentials are present; telegram.setup() registers on ctx.bot, so it is
// gated on the bot existing (the others self-guard on their own tokens).
if (ctx.bot) telegramHandler.setup();
whatsappHandler.setup();
// Linked-device WhatsApp (self-host tier): only ever activates when the setup
// page has written its connection row, so cloud never starts a socket.
require("./lib/platforms/whatsapp-linked").setup();
// Watches for a requested "collect my Google credentials from the browser"
// run; idle until the setup page asks for one.
require("./lib/setup-automation").setup();
slackHandler.setup();
discordHandler.setup();
lineHandler.setup();
webHandler.setup();

// Health check
ctx._lastMessageTime = Date.now();
ctx.expressApp.get("/health", (req, res) => {
  res.json({ status: "ok", platform: "closedhand-bot", uptime: process.uptime() });
});

// Keepalive: prevent Railway container sleep, warm DB connection
setInterval(async () => {
  try {
    // 1. Self-ping to prevent container sleep
    fetch(`http://localhost:${WA_PORT}/health`).catch(() => {});

    // 2. Warm Supabase connection if idle > 5 minutes
    if (Date.now() - (ctx._lastMessageTime || 0) > 300000) {
      const { supabase } = require("./user-store");
      supabase.from("profiles").select("id").limit(1).then(() => {}).catch(() => {});
    }
  } catch (_) {}
}, 240000); // Every 4 minutes

// --- Agent infrastructure ---
const { resumeAgents } = require("./lib/agents");

// --- Start ---
async function main() {
  // Single-tenant: ensure the one admin exists before pulse/data-sync enumerate users.
  await require("./lib/admin").ensureAdmin();
  await connectAllMCPServers();
  loadAllSkills();
  registerAllSchedules();
  startFlightTracking();
  resumeAgents();
  await registerAutomationCrons();
  await startPulse();
  // Warm the runtime-config cache before anything reads it synchronously.
  // getConfCached returns undefined on a cold cache, so an unwarmed read of
  // EMBED_MODEL fell through to the hosted default with no key, and the
  // indexer quietly decided embeddings were not configured: a self-host
  // install synced mail and calendar into the cache and never indexed a
  // single row, while the wizard reported memory as on.
  try { await require("./lib/config").getConf("EMBED_MODEL"); } catch (_) {}
  startDataSync();
  require("./lib/sandbox").startSandboxJanitor();
  require("./lib/local-models").preloadIfConfigured();

  // Subscribe app to WABA for receiving real WhatsApp messages
  await whatsappHandler.subscribeWhatsAppWebhook();

  // Start Express server for webhooks
  const server = ctx.expressApp.listen(WA_PORT, () => {
    console.log(`🌐 Webhook server listening on port ${WA_PORT}`);
  });

  // Attach Bridge WebSocket server
  const { setupBridgeServer } = require("./lib/bridge-server");
  setupBridgeServer(server);

  // Attach Web Chat WebSocket server (direct browser-to-bot)
  const { setupWebChatServer } = require("./lib/web-chat-ws");
  setupWebChatServer(server);

  console.log("☁️  ClosedHand cloud bot is running!");
  console.log("User data: Supabase");
  console.log("Waiting for Telegram + WhatsApp messages...");


  // Resume user messages that a redeploy interrupted mid-processing.
  // Delayed so platform connections (Telegram bot, WhatsApp) are up first.
  setTimeout(() => {
    require("./lib/resume").resumeInterruptedMessages()
      .catch(e => console.error("[Resume] startup pass failed:", e.message));
  }, 12000);

  // Clean up stale automation runs from before this deploy
  try {
    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    ctx.supabase
      .from("automation_runs")
      .update({ status: "failed", error: "Stale after redeploy", completed_at: new Date().toISOString() })
      .in("status", ["running", "pending"])
      .lt("started_at", cutoff)
      .then(({ data }) => {
        if (data && data.length > 0) console.log(`[Startup] Cleaned up ${data.length} stale automation runs`);
      });
  } catch (e) { /* non-critical */ }
}

main();

