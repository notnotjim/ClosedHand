// ============================================================
// ClosedHand Web App
// Express server — OAuth framework, onboarding, dashboard
// ============================================================

require("dotenv").config();

// Fail fast in production if OAuth token encryption isn't configured.
// (dev/test still allowed to run without a key for local convenience.)
require("./crypto-tokens").assertReady();

const express = require("express");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const path = require("path");
const multer = require("multer");
const { supabase } = require("./db");

// Note: startAgent lives in the bot process (lib/agents.js), not importable from webapp.
// Dashboard agent creation inserts a pending task; the bot picks it up.

const { scanMcpTools, scanSkillContent } = require("./security-scan");

const app = express();
app.use("/novnc", express.static(path.join(__dirname, "public", "novnc")));

// Local-storage public route: serves ONLY the `logos` bucket (rendered in the
// browser via getPublicUrl). Attachments stay private — fetched via the authed
// download route, never here. No-op on a Supabase deployment (those logo URLs
// point at Supabase's CDN, not here). safeJoin blocks path traversal.
app.get("/storage/logos/*", (req, res) => {
  try {
    const { safeJoin } = require("./storage-driver-local");
    const dir = path.resolve(process.env.STORAGE_DIR || "./data/storage");
    res.sendFile(safeJoin(dir, "logos", req.params[0] || ""), (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  } catch {
    res.status(400).end();
  }
});
const PORT = process.env.PORT || 3000;

const COOKIE_SECRET = process.env.COOKIE_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.COOKIE_SECRET) console.warn("[setup] COOKIE_SECRET is not set — dashboard sessions won't survive a restart. Set it in .env.");

// Single-tenant admin identity. Kick the bootstrap at module load so the cache is
// warm before requests; the listen callback awaits it too.
const { ensureAdmin, getAdminUserId } = require("./admin");
ensureAdmin().catch((e) => console.error("[admin] bootstrap failed:", e.message));
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const LINE_LOGIN_CHANNEL_ID = process.env.LINE_LOGIN_CHANNEL_ID;

// ============================================================
// SERVICE REGISTRY — all OAuth services defined here
// Adding a new service = adding a config block below.
//
// Each service needs:
//   clientId / clientSecret: env var references
//   authUrl: where to redirect user for consent
//   tokenUrl: where to exchange code for tokens
//   scopes: what permissions to request
//   profileUrl: (optional) to fetch user info after auth
//
// Google is special: it doubles as signup/login.
// All others just store tokens in the connections table.
// ============================================================

const SERVICES = {
  google: {
    name: "Google",
    description: "Gmail, Calendar, Drive, Sheets",
    logoUrl: "/logos/google.svg",
    isSignup: true,
    // Live getters: the wizard can save these into runtime config after boot,
    // and the OAuth routes pick them up without a restart. Env still wins.
    get clientId() { return process.env.GOOGLE_CLIENT_ID || require("./config").getConfCached("GOOGLE_CLIENT_ID"); },
    get clientSecret() { return process.env.GOOGLE_CLIENT_SECRET || require("./config").getConfCached("GOOGLE_CLIENT_SECRET"); },
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    profileUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
    scopes: [
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/gmail.readonly",
      // compose covers creating, updating and deleting drafts AND sending, so it
      // replaces gmail.send rather than joining it: same scope count, and
      // ClosedHand can revise a draft in place instead of driving the user's
      // browser because it had no API path to one.
      "https://www.googleapis.com/auth/gmail.compose",
      // Events only, deliberately. The full "auth/calendar" scope asks the user
      // to agree to "permanently delete all the calendars you can access",
      // which is both far more than ClosedHand does and the most alarming line
      // Google produces for Calendar. Adding calendar.readonly alongside would
      // buy the calendar LIST, and the only thing that lists beyond each
      // account's primary is holiday calendars, which are noise. One scope, the
      // mildest wording, and nothing the product actually needs is lost.
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive.file",
    ],
    extraAuthParams: { access_type: "offline", prompt: "consent select_account" },
    provides: ["Gmail", "Google Calendar", "Google Drive"],
  },

  microsoft: {
    name: "Microsoft 365",
    description: "Outlook email, Calendar, OneDrive",
    logoUrl: "/logos/microsoft.svg",
    isSignup: true,
    clientId: process.env.MICROSOFT_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    profileUrl: "https://graph.microsoft.com/v1.0/me",
    scopes: [
      "openid",
      "profile",
      "email",
      "offline_access",
      "Mail.ReadWrite",
      "Mail.Send",
      "Calendars.ReadWrite",
      "Files.Read.All",
    ],
    extraAuthParams: { response_mode: "query" },
    provides: ["Outlook", "Outlook Calendar", "OneDrive"],
  },

  notion: {
    name: "Notion",
    description: "Pages, databases, project management",
    logoUrl: "/logos/notion.svg",
    clientId: process.env.NOTION_CLIENT_ID,
    clientSecret: process.env.NOTION_CLIENT_SECRET,
    authUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    scopes: [],
    authParams: { owner: "user" },
    tokenAuthMethod: "basic",
    provides: ["Notion"],
  },

  atlassian: {
    name: "Atlassian",
    description: "Jira, Trello, Confluence",
    logoUrl: "/logos/atlassian.svg",
    clientId: process.env.ATLASSIAN_CLIENT_ID,
    clientSecret: process.env.ATLASSIAN_CLIENT_SECRET,
    authUrl: "https://auth.atlassian.com/authorize",
    tokenUrl: "https://auth.atlassian.com/oauth/token",
    scopes: [
      "read:jira-work",
      "write:jira-work",
      "read:jira-user",
      "read:board-scope:jira-software",
      "read:trello",
      "write:trello",
      "read:confluence-content.all",
      "write:confluence-content",
      "offline_access",
    ],
    extraAuthParams: { audience: "api.atlassian.com", prompt: "consent" },
    provides: ["Jira", "Trello", "Confluence"],
  },

  spotify: {
    name: "Spotify",
    description: "Now playing, playlists, playback control",
    logoUrl: "/logos/spotify.svg",
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
    authUrl: "https://accounts.spotify.com/authorize",
    tokenUrl: "https://accounts.spotify.com/api/token",
    scopes: [
      "user-read-playback-state",
      "user-modify-playback-state",
      "user-read-currently-playing",
      "user-read-recently-played",
      "playlist-read-private",
      "playlist-modify-public",
      "playlist-modify-private",
    ],
    provides: ["Spotify"],
  },

  stripe: {
    name: "Stripe",
    description: "Payments, invoices, revenue data",
    logoUrl: "/logos/stripe.svg",
    clientId: process.env.STRIPE_CLIENT_ID,
    clientSecret: process.env.STRIPE_CLIENT_SECRET,
    authUrl: "https://connect.stripe.com/oauth/authorize",
    tokenUrl: "https://connect.stripe.com/oauth/token",
    scopes: ["read_write"],
    provides: ["Stripe"],
  },

  shopify: {
    name: "Shopify",
    description: "Orders, products, customers, analytics",
    logoUrl: "/logos/shopify.svg",
    clientId: process.env.SHOPIFY_CLIENT_ID,
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET,
    authUrl: null, // Built dynamically from store domain
    tokenUrl: null,
    scopes: [
      "read_products",
      "write_products",
      "read_orders",
      "write_orders",
      "read_customers",
      "write_customers",
      "read_inventory",
      "write_inventory",
      "read_analytics",
      "read_fulfillments",
      "write_fulfillments",
      "read_shipping",
      "write_shipping",
      "read_reports",
      "read_draft_orders",
      "write_draft_orders",
      "read_price_rules",
      "write_price_rules",
      "read_all_orders",
      "read_shopify_payments_payouts",
    ],
    scopeJoin: ",",
    needsStoreDomain: true,
    provides: ["Shopify"],
  },

  slack: {
    name: "Slack",
    clientId: process.env.SLACK_CLIENT_ID,
    clientSecret: process.env.SLACK_CLIENT_SECRET,
    authUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    scopes: [
      "channels:history",
      "channels:read",
      "chat:write",
      "groups:history",
      "groups:read",
      "im:history",
      "im:read",
      "im:write",
      "mpim:history",
      "mpim:read",
      "search:read",
      "users:read",
      "users:read.email",
    ],
    scopeParam: "scope",
    scopeJoin: ",",
    profileUrl: null,
    isSignup: false,
    tokenField: "access_token",
    isChatPlatform: true,
  },

  line: {
    name: "LINE",
    description: "Popular in Japan, Thailand, Taiwan",
    logoUrl: "/logos/line.svg",
    isChatPlatform: true,
    provides: ["LINE"],
  },

  asana: {
    name: "Asana",
    description: "Projects, tasks, team workflows",
    logoUrl: "/logos/asana.svg",
    clientId: process.env.ASANA_CLIENT_ID,
    clientSecret: process.env.ASANA_CLIENT_SECRET,
    authUrl: "https://app.asana.com/-/oauth_authorize",
    tokenUrl: "https://app.asana.com/-/oauth_token",
    profileUrl: "https://app.asana.com/api/1.0/users/me",
    scopes: ["default"],
    provides: ["Asana"],
  },

  zoom: {
    name: "Zoom",
    description: "Video meetings, scheduling, recordings",
    logoUrl: "/logos/zoom.svg",
    clientId: process.env.ZOOM_CLIENT_ID,
    clientSecret: process.env.ZOOM_CLIENT_SECRET,
    authUrl: "https://zoom.us/oauth/authorize",
    tokenUrl: "https://zoom.us/oauth/token",
    profileUrl: "https://api.zoom.us/v2/users/me",
    scopes: ["meeting:read", "meeting:write", "user:read", "recording:read"],
    tokenAuthMethod: "basic",
    provides: ["Zoom"],
  },

  dropbox: {
    name: "Dropbox",
    description: "File storage, sharing, sync",
    logoUrl: "/logos/dropbox.svg",
    clientId: process.env.DROPBOX_CLIENT_ID,
    clientSecret: process.env.DROPBOX_CLIENT_SECRET,
    authUrl: "https://www.dropbox.com/oauth2/authorize",
    tokenUrl: "https://api.dropboxapi.com/oauth2/token",
    profileUrl: "https://api.dropboxapi.com/2/users/get_current_account",
    scopes: [],
    extraAuthParams: { token_access_type: "offline" },
    provides: ["Dropbox"],
  },


  meta_ads: {
    name: "Meta Ads",
    description: "Facebook & Instagram ad campaigns",
    logoUrl: "/logos/meta.svg",
    clientId: process.env.META_CLIENT_ID,
    clientSecret: process.env.META_CLIENT_SECRET,
    authUrl: "https://www.facebook.com/v21.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v21.0/oauth/access_token",
    profileUrl: "https://graph.facebook.com/me",
    scopes: [
      "ads_management",
      "ads_read",
      "business_management",
    ],
    extraAuthParams: { auth_type: "rerequest" },
    provides: ["Meta Ads"],
  },


  mailchimp: {
    name: "Mailchimp",
    description: "Email campaigns, audiences, automations",
    logoUrl: "/logos/mailchimp.svg",
    clientId: process.env.MAILCHIMP_CLIENT_ID,
    clientSecret: process.env.MAILCHIMP_CLIENT_SECRET,
    authUrl: "https://login.mailchimp.com/oauth2/authorize",
    tokenUrl: "https://login.mailchimp.com/oauth2/token",
    profileUrl: "https://login.mailchimp.com/oauth2/metadata",
    scopes: [],
    provides: ["Mailchimp"],
  },

  hubspot: {
    name: "HubSpot",
    description: "CRM, contacts, deals, marketing",
    logoUrl: "/logos/hubspot.svg",
    clientId: process.env.HUBSPOT_CLIENT_ID,
    clientSecret: process.env.HUBSPOT_CLIENT_SECRET,
    authUrl: "https://app.hubspot.com/oauth/authorize",
    tokenUrl: "https://api.hubapi.com/oauth/v1/token",
    profileUrl: null,
    scopes: [
      "crm.objects.contacts.read",
      "crm.objects.contacts.write",
      "crm.objects.deals.read",
      "crm.objects.deals.write",
      "crm.objects.companies.read",
      "crm.objects.companies.write",
      "tickets",
    ],
    provides: ["HubSpot"],
  },

  salesforce: {
    name: "Salesforce",
    description: "CRM, leads, opportunities",
    logoUrl: "/logos/salesforce.svg",
    clientId: process.env.SALESFORCE_CLIENT_ID,
    clientSecret: process.env.SALESFORCE_CLIENT_SECRET,
    authUrl: "https://login.salesforce.com/services/oauth2/authorize",
    tokenUrl: "https://login.salesforce.com/services/oauth2/token",
    profileUrl: null,
    scopes: ["full", "refresh_token", "offline_access"],
    usePKCE: true,
    provides: ["Salesforce"],
  },

  github: {
    name: "GitHub",
    description: "Repos, issues, pull requests",
    logoUrl: "/logos/github.svg",
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    authUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    profileUrl: "https://api.github.com/user",
    scopes: ["repo", "read:user", "user:email"],
    provides: ["GitHub"],
  },

  gitlab: {
    name: "GitLab",
    description: "Repos, CI/CD, issues",
    logoUrl: "/logos/gitlab.svg",
    clientId: process.env.GITLAB_CLIENT_ID,
    clientSecret: process.env.GITLAB_CLIENT_SECRET,
    authUrl: "https://gitlab.com/oauth/authorize",
    tokenUrl: "https://gitlab.com/oauth/token",
    profileUrl: "https://gitlab.com/api/v4/user",
    scopes: ["api", "read_user", "read_api", "read_repository"],
    provides: ["GitLab"],
  },


};

// Which services are available (have credentials configured)
function getAvailableServices() {
  const available = {};
  for (const [key, svc] of Object.entries(SERVICES)) {
    available[key] = {
      name: svc.name,
      description: svc.description,
      logoUrl: svc.logoUrl || "",
      provides: svc.provides,
      configured: !!(svc.clientId && svc.clientSecret) || (svc.needsStoreDomain === true),
      oauthReady: !!(svc.clientId && svc.clientSecret),
      isSignup: svc.isSignup || false,
      needsStoreDomain: svc.needsStoreDomain || false,
      isChatPlatform: svc.isChatPlatform || false,
    };
  }
  return available;
}

// Supported chat platforms
const SUPPORTED_PLATFORMS = {
  telegram: { name: "Telegram", botName: "@ClosedHand_Bot", available: true },
  whatsapp: { name: "WhatsApp", botName: "ClosedHand", available: true },
  discord: { name: "Discord", botName: "ClosedHand", available: true },
  slack: { name: "Slack", botName: "ClosedHand", available: true },
  line: { name: "LINE", botName: "ClosedHand", available: true },
};

// Middleware
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "50mb" }));

// Public health check (container healthcheck hits this; must bypass the gate below).
app.get("/health", (req, res) => res.json({ status: "ok", service: "closedhand-webapp" }));

// First-run setup state (booleans + service names only, no secrets) — drives the
// onboarding wizard. Kept public so it's reachable before an admin password exists.
app.get("/api/setup/status", async (req, res) => {
  try {
    res.json(await require("./setup-state").getSetupState());
  } catch (e) {
    res.status(500).json({ error: "setup status failed" });
  }
});

// The setup wizard renders nothing beyond that endpoint's booleans, so it stays
// public too; everything it links to (dashboard, connections) sits behind the gate.
app.get("/setup", (req, res) => {
  res.set("Cache-Control", "no-cache, must-revalidate");
  res.sendFile(path.join(__dirname, "views", "setup.html"));
});

app.get("/setup/google", (req, res) => {
  res.set("Cache-Control", "no-cache, must-revalidate");
  res.sendFile(path.join(__dirname, "views", "setup-google.html"));
});

// --- Dashboard access: a password chosen in the wizard, a session cookie, ---
// --- and a login page with no username (there is only one person here). ----
// The wizard and its APIs stay reachable without a password because the wizard
// is where the password gets set; once one exists, its write APIs and every
// route registered after the gate below require the session. ADMIN_PASSWORD in
// env still works and wins over the stored hash.
const { getConf: getRuntimeConf, setConf: setRuntimeConf } = require("./config");

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(pw, salt, 32).toString("hex")}`;
}
function verifyPasswordHash(pw, stored) {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(pw, salt, 32).toString("hex");
  return check.length === hash.length && crypto.timingSafeEqual(Buffer.from(check, "hex"), Buffer.from(hash, "hex"));
}
async function passwordConfigured() {
  if (process.env.ADMIN_PASSWORD) return true;
  return !!(await getRuntimeConf("DASHBOARD_PASSWORD_HASH"));
}
async function checkDashboardPassword(pw) {
  if (process.env.ADMIN_PASSWORD) {
    const a = Buffer.from(pw || "");
    const b = Buffer.from(process.env.ADMIN_PASSWORD);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  const stored = await getRuntimeConf("DASHBOARD_PASSWORD_HASH");
  return stored ? verifyPasswordHash(pw || "", stored) : false;
}

const ADMIN_SESSION_VALUE = "admin-session";
function readCookie(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}
function setAdminSessionCookie(res) {
  res.append("Set-Cookie", `ch_admin=${encodeURIComponent(signUserId(ADMIN_SESSION_VALUE))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
}
function hasAdminSession(req) {
  return verifySignedCookie(readCookie(req, "ch_admin")) === ADMIN_SESSION_VALUE;
}

// Wizard write APIs: open until a password exists (first run on localhost),
// session-only after. Returns false after sending the 401 itself.
async function requireSetupAccess(req, res) {
  if (!(await passwordConfigured())) return true;
  if (hasAdminSession(req)) return true;
  res.status(401).json({ error: "Login required" });
  return false;
}

app.get("/login", (req, res) => {
  res.set("Cache-Control", "no-cache, must-revalidate");
  res.sendFile(path.join(__dirname, "views", "login.html"));
});

app.post("/api/login", async (req, res) => {
  try {
    if (await checkDashboardPassword((req.body || {}).password)) {
      setAdminSessionCookie(res);
      return res.json({ success: true });
    }
    await new Promise((r) => setTimeout(r, 400)); // slow brute force a little
    return res.status(403).json({ error: "Wrong password" });
  } catch (e) {
    return res.status(500).json({ error: "login failed" });
  }
});

// --- Wizard write APIs (the wizard fills forms; nobody edits files) ---------

// Choose (or change) the dashboard password. Setting it also logs you in.
// A write whose success is about to be reported to the user. The supabase
// client resolves with { error } rather than throwing, so an unchecked write
// lets the wizard say "connected" over a database that never changed: a
// launch-day user gets a dead bot and no reason for it. Throwing routes into
// the endpoint's existing catch, which already answers with a 500 the page
// knows how to show.
async function mustWrite(what, query) {
  const { error } = await query;
  if (error) throw new Error(`${what} (${error.message})`);
}

app.post("/api/setup/password", async (req, res) => {
  try {
    if (!(await requireSetupAccess(req, res))) return;
    const pw = String((req.body || {}).password || "");
    if (pw.length < 8) return res.status(400).json({ error: "Use at least 8 characters" });
    if (process.env.ADMIN_PASSWORD) return res.status(400).json({ error: "The password is fixed by the ADMIN_PASSWORD environment variable on this install" });
    await setRuntimeConf({ DASHBOARD_PASSWORD_HASH: hashPassword(pw) });
    setAdminSessionCookie(res);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "could not save the password" });
  }
});

// Whose key is this? The same models call that verifies a key also answers
// which provider it belongs to: probe every keyed provider in parallel and the
// one that accepts it wins. A prefix hint (sk-ant-, gsk_, xai-, AIza) only
// orders the result when more than one accepts, never substitutes for the probe.
app.post("/api/setup/detect", async (req, res) => {
  const caps = require("./provider-capabilities");
  try {
    if (!(await requireSetupAccess(req, res))) return;
    const apiKey = String((req.body || {}).apiKey || "").trim();
    if (apiKey.length < 8) return res.json({ detected: false });
    const candidates = ["anthropic", "openai", "groq", "xai", "gemini", "deepinfra"];
    const hint =
      apiKey.startsWith("sk-ant-") ? "anthropic" :
      apiKey.startsWith("gsk_") ? "groq" :
      apiKey.startsWith("xai-") ? "xai" :
      apiKey.startsWith("AIza") ? "gemini" :
      null;

    // Per-provider probe: the models list (capabilities + verification), then
    // the key-truth check (dedicated endpoint or one-token chat). Statuses are
    // kept so a failure can be REPORTED, not left a mystery.
    async function probeProvider(prov) {
      let modelsStatus = null;
      try {
        const ids = await caps.listModels(prov, { apiKey });
        return { prov, ids, ok: true };
      } catch (e2) { modelsStatus = e2.status ?? 0; }
      const v = await caps.verifyChatKey(prov, { apiKey });
      return { prov, ids: [], ok: v.valid, modelsStatus, keyStatus: v.status };
    }

    // Prefix-hinted keys check their provider first and alone: the common case
    // answers in well under a second instead of fanning out to six providers.
    let winner = null;
    let hintResult = null;
    if (hint) {
      hintResult = await probeProvider(hint);
      if (hintResult.ok) winner = hintResult;
    }
    if (!winner) {
      const rest = candidates.filter((c) => c !== hint);
      const probes = await Promise.allSettled(rest.map(probeProvider));
      const hits = probes.filter((r) => r.status === "fulfilled").map((r) => r.value).filter((h) => h.ok);
      winner = hits[0] || null;
    }
    if (!winner) {
      // Say what the hinted provider actually answered; that is the difference
      // between a debuggable state and "it just doesn't work".
      return res.json({
        detected: false,
        hint: hint || null,
        hintLabel: hint ? caps.PROVIDERS[hint].label : null,
        hintStatuses: hintResult ? { models: hintResult.modelsStatus, key: hintResult.keyStatus } : null,
      });
    }
    const p = caps.PROVIDERS[winner.prov];
    res.json({
      detected: true,
      provider: winner.prov,
      label: p.label,
      complete: p.complete === true,
      noEmbeddings: p.noEmbeddings || null,
      chatModel: caps.pickModel(p.chat, winner.ids) || null,
    });
  } catch (e) {
    res.status(500).json({ error: "detection failed" });
  }
});

// One endpoint for every provider: verify the key against the provider's LIVE
// model list, save the chat config, and for complete providers derive the
// memory machinery (embeddings, enrichment, vision, internal chores) from the
// same key. Chat-only providers get an honest by-name answer instead.
app.post("/api/setup/provider", async (req, res) => {
  const caps = require("./provider-capabilities");
  try {
    if (!(await requireSetupAccess(req, res))) return;
    const provider = String((req.body || {}).provider || "").trim();
    const apiKey = String((req.body || {}).apiKey || "").trim();
    const chatModelInput = String((req.body || {}).chatModel || "").trim();
    let base = String((req.body || {}).baseUrl || "").trim().replace(/\/+$/, "");
    const p = caps.PROVIDERS[provider];
    if (!p) return res.status(400).json({ error: "Unknown provider" });
    if (p.auth !== "none" && !apiKey) return res.status(400).json({ error: `Paste your ${p.label} API key` });
    if (provider === "ollama") {
      if (!base) return res.status(400).json({ error: "Enter the Ollama address, usually http://localhost:11434 (from Docker: http://host.docker.internal:11434)" });
      if (!/\/v\d+$/.test(base)) base = `${base}/v1`;
    } else {
      base = p.base;
    }

    // Live model list doubles as key verification; when it refuses, the chat
    // endpoint gets the final say, because keys can be scoped to chat only.
    let liveIds = [];
    try {
      liveIds = await caps.listModels(provider, { apiKey, base });
    } catch (e) {
      if (provider === "ollama") return res.status(400).json({ error: `Could not reach Ollama at ${base}. Is it running?` });
      // 400 counts as rejection too: a bodyless GET can only be malformed in
      // its credential (x.ai answers 400, not 401, for a bad key).
      if (e.status === 400 || e.status === 401 || e.status === 403) {
        const chatOk = await caps.verifyChatKey(provider, { apiKey, base });
        if (!chatOk.valid) return res.status(400).json({ error: `${p.label} rejected that key (${chatOk.status || e.status})` });
        // Chat works; the models list is just closed to this key.
      }
      // Static fallbacks cover model picks when the list is unavailable.
      liveIds = [];
    }

    // Chat config. Native backends keep their maintained defaults (MODEL_MAP);
    // OpenAI-compatible ones need a concrete model name saved.
    const { data: profile } = await supabase.from("profiles").select("settings").eq("id", getAdminUserId()).single();
    const settings = (profile && profile.settings) || {};
    let chatModel = null;
    if (p.chatBackend === "custom") {
      chatModel = chatModelInput || caps.pickModel(p.chat, liveIds);
      if (!chatModel) return res.status(400).json({ error: `Couldn't find a chat model on ${p.label}. Name one in the model field.` });
      settings.llm_provider = "custom";
      settings.custom_base_url = base;
      settings.custom_model = chatModel;
      if (apiKey) settings.custom_api_key = apiKey; else delete settings.custom_api_key;
    } else {
      settings.llm_provider = provider;
      settings[`${provider}_api_key`] = apiKey;
    }
    await mustWrite("could not save that", supabase.from("profiles").update({ settings, updated_at: new Date().toISOString() }).eq("id", getAdminUserId()));

    // Machinery for complete providers, from the same key. The embedder is
    // locked once chosen: vectors indexed with one model are unreadable by
    // another, so an existing EMBED_MODEL is never silently replaced.
    const confPatch = { CHAT_PROVIDER_LABEL: p.label };
    let embedModel = caps.pickModel(p.embed, liveIds);
    const visionModel = caps.pickModel(p.vision, liveIds);
    const enrichModel = caps.pickModel(p.enrich, liveIds);
    let memoryOn = false;
    let embedLockedNote = null;
    if (embedModel) {
      const existingEmbed = process.env.EMBED_MODEL || (await getRuntimeConf("EMBED_MODEL"));
      if (existingEmbed && existingEmbed !== embedModel) {
        memoryOn = true; // memory already runs on the locked embedder
        embedLockedNote = `memory stays on ${existingEmbed} (your index is built with it)`;
        embedModel = existingEmbed;
      } else {
        confPatch.EMBED_API_URL = `${base}/embeddings`;
        confPatch.EMBED_MODEL = embedModel;
        confPatch.EMBED_API_KEY = apiKey || null;
        memoryOn = true;
      }
      if (provider === "deepinfra") confPatch.DEEPINFRA_API_KEY = apiKey;
    } else {
      // This provider brings no embeddings, but memory that's ALREADY wired
      // (a locked embedder or a DeepInfra key) keeps running; switching chat
      // providers never turns memory off.
      const existingEmbed = process.env.EMBED_MODEL || (await getRuntimeConf("EMBED_MODEL")) ||
        process.env.DEEPINFRA_API_KEY || (await getRuntimeConf("DEEPINFRA_API_KEY"));
      if (existingEmbed) {
        memoryOn = true;
        embedLockedNote = "memory keeps its existing setup";
      } else {
        // Memory is never a dead end, whatever the provider: the built-in
        // embedder (~300MB) downloads at first sync, with a local reranker
        // (~40MB) beside it. Locked like any other embedder.
        confPatch.EMBED_MODEL = "local:embeddinggemma-300m";
        confPatch.RERANK_MODEL = "local:jina-reranker-v1-turbo";
        memoryOn = true;
        embedLockedNote = "memory runs locally (a ~300MB model downloads at first sync)";
      }
    }
    if (enrichModel) {
      confPatch.ENRICH_API_URL = `${base}/chat/completions`;
      confPatch.ENRICH_MODEL = enrichModel;
      confPatch.ENRICH_FALLBACK_MODEL = enrichModel;
      confPatch.ENRICH_API_KEY = apiKey || null;
      confPatch.INTERNAL_LLM_URL = base;
      confPatch.INTERNAL_LLM_MODEL = enrichModel;
      confPatch.INTERNAL_LLM_API_KEY = apiKey || null;
    }
    if (visionModel) confPatch.VISION_MODEL = visionModel;
    await setRuntimeConf(confPatch);

    const chatShown = chatModel || p.chatDisplay || null;
    const bits = [`Using ${chatShown || "the provider's default"} for chat`];
    if (memoryOn) bits.push(embedLockedNote || `memory on ${embedModel}`);
    if (visionModel) bits.push("vision ready");
    let note = null;
    if (!memoryOn) note = `${p.label.split(" ")[0] === "Ollama" ? "" : `${p.label}: `}${p.noEmbeddings}. Chat works; add a DeepInfra key below to switch memory on.`;
    res.json({ success: true, provider, label: p.label, chatModel: chatShown, memory: memoryOn, vision: !!visionModel, message: bits.join(", ") + ". Change models any time in Settings.", note });
  } catch (e) {
    res.status(500).json({ error: "could not save the provider" });
  }
});

// Memory on DeepInfra: for installs whose chat provider can't serve
// embeddings. Before anything is indexed this SWITCHES the embedder for free;
// after first index the local embedder is locked (switching would need the
// full re-index that ships as a Settings action later).
app.post("/api/setup/memory-key", async (req, res) => {
  try {
    if (!(await requireSetupAccess(req, res))) return;
    const apiKey = String((req.body || {}).apiKey || "").trim();
    if (!apiKey) return res.status(400).json({ error: "Paste a DeepInfra API key" });
    const r = await fetch("https://api.deepinfra.com/v1/openai/models", {
      headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return res.status(400).json({ error: `DeepInfra rejected that key (${r.status})` });

    const patch = { DEEPINFRA_API_KEY: apiKey };
    const currentEmbed = process.env.EMBED_MODEL || (await getRuntimeConf("EMBED_MODEL"));
    if (String(currentEmbed || "").startsWith("local:")) {
      const { data: dv } = await supabase.from("data_vectors").select("id").limit(1);
      const { data: rc } = await supabase.from("rag_chunks").select("id").limit(1);
      if ((dv && dv.length) || (rc && rc.length)) {
        return res.status(400).json({ error: "Memory is already indexed with the local embedder; switching now means re-indexing everything, which lands as a Settings action. The key was not saved." });
      }
      // Nothing indexed yet: the switch is free. Hosted defaults take over
      // (embeddings, reranker, vision on DeepInfra).
      patch.EMBED_MODEL = "Qwen/Qwen3-Embedding-4B";
      patch.EMBED_API_URL = "https://api.deepinfra.com/v1/openai/embeddings";
      patch.EMBED_API_KEY = apiKey;
      patch.RERANK_MODEL = null;
    }
    await setRuntimeConf(patch);
    res.json({ success: true, switched: !!patch.EMBED_MODEL });
  } catch (e) {
    res.status(500).json({ error: "could not reach DeepInfra" });
  }
});

// QR codes for the setup wizard. The server chooses every URL it encodes, so
// this can never be pointed at an arbitrary target. Telegram has no API to
// create a bot (and one token can only be polled by one server, so a shared
// bot would need exactly the central relay this project refuses) — what a QR
// removes is the phone-side fiddling around BotFather and the first hello.
app.get("/api/setup/qr", async (req, res) => {
  try {
    const target = String(req.query.target || "");
    let url = null;
    if (target === "botfather") url = "https://t.me/BotFather";
    if (target === "bot") {
      const username = await getRuntimeConf("TELEGRAM_BOT_USERNAME");
      if (username) url = `https://t.me/${username}?start=hello`;
    }
    if (!url) return res.status(404).send("no target");
    const svg = await require("qrcode").toString(url, {
      type: "svg", margin: 1, width: 220,
      color: { dark: "#0b0c12", light: "#e9f6ee" },
    });
    res.set("Content-Type", "image/svg+xml");
    res.set("Cache-Control", "no-cache");
    res.send(svg);
  } catch (e) {
    res.status(500).send("qr failed");
  }
});

// Telegram: validate the token with getMe (which also gives us the bot's
// handle for a tap-to-open link), then store it. The bot process notices
// within seconds and starts polling, no restart involved.
app.post("/api/setup/telegram", async (req, res) => {
  try {
    if (!(await requireSetupAccess(req, res))) return;
    const token = String((req.body || {}).token || "").trim();
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) return res.status(400).json({ error: "That doesn't look like a bot token. BotFather sends it as numbers, a colon, then letters." });
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(10000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) return res.status(400).json({ error: "Telegram rejected that token. Copy the whole line BotFather sent." });
    const username = j.result && j.result.username;
    await setRuntimeConf({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_BOT_USERNAME: username || null });
    res.json({ success: true, username });
  } catch (e) {
    res.status(500).json({ error: "could not reach Telegram" });
  }
});

// Google credentials: paste the downloaded JSON (or the two values) and the
// OAuth routes pick them up live.
app.post("/api/setup/google", async (req, res) => {
  try {
    if (!(await requireSetupAccess(req, res))) return;
    let { client_id, client_secret, json } = req.body || {};
    if (json) {
      try {
        const parsed = typeof json === "string" ? JSON.parse(json) : json;
        const blob = parsed.web || parsed.installed || parsed;
        client_id = blob.client_id;
        client_secret = blob.client_secret;
      } catch (_) {
        return res.status(400).json({ error: "That JSON didn't parse. Paste the whole file Google downloaded." });
      }
    }
    client_id = String(client_id || "").trim();
    client_secret = String(client_secret || "").trim();
    if (!client_id.endsWith(".apps.googleusercontent.com")) return res.status(400).json({ error: "The client ID should end in .apps.googleusercontent.com" });
    if (!client_secret) return res.status(400).json({ error: "The client secret is missing" });
    await setRuntimeConf({ GOOGLE_CLIENT_ID: client_id, GOOGLE_CLIENT_SECRET: client_secret });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "could not save Google credentials" });
  }
});

// --- Zero-project fallback tier: IMAP mailbox + secret ICS calendar feed. ---
// Both validate the credential live before saving anything, same rule as the
// Shopify token form: a saved connection that never worked helps nobody.

const IMAP_PRESETS = {
  "gmail.com":      { imap_host: "imap.gmail.com", imap_port: 993, smtp_host: "smtp.gmail.com", smtp_port: 465 },
  "googlemail.com": { imap_host: "imap.gmail.com", imap_port: 993, smtp_host: "smtp.gmail.com", smtp_port: 465 },
  "outlook.com":    { imap_host: "outlook.office365.com", imap_port: 993, smtp_host: "smtp-mail.outlook.com", smtp_port: 587 },
  "hotmail.com":    { imap_host: "outlook.office365.com", imap_port: 993, smtp_host: "smtp-mail.outlook.com", smtp_port: 587 },
  "live.com":       { imap_host: "outlook.office365.com", imap_port: 993, smtp_host: "smtp-mail.outlook.com", smtp_port: 587 },
  "icloud.com":     { imap_host: "imap.mail.me.com", imap_port: 993, smtp_host: "smtp.mail.me.com", smtp_port: 587 },
  "me.com":         { imap_host: "imap.mail.me.com", imap_port: 993, smtp_host: "smtp.mail.me.com", smtp_port: 587 },
  "yahoo.com":      { imap_host: "imap.mail.yahoo.com", imap_port: 993, smtp_host: "smtp.mail.yahoo.com", smtp_port: 465 },
  "fastmail.com":   { imap_host: "imap.fastmail.com", imap_port: 993, smtp_host: "smtp.fastmail.com", smtp_port: 465 },
};

app.post("/api/setup/imap", async (req, res) => {
  try {
    if (!(await requireSetupAccess(req, res))) return;
    const email = String(req.body?.email || "").trim().toLowerCase();
    const appPassword = String(req.body?.app_password || "").replace(/\s+/g, "");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "That doesn't look like an email address" });
    if (!appPassword) return res.status(400).json({ error: "The app password is missing" });
    const aliases = String(req.body?.aliases || "").split(/[,\n]/).map((s) => s.trim()).filter(Boolean);

    const preset = IMAP_PRESETS[email.split("@")[1]] || {};
    const imap_host = String(req.body?.imap_host || preset.imap_host || "").trim();
    const imap_port = Number(req.body?.imap_port || preset.imap_port || 993);
    const smtp_host = String(req.body?.smtp_host || preset.smtp_host || "").trim();
    const smtp_port = Number(req.body?.smtp_port || preset.smtp_port || 465);
    if (!imap_host || !smtp_host) return res.status(400).json({ error: "This provider has no preset. Open advanced settings and fill in the IMAP and SMTP hosts." });

    const { ImapFlow } = require("imapflow");
    const client = new ImapFlow({ host: imap_host, port: imap_port, secure: true, auth: { user: email, pass: appPassword }, logger: false });
    try {
      await client.connect();
      await client.mailboxOpen("INBOX", { readOnly: true });
      await client.logout();
    } catch (e) {
      return res.status(400).json({ error: `Could not sign in: ${String(e.message || e).substring(0, 120)}. For Gmail this needs an app password (Google Account, Security, App passwords), not your normal password.` });
    }

    const { encryptTokens } = require("./crypto-tokens");
    await mustWrite("could not save the mailbox connection", supabase.from("connections").upsert({
      user_id: getAdminUserId(),
      service: "imap",
      tokens: encryptTokens({ app_password: appPassword }),
      config: { imap_host, imap_port, smtp_host, smtp_port, aliases },
      metadata: { email, method: "app_password" },
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,service" }));
    res.json({ success: true, email });
  } catch (e) {
    console.error("IMAP setup error:", e.message);
    res.status(500).json({ error: "could not save the mailbox connection" });
  }
});

app.post("/api/setup/ics", async (req, res) => {
  try {
    if (!(await requireSetupAccess(req, res))) return;
    const icsUrl = String(req.body?.ics_url || "").trim();
    if (!/^https:\/\//i.test(icsUrl)) return res.status(400).json({ error: "The address should start with https://" });
    try {
      const host = new URL(icsUrl).hostname.toLowerCase();
      if (host === "localhost" || /^(127\.|10\.|192\.168\.|169\.254\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith(".internal") || host.endsWith(".local")) {
        return res.status(400).json({ error: "That address points at a private network" });
      }
    } catch (_) { return res.status(400).json({ error: "That address didn't parse as a URL" }); }
    let text;
    try {
      const r = await fetch(icsUrl, { redirect: "follow" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      text = await r.text();
    } catch (e) {
      return res.status(400).json({ error: `Could not fetch that address: ${String(e.message || e).substring(0, 100)}` });
    }
    if (!text.includes("BEGIN:VCALENDAR")) {
      return res.status(400).json({ error: "That address didn't return a calendar feed. In Google Calendar: Settings, pick the calendar, then copy the 'Secret address in iCal format'." });
    }
    const { encryptTokens } = require("./crypto-tokens");
    await mustWrite("could not save the calendar feed", supabase.from("connections").upsert({
      user_id: getAdminUserId(),
      service: "ics_calendar",
      tokens: encryptTokens({ ics_url: icsUrl }),
      config: {},
      metadata: { label: "Calendar (ICS)", method: "secret_url" },
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,service" }));
    res.json({ success: true });
  } catch (e) {
    console.error("ICS setup error:", e.message);
    res.status(500).json({ error: "could not save the calendar feed" });
  }
});

// --- Linked-device WhatsApp (self-host only). The webapp writes the enable
// row; the bot watches for it, runs the Baileys socket, and posts the pairing
// QR back onto the row's metadata for this page to render.
app.post("/api/setup/whatsapp-linked", async (req, res) => {
  try {
    if (!(await requireSetupAccess(req, res))) return;
    const enable = !!req.body?.enable;
    if (enable) {
      await mustWrite("could not enable WhatsApp linking", supabase.from("connections").upsert({
        user_id: getAdminUserId(),
        service: "whatsapp_linked",
        tokens: {},
        config: { enabled: true },
        metadata: { linked: false, qr: null },
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id,service" }));
    } else {
      await mustWrite("could not disable WhatsApp linking", supabase.from("connections").delete()
        .eq("user_id", getAdminUserId()).eq("service", "whatsapp_linked"));
    }
    res.json({ success: true, enabled: enable });
  } catch (e) {
    res.status(500).json({ error: "could not update WhatsApp linking" });
  }
});

// The current pairing QR as a PNG. 404 until the bot has posted one; the
// setup page polls while pairing is open.
app.get("/api/setup/wa-qr", async (req, res) => {
  try {
    if (!(await requireSetupAccess(req, res))) return;
    const { data } = await supabase.from("connections").select("metadata")
      .eq("user_id", getAdminUserId()).eq("service", "whatsapp_linked").single();
    const qr = data?.metadata?.qr;
    if (!qr) return res.status(404).json({ error: "no QR right now" });
    const QRCode = require("qrcode");
    const png = await QRCode.toBuffer(qr, { width: 320, margin: 1 });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.send(png);
  } catch (e) {
    res.status(500).json({ error: "could not render the QR" });
  }
});

// Ask the bot to collect Google credentials from its own signed-in browser
// (the webapp cannot reach the sandbox, and must not import bot code, so the
// request travels through the profile row the bot watches).
// Ask the bot to put Google's sign-in page on ClosedHand's screen, so the
// embedded view shows what the card promises instead of a leftover tab.
app.post("/api/setup/google-open-signin", async (req, res) => {
  try {
    if (!(await requireSetupAccess(req, res))) return;
    const { data: profile } = await supabase.from("profiles").select("settings").eq("id", getAdminUserId()).single();
    const settings = profile?.settings || {};
    // Never interrupt a collection run that is already going.
    const cur = settings.google_browser_job;
    if (cur && (cur.status === "requested" || cur.status === "running")) return res.json({ success: true, skipped: true });
    settings.google_browser_job = { status: "requested", action: "open_signin", message: "Opening Google's sign-in page…", at: new Date().toISOString() };
    await mustWrite("could not save that", supabase.from("profiles").update({ settings, updated_at: new Date().toISOString() }).eq("id", getAdminUserId()));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "could not open the sign-in page" });
  }
});

app.post("/api/setup/google-auto", async (req, res) => {
  try {
    if (!(await requireSetupAccess(req, res))) return;
    const { data: profile } = await supabase.from("profiles").select("settings").eq("id", getAdminUserId()).single();
    const settings = profile?.settings || {};
    settings.browser_google = true; // signing in is what makes this possible
    settings.google_browser_job = { status: "requested", message: "Waiting for ClosedHand to pick this up…", at: new Date().toISOString() };
    await mustWrite("could not save that", supabase.from("profiles").update({ settings, updated_at: new Date().toISOString() }).eq("id", getAdminUserId()));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "could not start the setup run" });
  }
});

// The embedded browser sign-in has no credential to verify server-side (the
// password goes to Google inside the sandbox browser); this just records that
// the user says they did it, which drives the dashboard's tier badges.
app.post("/api/setup/browser-google", async (req, res) => {
  try {
    if (!(await requireSetupAccess(req, res))) return;
    const { data: profile } = await supabase.from("profiles").select("settings").eq("id", getAdminUserId()).single();
    const settings = profile?.settings || {};
    settings.browser_google = !!req.body?.done;
    await mustWrite("could not save that", supabase.from("profiles").update({ settings, updated_at: new Date().toISOString() }).eq("id", getAdminUserId()));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "could not save that" });
  }
});

// --- The gate: everything registered below needs the session (or Basic auth
// --- for scripts) once a password exists. Pre-password, everything is open,
// --- which is the localhost first-run expectation.
app.use(async (req, res, next) => {
  try {
    if (!(await passwordConfigured())) return next();
    if (hasAdminSession(req)) return next();
    const [scheme, encoded] = (req.headers.authorization || "").split(" ");
    if (scheme === "Basic" && encoded) {
      const pass = Buffer.from(encoded, "base64").toString().split(":").slice(1).join(":");
      if (await checkDashboardPassword(pass)) return next();
    }
    if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Login required" });
    return res.redirect("/login?next=" + encodeURIComponent(req.originalUrl || "/"));
  } catch (e) {
    return res.status(500).send("auth check failed");
  }
});

// BYOK spend: daily token rollups for the dashboard Usage tab. Registered after
// the password gate on purpose; usage data is the admin's business only.
app.get("/api/usage/summary", async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 90);
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const { getAdminUserId } = require("./admin");
    const { data, error } = await supabase
      .from("token_usage")
      .select("day, feature, model, calls, tokens_in, tokens_out")
      .eq("user_id", getAdminUserId())
      .gte("day", since)
      .order("day", { ascending: true });
    if (error) throw new Error(error.message || error.code);
    // Normalise driver differences: node-pg hands back date columns as local
    // Dates (which shift a day when ISO-serialised) and bigints as strings.
    const rows = (data || []).map((r) => ({
      day: r.day instanceof Date
        ? `${r.day.getFullYear()}-${String(r.day.getMonth() + 1).padStart(2, "0")}-${String(r.day.getDate()).padStart(2, "0")}`
        : String(r.day).slice(0, 10),
      feature: r.feature,
      model: r.model,
      calls: Number(r.calls) || 0,
      tokens_in: Number(r.tokens_in) || 0,
      tokens_out: Number(r.tokens_out) || 0,
    }));
    res.json({ days, rows });
  } catch (e) {
    res.status(500).json({ error: "usage summary failed" });
  }
});

// --- Upload tokens for Bridge curl-based file transfer ---
const _uploadTokens = new Map(); // token -> { userId, destPath, expires, isDir }
// Cleanup expired tokens every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _uploadTokens) { if (now > v.expires) _uploadTokens.delete(k); }
}, 300000);

// ============================================================
// SIGNED COOKIE
// ============================================================

function signUserId(userId) {
  const hmac = crypto.createHmac("sha256", COOKIE_SECRET);
  hmac.update(userId);
  return `${userId}.${hmac.digest("hex")}`;
}

function verifySignedCookie(cookie) {
  if (!cookie) return null;
  const lastDot = cookie.lastIndexOf(".");
  if (lastDot === -1) return null;
  const userId = cookie.substring(0, lastDot);
  const sig = cookie.substring(lastDot + 1);
  const hmac = crypto.createHmac("sha256", COOKIE_SECRET);
  hmac.update(userId);
  const expected = hmac.digest("hex");
  if (expected.length === sig.length && crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig, "hex"))) return userId;
  return null;
}

// Single-tenant: identity is always the one admin. The signed cookie is retained
// for a future dashboard password gate (P3) but no longer determines *which* user.
function getUserIdFromRequest(req) {
  return getAdminUserId();
}

function setUserCookie(res, userId) {
  const signed = signUserId(userId);
  // Use res.append to avoid overwriting other Set-Cookie headers
  if (typeof res.append === "function") {
    res.append("Set-Cookie", `ch_user=${encodeURIComponent(signed)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`);
  } else {
    res.setHeader("Set-Cookie", `ch_user=${encodeURIComponent(signed)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`);
  }
}

// ============================================================
// TELEGRAM MINI APP — initData validation
// ============================================================

function validateTelegramInitData(initData) {
  if (!initData || !TELEGRAM_BOT_TOKEN) return null;

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;

    params.delete("hash");
    const entries = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join("\n");

    const secretKey = crypto.createHmac("sha256", "WebAppData").update(TELEGRAM_BOT_TOKEN).digest();
    const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

    if (computedHash !== hash) return null;

    const authDate = parseInt(params.get("auth_date"), 10);
    if (Date.now() / 1000 - authDate > 86400) return null;

    const userStr = params.get("user");
    if (!userStr) return null;
    return JSON.parse(userStr);
  } catch (e) {
    console.error("Telegram initData validation error:", e.message);
    return null;
  }
}

// LINE LIFF token validation
async function validateLineAccessToken(accessToken) {
  if (!accessToken) return null;
  try {
    const resp = await fetch(`https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(accessToken)}`);
    if (!resp.ok) {
      console.error("[LINE] Token verify failed:", resp.status, await resp.text());
      return null;
    }
    const data = await resp.json();
    console.log("[LINE] Token verify result:", JSON.stringify({ client_id: data.client_id, expires_in: data.expires_in, expected: LINE_LOGIN_CHANNEL_ID }));
    if (data.expires_in <= 0) return null;
    if (LINE_LOGIN_CHANNEL_ID && String(data.client_id) !== String(LINE_LOGIN_CHANNEL_ID)) return null;
    return data;
  } catch (e) {
    console.error("LINE token validation error:", e.message);
    return null;
  }
}

async function getLineProfile(accessToken) {
  if (!accessToken) return null;
  try {
    const resp = await fetch("https://api.line.me/v2/profile", {
      headers: { "Authorization": `Bearer ${accessToken}` },
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch (e) {
    console.error("LINE profile fetch error:", e.message);
    return null;
  }
}

// Auto-enable a chat platform for Pulse notifications
async function autoEnableNotificationPlatform(userId, platform) {
  try {
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("settings")
      .eq("id", userId)
      .single();

    if (error || !profile) return;

    const settings = profile.settings || {};
    const pulseSettings = settings.pulse_settings || {
      enabled: false,
      intervalMinutes: 20,
      proactiveLevel: "medium",
      quietStart: 22,
      quietEnd: 7,
      deliveryPlatforms: [],
      lastRun: null,
      lastNotified: null,
    };

    const platforms = pulseSettings.deliveryPlatforms || [];
    if (platforms.includes(platform)) return;

    platforms.push(platform);
    pulseSettings.deliveryPlatforms = platforms;
    settings.pulse_settings = pulseSettings;

    await supabase
      .from("profiles")
      .update({ settings })
      .eq("id", userId);
  } catch (e) {
    console.error(`[autoEnableNotificationPlatform] Error for user ${userId}, platform ${platform}:`, e.message);
  }
}

// ============================================================
// PAGE ROUTES
// ============================================================

app.get("/", async (req, res) => {
  // A fresh install lands in the wizard until the required pieces (db + model) run.
  try {
    const state = await require("./setup-state").getSetupState();
    if (!state.ready) return res.redirect("/setup");
  } catch (e) { /* status failure never blocks the homepage */ }
  res.sendFile(path.join(__dirname, "views", "index.html"));
});

// WhatsApp magic link — dedicated onboarding page
app.get("/link/whatsapp/:token", async (req, res) => {
  const token = req.params.token;

  // Validate token
  const { data: pending } = await supabase
    .from("wa_pending_links")
    .select("phone, expires_at")
    .eq("token", token)
    .single();

  if (!pending || new Date(pending.expires_at) < new Date()) {
    return res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>ClosedHand</title>
    <style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,system-ui,sans-serif;background:#0a0a0a;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
    .card{max-width:400px;text-align:center;padding:40px}.title{font-size:24px;margin-bottom:16px}.desc{color:#888;line-height:1.6}</style></head>
    <body><div class="card"><div class="title">Link expired</div><p class="desc">Send another message on WhatsApp to get a fresh link.</p></div></body></html>`);
  }

  // If already logged in, auto-link immediately
  const userId = getUserIdFromRequest(req);
  if (userId) {
    const { data: existing } = await supabase
      .from("chat_links")
      .select("id")
      .eq("platform", "whatsapp")
      .eq("platform_user_id", pending.phone)
      .single();

    if (!existing) {
      await supabase.from("chat_links").insert({
        user_id: userId,
        platform: "whatsapp",
        platform_user_id: pending.phone,
      });
    }
    await autoEnableNotificationPlatform(userId, "whatsapp");
    await supabase.from("wa_pending_links").delete().eq("token", token);

    return res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>ClosedHand</title>
    <style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,system-ui,sans-serif;background:#0a0a0a;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
    .card{max-width:400px;text-align:center;padding:40px}.title{font-size:28px;margin-bottom:16px}.check{font-size:64px;margin-bottom:20px}.desc{color:#888;line-height:1.6;margin-bottom:24px}
    .btn{display:inline-block;background:#25D366;color:#fff;padding:14px 32px;border-radius:12px;text-decoration:none;font-size:16px;font-weight:600}</style></head>
    <body><div class="card"><div class="check">✅</div><div class="title">WhatsApp linked</div><p class="desc">You're all set. Tap below to say hello — I'll take it from there.</p>
    <a href="https://wa.me/15551799854?text=hey" class="btn">Open WhatsApp</a></div></body></html>`);
  }

  // Not logged in — store token in cookie, show focused sign-in page
  res.setHeader("Set-Cookie", `ch_wa_link=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=1800`);

  res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>ClosedHand — Connect WhatsApp</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,system-ui,sans-serif;background:#0a0a0a;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
    .card{max-width:400px;text-align:center;padding:40px}
    .logo{font-size:32px;font-weight:700;margin-bottom:8px}
    .subtitle{color:#888;font-size:15px;margin-bottom:40px;line-height:1.5}
    .btn{display:flex;align-items:center;justify-content:center;gap:12px;width:100%;padding:16px;border-radius:12px;font-size:16px;font-weight:600;text-decoration:none;margin-bottom:12px;transition:transform 0.1s}
    .btn:active{transform:scale(0.98)}
    .btn-google{background:#fff;color:#333}
    .btn-microsoft{background:#2f2f2f;color:#fff;border:1px solid #444}
    .btn img{width:20px;height:20px}
    .footer{color:#555;font-size:12px;margin-top:32px;line-height:1.5}
    .footer a{color:#888;text-decoration:none}
  </style></head>
  <body><div class="card">
    <div class="logo">ClosedHand</div>
    <p class="subtitle">Sign in to connect your WhatsApp.<br>One tap and you're in.</p>
    <a href="/auth/google" class="btn btn-google">
      <img src="/logos/google.svg" alt="">Sign in with Google
    </a>
    <a href="/auth/microsoft" class="btn btn-microsoft">
      <img src="/logos/microsoft.svg" alt="">Sign in with Microsoft
    </a>
    <p class="footer">Your data stays yours. <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p>
  </div></body></html>`);
});
// Canvas JSON API: fetch canvas content for in-panel rendering
app.get("/api/canvas/:id", async (req, res) => {
  try {
    const { data, error } = await supabase.from("canvases").select("id, filename, mime_type, content").eq("id", req.params.id).single();
    if (error || !data) return res.status(404).json({ error: "Not found" });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to load canvas" });
  }
});

// Canvas: shareable generated content (charts, HTML, images)
app.get("/canvas/:id", async (req, res) => {
  try {
    const { data, error } = await supabase.from("canvases").select("*").eq("id", req.params.id).single();
    if (error || !data) return res.status(404).send("Canvas not found");

    if (data.mime_type === "text/html") {
      const html = Buffer.from(data.content, "base64").toString("utf-8");
      // Serve HTML directly with a top bar. CSP restricts to scripts only (no forms, no navigation).
      res.set("Content-Security-Policy", "default-src 'self' 'unsafe-inline' 'unsafe-eval' https: data: blob:; frame-ancestors 'self'");
      res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${data.filename.replace(/</g, "&lt;")} - ClosedHand</title>
<style>*{margin:0;box-sizing:border-box}
.ch-bar{position:fixed;top:0;left:0;right:0;z-index:9999;padding:10px 16px;background:#0a0c12;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;gap:10px;color:rgba(255,255,255,0.5);font-size:13px;font-family:Outfit,system-ui,sans-serif}
.ch-bar img{width:18px;height:18px;opacity:0.6}.ch-bar a{color:rgba(255,255,255,0.7);text-decoration:none;font-weight:500}
.ch-content{padding-top:42px}</style></head>
<body><div class="ch-bar"><img src="/fist.png"><a href="/">ClosedHand</a><span style="color:rgba(255,255,255,0.3)">|</span><span>${data.filename.replace(/</g, "&lt;")}</span></div>
<div class="ch-content">${html}</div></body></html>`);
    } else if (data.mime_type.startsWith("image/")) {
      const buf = Buffer.from(data.content, "base64");
      res.set("Content-Type", data.mime_type);
      res.set("Cache-Control", "public, max-age=86400");
      res.send(buf);
    } else {
      res.status(400).send("Unsupported content type");
    }
  } catch (err) {
    console.error("Canvas error:", err.message);
    res.status(500).send("Error loading canvas");
  }
});

// Legal pages carry the OPERATOR's contact, not the project's: a self-hoster's
// users must reach whoever actually runs the instance, so the email comes from
// CONTACT_EMAIL. Unset, the clause drops and /feedback stays the contact path.
function sendLegalPage(res, file) {
  const email = (process.env.CONTACT_EMAIL || "").trim();
  const clause = email
    ? `, or email <a href="mailto:${email}" style="color: #4CAF50;">${email}</a>`
    : "";
  const html = require("fs")
    .readFileSync(path.join(__dirname, "views", file), "utf8")
    .replace(/{{CONTACT_CLAUSE}}/g, clause);
  res.type("html").send(html);
}
app.get("/privacy", (req, res) => sendLegalPage(res, "privacy.html"));
app.get("/terms", (req, res) => sendLegalPage(res, "terms.html"));
app.get("/dashboard", async (req, res) => {
  let userId = getUserIdFromRequest(req);

  // After OAuth login: serve homepage instead of dashboard so user lands
  // on the main page with cookie established (same server-side request)
  if (userId && req.query.from_login === "1") {
    return res.sendFile(path.join(__dirname, "views", "index.html"));
  }

  // LINE LIFF auto-login: validate token and set auth cookie
  if (!userId && req.query.lineAccessToken) {
    const tokenValid = await validateLineAccessToken(req.query.lineAccessToken);
    if (tokenValid) {
      const profile = await getLineProfile(req.query.lineAccessToken);
      if (profile) {
        const { data: link } = await supabase
          .from("chat_links")
          .select("user_id")
          .eq("platform", "line")
          .eq("platform_user_id", profile.userId)
          .single();
        if (link) {
          userId = link.user_id;
          setUserCookie(res, userId);
        }
      }
    }
  }

  if (!userId) return res.redirect("/");
  // The page carries its own JS inline, so a cached copy means shipped fixes
  // never reach the user until they happen to hard reload.
  res.set("Cache-Control", "no-cache, must-revalidate");
  res.sendFile(path.join(__dirname, "views", "dashboard.html"));
});

app.get("/telegram-app", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "telegram-app.html"));
});

app.get("/line-app", (req, res) => {
  const liffId = process.env.LINE_LIFF_ID || "";
  const fs = require("fs");
  let html = fs.readFileSync(path.join(__dirname, "views", "line-app.html"), "utf8");
  html = html.replace("__LIFF_ID__", liffId);
  res.type("html").send(html);
});

app.get("/line-setup-complete", (req, res) => {
  const name = req.query.name || "";
  res.type("html").send(`<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ClosedHand Setup Complete</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #fff; color: #1a1a1a; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; text-align: center; }
  .card { max-width: 360px; }
  .icon { font-size: 64px; margin-bottom: 16px; }
  h1 { font-size: 24px; margin-bottom: 8px; }
  p { font-size: 15px; color: #666; line-height: 1.5; margin-bottom: 16px; }
  .highlight { color: #06C755; font-weight: 600; }
  .countdown { font-size: 13px; color: #999; }
</style>
</head><body>
<div class="card">
  <div class="icon">&#x2705;</div>
  <h1>You're all set${name ? ", " + name : ""}</h1>
  <p>Your account is connected. Opening <span class="highlight">LINE</span> in <span id="timer">3</span>s...</p>
</div>
<script>
  var t = 3;
  var el = document.getElementById("timer");
  var iv = setInterval(function() {
    t--;
    el.textContent = t;
    if (t <= 0) {
      clearInterval(iv);
      window.location.href = "https://line.me/R/oaMessage/%40990jhhra/";
    }
  }, 1000);
</script>
</body></html>`);
});

app.get("/logout", (req, res) => {
  res.setHeader("Set-Cookie", "ch_user=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
  res.redirect("/");
});

// ============================================================
// BOT-INITIATED SERVICE CONNECTION
// Validates a signed token from the bot, sets a session, and
// redirects into the standard OAuth flow.
// ============================================================

app.get("/bot-connect", (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send("Missing token.");

  try {
    const dotIdx = token.lastIndexOf(".");
    if (dotIdx === -1) return res.status(400).send("Invalid token.");
    const payloadB64 = token.substring(0, dotIdx);
    const sig = token.substring(dotIdx + 1);

    const payloadStr = Buffer.from(payloadB64, "base64url").toString();
    const expectedSig = crypto.createHmac("sha256", process.env.SUPABASE_SERVICE_KEY)
      .update(payloadStr).digest("hex");

    if (sig.length !== expectedSig.length || !crypto.timingSafeEqual(Buffer.from(expectedSig, "hex"), Buffer.from(sig, "hex"))) return res.status(403).send("Invalid token signature.");

    const payload = JSON.parse(payloadStr);
    if (!payload.userId || !payload.service || !payload.exp) return res.status(400).send("Malformed token.");
    if (Date.now() > payload.exp) return res.status(410).send("This link has expired. Ask the bot for a new one.");

    const svc = SERVICES[payload.service];
    if (!svc) return res.status(400).send(`Unknown service: ${payload.service}`);

    // Log the user in and redirect to OAuth
    setUserCookie(res, payload.userId);
    const params = payload.storeDomain ? `?store_domain=${encodeURIComponent(payload.storeDomain)}` : "";
    res.redirect(`/auth/${payload.service}${params}`);
  } catch (e) {
    console.error("bot-connect error:", e.message);
    res.status(500).send("Something went wrong. Ask the bot for a new link.");
  }
});

// ============================================================
// GENERIC OAUTH FRAMEWORK
// ============================================================

// PKCE helper for services that require it (e.g. Salesforce)
function generatePKCE() {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

// OAuth state tokens (in-memory, short-lived)
const oauthStates = new Map();

function generateOAuthState(data) {
  const state = crypto.randomBytes(16).toString("hex");
  oauthStates.set(state, { ...data, created: Date.now() });
  // Clean up old states (>15 min)
  for (const [key, val] of oauthStates) {
    if (Date.now() - val.created > 15 * 60 * 1000) oauthStates.delete(key);
  }
  return state;
}

function consumeOAuthState(state) {
  const data = oauthStates.get(state);
  if (!data) return null;
  oauthStates.delete(state);
  if (Date.now() - data.created > 15 * 60 * 1000) return null;
  return data;
}

// Start OAuth for any service
app.get("/auth/:service", async (req, res) => {
  const serviceKey = req.params.service;
  const svc = SERVICES[serviceKey];

  if (!svc || !svc.clientId || !svc.clientSecret) {
    return res.status(400).send("Service not available");
  }

  // Determine flow: website, chat_popup, Telegram, or LINE
  const { initData, store_domain, lineAccessToken, flow: queryFlow } = req.query;
  let flow = "website";
  let tgUser = null;
  let lineUser = null;

  if (queryFlow === "chat_popup") {
    flow = "chat_popup";
  } else if (initData) {
    tgUser = validateTelegramInitData(initData);
    if (!tgUser) return res.status(400).send("Invalid Telegram session");
    flow = "telegram";
  } else if (lineAccessToken) {
    const tokenValid = await validateLineAccessToken(lineAccessToken);
    if (!tokenValid) return res.status(400).send("Invalid LINE session");
    lineUser = await getLineProfile(lineAccessToken);
    if (!lineUser) return res.status(400).send("Could not get LINE profile");
    flow = "line";
  }

  // For website flow, user must be logged in (except Google which is also signup)
  if (flow === "website" && !svc.isSignup) {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.redirect("/");
  }

  const redirectUri = `${BASE_URL}/auth/${serviceKey}/callback`;

  // Build state
  const stateData = {
    service: serviceKey,
    flow,
    userId: flow === "website" ? getUserIdFromRequest(req) : null,
    tgId: tgUser?.id?.toString() || null,
    tgName: tgUser ? (tgUser.first_name + (tgUser.last_name ? " " + tgUser.last_name : "")) : null,
    lineId: lineUser?.userId || null,
    lineName: lineUser?.displayName || null,
    storeDomain: store_domain || null,
    waLink: null,
    // Explicit "connect an additional Google account" flow (mail/calendar for
    // a second Gmail). Only meaningful for google + a logged-in user.
    extraAccount: (serviceKey === "google" || serviceKey === "microsoft") && req.query.extra === "1" && !!getUserIdFromRequest(req),
  };

  // Check for WhatsApp magic link cookie
  const cookieStr = req.headers.cookie || "";
  const waLinkMatch = cookieStr.match(/ch_wa_link=([^;]+)/);
  if (waLinkMatch) stateData.waLink = waLinkMatch[1];

  // PKCE support (e.g. Salesforce)
  let pkce = null;
  if (svc.usePKCE) {
    pkce = generatePKCE();
    stateData.codeVerifier = pkce.codeVerifier;
  }

  const state = generateOAuthState(stateData);

  // Build auth URL
  let authUrl;

  if (svc.needsStoreDomain) {
    const domain = store_domain;
    if (!domain) return res.status(400).send("Store domain required. Use ?store_domain=yourstore.myshopify.com");
    if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.myshopify\.com$/.test(domain)) {
      return res.status(400).send("Invalid store domain. Must be yourstore.myshopify.com");
    }
    authUrl = `https://${domain}/admin/oauth/authorize?` +
      `client_id=${encodeURIComponent(svc.clientId)}` +
      `&scope=${encodeURIComponent(svc.scopes.join(svc.scopeJoin || " "))}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${state}`;
  } else {
    const scopeValue = svc.scopes.join(svc.scopeJoin || " ");
    const scopeKey = svc.scopeParam || "scope";

    const params = new URLSearchParams({
      client_id: svc.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      [scopeKey]: scopeValue,
      state,
    });

    if (svc.extraAuthParams) {
      for (const [k, v] of Object.entries(svc.extraAuthParams)) {
        params.set(k, v);
      }
    }

    if (pkce) {
      params.set("code_challenge", pkce.codeChallenge);
      params.set("code_challenge_method", "S256");
    }

    authUrl = `${svc.authUrl}?${params.toString()}`;
  }

  res.redirect(authUrl);
});

// ============================================================
// MCP OAUTH FLOW
// ============================================================

// Probe an MCP URL to check if it needs OAuth
app.post("/api/mcps/probe", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const { server_url } = req.body;
    if (!server_url) return res.status(400).json({ error: "server_url required" });

    try {
      const parsed = new URL(server_url);
      if (parsed.protocol !== "https:") return res.status(400).json({ error: "HTTPS required" });
    } catch { return res.status(400).json({ error: "Invalid URL" }); }

    // Try calling tools/list to see if auth is required
    const baseUrl = server_url.replace(/\/+$/, "");
    let resp;
    try {
      resp = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "ClosedHand", version: "1.0.0" },
        } }),
        signal: AbortSignal.timeout(10000),
      });
    } catch (e) {
      console.log(`[MCP probe] Could not reach ${baseUrl}:`, e.message);
      return res.json({ error: "Could not reach server: " + e.message });
    }

    console.log(`[MCP probe] ${baseUrl} returned ${resp.status}`);

    // No auth needed
    if (resp.ok) {
      return res.json({ auth_required: false });
    }

    // Auth required - discover OAuth endpoints
    if (resp.status === 401) {
      const authBase = new URL(server_url).origin;
      let metadata = null;

      // Try RFC 8414 metadata discovery
      try {
        const metaResp = await fetch(`${authBase}/.well-known/oauth-authorization-server`, {
          headers: { "MCP-Protocol-Version": "2025-03-26" },
          signal: AbortSignal.timeout(5000),
        });
        if (metaResp.ok) {
          metadata = await metaResp.json();
        }
      } catch (e) {
        console.log("MCP OAuth metadata discovery failed, using fallback:", e.message);
      }

      // Use discovered or fallback endpoints
      const authorizationEndpoint = metadata?.authorization_endpoint || `${authBase}/authorize`;
      const tokenEndpoint = metadata?.token_endpoint || `${authBase}/token`;
      const registrationEndpoint = metadata?.registration_endpoint || `${authBase}/register`;
      const scopesSupported = metadata?.scopes_supported || [];

      // Try Dynamic Client Registration (RFC 7591)
      let clientId = null;
      let clientSecret = null;
      let needsClientId = false;

      try {
        const regResp = await fetch(registrationEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_name: "ClosedHand",
            redirect_uris: [`${BASE_URL}/auth/mcp-oauth/callback`],
            grant_types: ["authorization_code"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          }),
          signal: AbortSignal.timeout(5000),
        });
        if (regResp.ok) {
          const regData = await regResp.json();
          clientId = regData.client_id;
          clientSecret = regData.client_secret || null;
        } else {
          needsClientId = true;
        }
      } catch (e) {
        needsClientId = true;
      }

      return res.json({
        auth_required: true,
        authorization_endpoint: authorizationEndpoint,
        token_endpoint: tokenEndpoint,
        registration_endpoint: registrationEndpoint,
        scopes_supported: scopesSupported,
        client_id: clientId,
        client_secret: clientSecret,
        needs_client_id: needsClientId,
      });
    }

    res.json({ error: "Server returned " + resp.status });
  } catch (e) {
    console.error("MCP probe error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Start MCP OAuth redirect
app.post("/api/mcps/oauth-start", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const { server_url, name, authorization_endpoint, token_endpoint, client_id, client_secret } = req.body;
    if (!server_url || !authorization_endpoint || !token_endpoint || !client_id) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const pkce = generatePKCE();
    const state = generateOAuthState({
      flow: "mcp-oauth",
      userId,
      serverUrl: server_url,
      name: name || new URL(server_url).hostname.replace(/^mcp\.|\.com$|\.io$/g, ""),
      tokenEndpoint: token_endpoint,
      clientId: client_id,
      clientSecret: client_secret || null,
      codeVerifier: pkce.codeVerifier,
    });

    const redirectUri = `${BASE_URL}/auth/mcp-oauth/callback`;
    const params = new URLSearchParams({
      client_id: client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: pkce.codeChallenge,
      code_challenge_method: "S256",
      state: state,
    });

    const authUrl = `${authorization_endpoint}?${params.toString()}`;
    res.json({ redirect_url: authUrl });
  } catch (e) {
    console.error("MCP OAuth start error:", e);
    res.status(500).json({ error: e.message });
  }
});

// MCP OAuth callback (must be BEFORE /auth/:service/callback to avoid conflict)
app.get("/auth/mcp-oauth/callback", async (req, res) => {
  const { code, error, state } = req.query;

  if (error) {
    console.error("MCP OAuth error:", error);
    return res.redirect("/dashboard?mcp_error=" + encodeURIComponent(error));
  }

  const stateData = consumeOAuthState(state);
  if (!stateData || stateData.flow !== "mcp-oauth") {
    return res.redirect("/dashboard?mcp_error=invalid_state");
  }

  try {
    const redirectUri = `${BASE_URL}/auth/mcp-oauth/callback`;

    // Exchange code for tokens
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code: code,
      redirect_uri: redirectUri,
      client_id: stateData.clientId,
      code_verifier: stateData.codeVerifier,
    });
    if (stateData.clientSecret) {
      tokenBody.set("client_secret", stateData.clientSecret);
    }

    const tokenResp = await fetch(stateData.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });

    if (!tokenResp.ok) {
      const errText = await tokenResp.text();
      console.error("MCP OAuth token exchange failed:", tokenResp.status, errText);
      return res.redirect("/dashboard?mcp_error=token_exchange_failed");
    }

    const tokens = await tokenResp.json();

    // Security scan: discover tools and check before saving
    let declaredInfo = null;
    let declaredTools = [];
    try {
      const scanHeaders = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": "Bearer " + tokens.access_token,
      };
      const mcpUrl = stateData.serverUrl.replace(/\/+$/, "");
      const initR = await fetch(mcpUrl, {
        method: "POST", headers: scanHeaders,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "ClosedHand", version: "1.0.0" } } }),
        signal: AbortSignal.timeout(10000),
      });
      if (initR.ok) {
        const sid = initR.headers.get("mcp-session-id");
        if (sid) scanHeaders["Mcp-Session-Id"] = sid;
        declaredInfo = await readServerInfo(initR);
        const tlR = await fetch(mcpUrl, {
          method: "POST", headers: scanHeaders,
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
          signal: AbortSignal.timeout(10000),
        });
        if (tlR.ok) {
          const tlD = await tlR.json();
          const tls = tlD.result?.tools || tlD.tools || [];
          declaredTools = tls.map((t) => t.name).filter(Boolean);
          if (tls.length > 0) {
            const scan = await scanMcpTools(tls);
            console.log(`[security-scan] OAuth MCP "${stateData.name}": ${scan.risk_level} - ${scan.summary}`);
            if (scan.risk_level === "blocked") {
              return res.redirect("/dashboard?mcp_error=" + encodeURIComponent("Blocked: " + scan.summary));
            }
            // For warnings on OAuth flow, we allow but log (can't show inline UI during redirect)
            if (scan.risk_level === "warning") {
              console.log(`[security-scan] Warning for OAuth MCP "${stateData.name}":`, scan.findings);
            }
          }
        }
      }
    } catch (scanErr) {
      console.log("[security-scan] OAuth MCP scan failed (allowing connection):", scanErr.message);
    }

    // Upsert into user_mcps
    const { error: dbError } = await supabase
      .from("user_mcps")
      .upsert({
        user_id: stateData.userId,
        name: await resolveMcpName(declaredInfo, stateData.serverUrl, declaredTools),
        logo_url: await storeMcpIcon(declaredInfo, stateData.serverUrl),
        server_url: stateData.serverUrl,
        auth_token: tokens.access_token,
        auth_type: "oauth",
        oauth_client_id: stateData.clientId,
        oauth_client_secret: stateData.clientSecret || null,
        oauth_refresh_token: tokens.refresh_token || null,
        oauth_token_url: stateData.tokenEndpoint,
        oauth_token_expiry: tokens.expires_in ? Date.now() + (tokens.expires_in * 1000) : null,
        status: "connected",
        installed_via: "oauth",
      }, { onConflict: "user_id,server_url" });

    if (dbError) throw dbError;

    console.log(`MCP OAuth connected: ${stateData.name} for user ${stateData.userId.substring(0, 8)}`);
    res.redirect("/dashboard?mcp_connected=" + encodeURIComponent(stateData.name));
  } catch (e) {
    console.error("MCP OAuth callback error:", e);
    res.redirect("/dashboard?mcp_error=" + encodeURIComponent(e.message));
  }
});

// OAuth callback for any service
app.get("/auth/:service/callback", async (req, res) => {
  const serviceKey = req.params.service;
  const svc = SERVICES[serviceKey];
  const { code, error, state } = req.query;

  const stateData = consumeOAuthState(state);

  if (error || !code) {
    if (stateData?.flow === "telegram") {
      return res.redirect(`/telegram-app?error=auth_denied&service=${serviceKey}`);
    }
    if (stateData?.flow === "line") {
      return res.redirect(`/line-app?error=auth_denied&service=${serviceKey}`);
    }
    if (stateData?.flow === "chat_popup") {
      return res.send(`<!DOCTYPE html><html><body><script>
        window.opener && window.opener.postMessage({type:'oauth_error',service:'${serviceKey}'},'*');
        window.close();
      </script><p>Authentication cancelled. You can close this window.</p></body></html>`);
    }
    return res.redirect(svc?.isSignup ? "/?error=google_denied" : "/dashboard?error=auth_denied");
  }

  if (!svc || !stateData) {
    return res.redirect("/dashboard?error=invalid_state");
  }

  try {
    const redirectUri = `${BASE_URL}/auth/${serviceKey}/callback`;
    const tokens = await exchangeOAuthCode(svc, code, redirectUri, stateData.storeDomain, stateData.codeVerifier);

    if (stateData.extraAccount && serviceKey === "google") {
      return await handleExtraGoogleAccount(res, stateData, svc, tokens);
    }
    if (stateData.extraAccount && serviceKey === "microsoft") {
      return await handleExtraMicrosoftAccount(res, stateData, svc, tokens);
    }

    if (stateData.flow === "telegram") {
      await handleTelegramOAuthComplete(res, stateData, serviceKey, svc, tokens);
    } else if (stateData.flow === "line") {
      await handleLineOAuthComplete(res, stateData, serviceKey, svc, tokens);
    } else if (stateData.flow === "chat_popup") {
      // Chat popup flow: do signup/connect, then close popup with postMessage
      if (svc.isSignup) {
        await handleSignupOAuthComplete(res, stateData, serviceKey, svc, tokens);
      } else {
        await handleServiceOAuthComplete(req, res, stateData, serviceKey, tokens);
      }
      // Override redirect with popup-close HTML (handleSignup already sent response in some cases)
      if (!res.headersSent) {
        return res.send(`<!DOCTYPE html><html><head><title>Connected</title></head><body><script>
          window.opener && window.opener.postMessage({type:'oauth_complete',service:'${serviceKey}'},'*');
          window.close();
        </script><p>Connected. You can close this window.</p></body></html>`);
      }
    } else if (svc.isSignup) {
      await handleSignupOAuthComplete(res, stateData, serviceKey, svc, tokens);
    } else {
      await handleServiceOAuthComplete(req, res, stateData, serviceKey, tokens);
    }

  } catch (err) {
    console.error(`OAuth error (${serviceKey}):`, err.message, err.stack);
    if (stateData?.flow === "telegram") {
      return res.redirect(`/telegram-app?error=oauth_failed&service=${serviceKey}`);
    }
    if (stateData?.flow === "line") {
      return res.redirect(`/line-app?error=oauth_failed&service=${serviceKey}`);
    }
    return res.redirect(svc?.isSignup ? "/?error=" + encodeURIComponent(err.message).substring(0, 100) : "/dashboard?error=oauth_failed");
  }
});

// Exchange auth code for tokens — generic for all services
async function exchangeOAuthCode(svc, code, redirectUri, storeDomain, codeVerifier) {
  let tokenUrl = svc.tokenUrl;

  if (svc.needsStoreDomain && storeDomain) {
    if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.myshopify\.com$/.test(storeDomain)) {
      throw new Error("Invalid store domain");
    }
    tokenUrl = `https://${storeDomain}/admin/oauth/access_token`;
  }

  const params = new URLSearchParams({
    code,
    client_id: svc.clientId,
    client_secret: svc.clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  if (codeVerifier) {
    params.set("code_verifier", codeVerifier);
  }

  const postData = params.toString();

  const url = new URL(tokenUrl);

  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    "Content-Length": Buffer.byteLength(postData),
    "Accept": "application/json",
  };

  // Notion/Zoom use Basic auth for token exchange
  if (svc.tokenAuthMethod === "basic") {
    headers["Authorization"] = "Basic " + Buffer.from(`${svc.clientId}:${svc.clientSecret}`).toString("base64");
  }

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: "POST",
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          console.log(`[OAuth] Token exchange response for ${url.hostname}: ${raw.substring(0, 200)}`);
          const data = JSON.parse(raw);
          if (data.error) {
            reject(new Error(`${data.error}: ${data.error_description || ""}`));
          } else {
            console.log(`[OAuth] Got token: ${data.access_token ? data.access_token.substring(0, 10) + '...' : 'NONE'}`);
            resolve({
              access_token: data.access_token,
              refresh_token: data.refresh_token || null,
              expiry: data.expires_in ? Date.now() + data.expires_in * 1000 : null,
              raw: data,
            });
          }
        });
      }
    );
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

// Fetch user profile from a service
async function fetchServiceProfile(svc, accessToken) {
  if (!svc.profileUrl) return null;

  return new Promise((resolve, reject) => {
    const url = new URL(svc.profileUrl);
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": "ClosedHand/1.0",
          Accept: "application/json",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString();
          try {
            const data = JSON.parse(body);
            if (data.error) reject(new Error(data.error.message || data.error));
            else resolve(data);
          } catch (e) {
            reject(new Error(`Non-JSON response from ${svc.profileUrl}: ${body.substring(0, 100)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

// Handle: signup/login via Google or Microsoft (website flow)
async function handleSignupOAuthComplete(res, stateData, serviceKey, svc, tokens) {
  const rawProfile = await fetchServiceProfile(svc, tokens.access_token);

  // Normalize profile fields across providers
  const profile = {
    email: rawProfile.email || rawProfile.mail || rawProfile.userPrincipalName,
    name: rawProfile.name || rawProfile.displayName || rawProfile.email,
  };

  // Single-tenant: attach to the one admin, populating its profile from the
  // provider on first connect, instead of finding/creating a user.
  const adminId = getAdminUserId();
  await supabase.from("profiles").update({
    display_name: profile.name,
    email: profile.email,
    updated_at: new Date().toISOString(),
  }).eq("id", adminId);
  const user = { id: adminId, ...profile };

  // Set cookie FIRST, before any potentially-failing operations
  setUserCookie(res, user.id);
  console.log(`[Auth] Cookie set for user ${user.id}`);

  try {
    const metadata = await fetchAccountMetadata(serviceKey, svc, tokens);
    await saveConnection(user.id, serviceKey, tokens, svc, metadata);
  } catch (connErr) {
    console.error(`[Auth] saveConnection error (non-fatal): ${connErr.message}`);
    // Cookie is already set, user is logged in. Connection save failed but that's recoverable.
  }

  // Auto-link WhatsApp if magic link token is present
  if (stateData.waLink) {
    try {
      const { data: pending } = await supabase
        .from("wa_pending_links")
        .select("phone, expires_at")
        .eq("token", stateData.waLink)
        .single();

      if (pending && new Date(pending.expires_at) > new Date()) {
        const { data: existing } = await supabase
          .from("chat_links")
          .select("id")
          .eq("platform", "whatsapp")
          .eq("platform_user_id", pending.phone)
          .single();

        if (!existing) {
          await supabase.from("chat_links").insert({
            user_id: user.id,
            platform: "whatsapp",
            platform_user_id: pending.phone,
          });
          console.log(`WhatsApp auto-linked: ${pending.phone} → ${user.id}`);
        }
        await autoEnableNotificationPlatform(user.id, "whatsapp");

        await supabase.from("wa_pending_links").delete().eq("token", stateData.waLink);
      }
    } catch (e) {
      console.error("WhatsApp auto-link error:", e.message);
    }
    // Clear cookie and show success page
    res.setHeader("Set-Cookie", "ch_wa_link=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
    return res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>ClosedHand</title>
    <style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,system-ui,sans-serif;background:#0a0a0a;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
    .card{max-width:400px;text-align:center;padding:40px}.title{font-size:28px;margin-bottom:16px}.check{font-size:64px;margin-bottom:20px}.desc{color:#888;line-height:1.6;margin-bottom:24px}
    .btn{display:inline-block;background:#25D366;color:#fff;padding:14px 32px;border-radius:12px;text-decoration:none;font-size:16px;font-weight:600}</style></head>
    <body><div class="card"><div class="check">✅</div><div class="title">You're in</div><p class="desc">WhatsApp is connected. Tap below to say hello — I'll take it from there.</p>
    <a href="https://wa.me/15551799854?text=hey" class="btn">Open WhatsApp</a></div></body></html>`);
  }

  // Two-step redirect: first to /dashboard (sets cookie via server-side auth check),
  // then bounce to homepage. The cookie sticks because /dashboard is a server-side route.
  // The homepage's client-side /api/chat/status fetch will then see the cookie.
  res.redirect("/");
}

// Handle: connecting a service for existing user (website flow)
// Additional Google account (mail + calendar for a second Gmail).
// This flow deliberately bypasses the identity-mismatch guard: connecting a
// DIFFERENT Google account is the whole point. Duplicates are still rejected.
async function handleExtraGoogleAccount(res, stateData, svc, tokens) {
  const userId = stateData.userId;
  if (!userId) return res.redirect("/?error=no_session");

  const metadata = await fetchAccountMetadata("google", svc, tokens);
  const email = (metadata?.email || "").toLowerCase().trim();
  if (!email) return res.redirect("/dashboard?error=" + encodeURIComponent("Could not read the Google account's email. Try again."));

  const normGmail = (e) => {
    e = (e || "").toLowerCase().trim();
    const m = e.match(/^([^@]+)@(gmail|googlemail)\.com$/);
    return m ? m[1].replace(/\./g, "") + "@gmail.com" : e;
  };

  // Reject accounts that are already connected (primary or extra)
  const { data: existing } = await supabase
    .from("connections").select("service, metadata")
    .eq("user_id", userId).like("service", "google%");
  const { data: prof } = await supabase.from("profiles").select("email").eq("id", userId).single();
  const knownEmails = new Set([normGmail(prof?.email)]);
  for (const c of existing || []) knownEmails.add(normGmail(c.metadata?.email));
  if (knownEmails.has(normGmail(email))) {
    return res.redirect("/dashboard?error=" + encodeURIComponent(`${email} is already connected.`));
  }

  const slug = email.split("@")[0].replace(/[^a-z0-9]/g, "").substring(0, 24) || "acct" + Date.now().toString(36);
  await saveConnection(userId, "google_extra_" + slug, tokens, svc, metadata);
  console.log(`[Auth] Extra Google account connected for ${userId}: ${email} (google_extra_${slug})`);
  res.redirect("/dashboard?connected=google_extra");
}

async function handleExtraMicrosoftAccount(res, stateData, svc, tokens) {
  const userId = stateData.userId;
  if (!userId) return res.redirect("/?error=no_session");

  const metadata = await fetchAccountMetadata("microsoft", svc, tokens);
  const email = (metadata?.email || "").toLowerCase().trim();
  if (!email) return res.redirect("/dashboard?error=" + encodeURIComponent("Could not read the Microsoft account's email. Try again."));

  // Reject accounts that are already connected (primary or extra)
  const { data: existing } = await supabase
    .from("connections").select("service, metadata")
    .eq("user_id", userId).like("service", "microsoft%");
  const knownEmails = new Set();
  for (const c of existing || []) knownEmails.add((c.metadata?.email || "").toLowerCase().trim());
  if (knownEmails.has(email)) {
    return res.redirect("/dashboard?error=" + encodeURIComponent(`${email} is already connected.`));
  }

  const slug = email.split("@")[0].replace(/[^a-z0-9]/g, "").substring(0, 24) || "acct" + Date.now().toString(36);
  await saveConnection(userId, "microsoft_extra_" + slug, tokens, svc, metadata);
  console.log(`[Auth] Extra Microsoft account connected for ${userId}: ${email} (microsoft_extra_${slug})`);
  res.redirect("/dashboard?connected=microsoft_extra");
}

async function handleServiceOAuthComplete(req, res, stateData, serviceKey, tokens) {
  const userId = stateData.userId;
  if (!userId) return res.redirect("/?error=no_session");

  const svc = SERVICES[serviceKey];
  let metadata = await fetchAccountMetadata(serviceKey, svc, tokens);

  // Identity guard: connecting a mailbox that isn't the signed-in user's is
  // almost always a browser account-chooser mistake and would grant this
  // account someone else's email. Block it with a clear message.
  if ((serviceKey === "google" || serviceKey === "microsoft") && metadata?.email) {
    const { data: prof } = await supabase.from("profiles").select("email").eq("id", userId).single();
    const norm = (e) => {
      e = (e || "").toLowerCase().trim();
      const m = e.match(/^([^@]+)@(gmail|googlemail)\.com$/);
      return m ? m[1].replace(/\./g, "") + "@gmail.com" : e;
    };
    const loginEmail = norm(prof?.email);
    const grantedEmail = norm(metadata.email);
    if (loginEmail && grantedEmail && loginEmail !== grantedEmail) {
      console.warn(`OAuth identity mismatch: user ${userId} (${loginEmail}) tried to connect ${serviceKey} as ${grantedEmail}. Blocked.`);
      return res.redirect("/dashboard?error=" + encodeURIComponent(
        `That account (${metadata.email}) doesn't match your ClosedHand login (${prof?.email}). Pick your own account in the Google chooser and try again.`));
    }
  }

  // For Shopify, store the shop domain in metadata
  if (serviceKey === "shopify" && stateData.storeDomain) {
    if (!metadata) metadata = {};
    metadata.shopDomain = stateData.storeDomain;
  }

  await saveConnection(userId, serviceKey, tokens, svc, metadata);

  // USI: classify and start syncing the newly connected service
  try {
    const { onServiceConnected } = require("../lib/services/usi-connector");
    const methods = svc.scopes || [];
    onServiceConnected(userId, serviceKey, methods).catch(e =>
      console.log(`[USI-Connector] Post-connect error for ${serviceKey}: ${e.message}`)
    );
  } catch (e) { /* USI connector optional */ }

  // Check for multi-connect queue
  const raw = req.headers.cookie || "";
  const queueMatch = raw.match(/ch_connect_queue=([^;]+)/);
  if (queueMatch) {
    try {
      const queue = JSON.parse(decodeURIComponent(queueMatch[1]));
      const idx = queue.indexOf(serviceKey);
      if (idx !== -1) queue.splice(idx, 1);
      if (queue.length > 0) {
        const remaining = JSON.stringify(queue);
        res.setHeader("Set-Cookie", `ch_connect_queue=${encodeURIComponent(remaining)}; Path=/; HttpOnly; Secure; SameSite=Lax`);
        return res.redirect(`/auth/${queue[0]}`);
      }
    } catch (e) {
      // Malformed cookie, ignore
    }
    // Queue empty or finished — clear cookie
    res.setHeader("Set-Cookie", "ch_connect_queue=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
    return res.redirect("/dashboard?connected=multiple");
  }

  res.redirect("/dashboard?connected=" + serviceKey);
}

// Handle: Telegram Mini App OAuth completion
async function handleTelegramOAuthComplete(res, stateData, serviceKey, svc, tokens) {
  const telegramId = stateData.tgId;
  const telegramName = stateData.tgName;

  const { data: existingLink } = await supabase
    .from("chat_links")
    .select("user_id")
    .eq("platform", "telegram")
    .eq("platform_user_id", telegramId)
    .single();

  let userId;

  if (existingLink) {
    userId = existingLink.user_id;
  } else {
    if (svc.isSignup && svc.profileUrl) {
      const rawProfile = await fetchServiceProfile(svc, tokens.access_token);
      const profile = {
        email: rawProfile.email || rawProfile.mail || rawProfile.userPrincipalName,
        name: rawProfile.name || rawProfile.displayName || rawProfile.email,
      };
      userId = getAdminUserId(); // single-tenant: attach to the admin, don't create a user
    } else {
      return res.redirect("/telegram-app?error=no_account");
    }

    await supabase
      .from("chat_links")
      .delete()
      .eq("user_id", userId)
      .eq("platform", "telegram")
      .is("platform_user_id", null);

    await supabase.from("chat_links").upsert(
      {
        user_id: userId,
        platform: "telegram",
        platform_user_id: telegramId,
        activation_code: null,
        expires_at: null,
      },
      { onConflict: "user_id,platform" }
    );
  }

  await autoEnableNotificationPlatform(userId, "telegram");

  const metadata = await fetchAccountMetadata(serviceKey, svc, tokens);
  await saveConnection(userId, serviceKey, tokens, svc, metadata);
  res.redirect(`/telegram-app?setup=complete&name=${encodeURIComponent(telegramName)}&service=${serviceKey}`);
}

async function handleLineOAuthComplete(res, stateData, serviceKey, svc, tokens) {
  const lineId = stateData.lineId;
  const lineName = stateData.lineName;
  console.log(`[LINE] OAuth complete: lineId=${lineId}, lineName=${lineName}`);

  const { data: existingLink } = await supabase
    .from("chat_links")
    .select("user_id")
    .eq("platform", "line")
    .eq("platform_user_id", lineId)
    .single();

  let userId;

  if (existingLink) {
    userId = existingLink.user_id;
  } else {
    if (svc.isSignup && svc.profileUrl) {
      const rawProfile = await fetchServiceProfile(svc, tokens.access_token);
      const profile = {
        email: rawProfile.email || rawProfile.mail || rawProfile.userPrincipalName,
        name: rawProfile.name || rawProfile.displayName || rawProfile.email,
      };
      userId = getAdminUserId(); // single-tenant: attach to the admin, don't create a user
    } else {
      return res.redirect("/line-app?error=no_account");
    }

    // Clear any existing LINE links for this user or this LINE ID
    await supabase.from("chat_links").delete().eq("platform", "line").eq("platform_user_id", lineId);
    await supabase.from("chat_links").delete().eq("user_id", userId).eq("platform", "line");

    const { error: insertErr } = await supabase.from("chat_links").insert({
      user_id: userId,
      platform: "line",
      platform_user_id: lineId,
      activation_code: null,
      expires_at: null,
    });
    if (insertErr) console.error("[LINE] chat_links insert error:", insertErr.message);
    else console.log(`[LINE] Linked user ${userId} to LINE ${lineId}`);
  }

  await autoEnableNotificationPlatform(userId, "line");

  const metadata = await fetchAccountMetadata(serviceKey, svc, tokens);
  await saveConnection(userId, serviceKey, tokens, svc, metadata);

  // Set onboarding step so bot expects the name answer (we already asked)
  const { data: pRow } = await supabase.from("profiles").select("settings").eq("id", userId).single();
  const sett = pRow?.settings || {};
  sett.onboarding_step = "name_bot";
  const { error: settingsErr } = await supabase.from("profiles").update({ settings: sett }).eq("id", userId);
  if (settingsErr) console.error(`[settings] could not save: ${settingsErr.message}`);

  // Send welcome Flex Message + onboarding prompt via LINE push
  const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (lineToken && lineId) {
    const liffId = process.env.LINE_LIFF_ID;
    const dashUrl = liffId ? `https://liff.line.me/${liffId}?view=dashboard` : `${BASE_URL}/dashboard`;
    const firstName = (lineName || "").split(/\s+/)[0];
    try {
      await fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${lineToken}` },
        body: JSON.stringify({
          to: lineId,
          messages: [
            {
              type: "flex",
              altText: "Your ClosedHand dashboard is ready.",
              contents: {
                type: "bubble",
                body: {
                  type: "box",
                  layout: "vertical",
                  spacing: "md",
                  contents: [
                    { type: "text", text: "Your dashboard", weight: "bold", size: "lg", align: "center" },
                    { type: "text", text: "Add connections to make ClosedHand more powerful. Email, calendar, Shopify, Slack, and more.", size: "sm", color: "#999999", align: "center", wrap: true, margin: "sm" },
                  ],
                },
                footer: {
                  type: "box",
                  layout: "vertical",
                  spacing: "sm",
                  contents: [
                    {
                      type: "button",
                      action: { type: "uri", label: "Open Dashboard", uri: dashUrl },
                      style: "primary",
                      color: "#06C755",
                      height: "md",
                    },
                  ],
                },
              },
            },
            {
              type: "text",
              text: (firstName ? `Hi ${firstName}. ` : "Hi. ") + "First things first. What would you like to call me?",
            },
          ],
        }),
      });
    } catch (e) {
      console.error("[LINE] Welcome push error:", e.message);
    }
  }

  res.redirect(`/line-setup-complete?name=${encodeURIComponent(lineName)}&service=${serviceKey}`);
}

// Save connection tokens to Supabase
async function saveConnection(userId, serviceKey, tokens, svc, metadata = null) {
  const { encryptTokens } = require("./crypto-tokens");
  const row = {
    user_id: userId,
    service: serviceKey,
    tokens: encryptTokens({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry: tokens.expiry,
    }),
    config: {
      scopes: svc.scopes,
      ...(tokens.raw?.team ? { team: tokens.raw.team } : {}),
      ...(tokens.raw?.authed_user ? { authed_user: tokens.raw.authed_user } : {}),
    },
    updated_at: new Date().toISOString(),
  };
  if (metadata) row.metadata = metadata;
  await mustWrite("could not save the connection", supabase.from("connections").upsert(row, { onConflict: "user_id,service" }));
}

// Fetch account metadata after OAuth for display on settings page
async function fetchAccountMetadata(serviceKey, svc, tokens) {
  try {
    const accessToken = tokens.access_token;
    const profile = await fetchServiceProfile(svc, accessToken);
    if (!profile) return null;

    switch (serviceKey) {
      case "google":
        return { name: profile.name, email: profile.email, picture: profile.picture };

      case "microsoft":
        return { name: profile.displayName, email: profile.mail || profile.userPrincipalName };

      case "github":
        return { username: profile.login, name: profile.name, email: profile.email, avatar: profile.avatar_url };

      case "gitlab":
        return { username: profile.username, name: profile.name, email: profile.email, avatar: profile.avatar_url };

      case "meta_ads": {
        const meta = { name: profile.name, email: profile.email };
        const graphGet = (path) => new Promise((resolve, reject) => {
          const req = https.request({
            hostname: "graph.facebook.com",
            path: `${path}${path.includes("?") ? "&" : "?"}access_token=${accessToken}`,
            method: "GET",
          }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
              try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
              catch { resolve(null); }
            });
          });
          req.on("error", () => resolve(null));
          req.end();
        });
        // Fetch ad accounts, businesses, and pages in parallel
        const [adData, bizData, pageData, permData] = await Promise.all([
          graphGet("/me/adaccounts?fields=name,account_id,business_name,account_status"),
          graphGet("/me/businesses?fields=name,id"),
          graphGet("/me/accounts?fields=name,id,category"),
          graphGet("/me/permissions"),
        ]);
        if (adData?.data) meta.adAccounts = adData.data.map(a => ({
          name: a.name || a.business_name, accountId: a.account_id,
          status: a.account_status === 1 ? "active" : a.account_status === 2 ? "disabled" : "unknown",
        }));
        if (bizData?.data) meta.businesses = bizData.data.map(b => ({ name: b.name, id: b.id }));
        if (pageData?.data) meta.pages = pageData.data.map(p => ({ name: p.name, id: p.id, category: p.category }));
        if (permData?.data) meta.permissions = permData.data.map(p => ({ permission: p.permission, status: p.status }));
        return meta;
      }

      case "zoom":
        return { name: `${profile.first_name} ${profile.last_name}`.trim(), email: profile.email };

      case "dropbox":
        return { name: profile.name?.display_name, email: profile.email };

      case "asana":
        return { name: profile.data?.name, email: profile.data?.email };

      case "mailchimp":
        return { name: profile.accountname || profile.login?.login_name, email: profile.login?.email };

      case "spotify":
        return { name: profile.display_name, email: profile.email };

      case "stripe":
        return { name: profile.business_profile?.name || profile.display_name };

      default:
        // Generic: try common fields
        return {
          name: profile.name || profile.displayName || profile.display_name || profile.login || null,
          email: profile.email || profile.mail || null,
        };
    }
  } catch (e) {
    console.error(`Metadata fetch error (${serviceKey}):`, e.message);
    return null;
  }
}

// ============================================================
// API ROUTES
// ============================================================

// ============================================================
// WEB CHAT API — anonymous chat, SSE streaming, history
// ============================================================

// Create anonymous profile on first message (not page load)

// Send a chat message
app.post("/api/chat/send", async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return res.status(400).json({ error: "Message required" });
    }
    if (message.length > 10000) {
      return res.status(400).json({ error: "Message too long" });
    }

    // Get or create user
    let userId = getUserIdFromRequest(req);

    // Insert inbound message
    const { data, error } = await supabase.from("web_messages").insert({
      user_id: userId,
      direction: "inbound",
      content: message.trim(),
      status: "pending",
    }).select().single();

    if (error) {
      console.error("[Chat] Insert error:", error.message);
      return res.status(500).json({ error: "Failed to send message" });
    }

    res.json({ ok: true, messageId: data.id, userId });
  } catch (err) {
    console.error("[Chat] Send error:", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// SSE stream for receiving responses
app.get("/api/chat/stream", (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Send keepalive immediately
  res.write(":\n\n");

  // Subscribe to outbound messages for this user
  const channel = supabase
    .channel(`web-chat-${userId}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "web_messages",
        filter: `user_id=eq.${userId}`,
      },
      (payload) => {
        const msg = payload.new;
        if (msg.direction === "outbound") {
          res.write(`data: ${JSON.stringify({ type: "message", content: msg.content, id: msg.id, created_at: msg.created_at })}\n\n`);
        } else if (msg.direction === "inbound" && msg.status === "processing") {
          res.write(`data: ${JSON.stringify({ type: "typing" })}\n\n`);
        }
      }
    )
    .subscribe();

  // Also listen for status updates (processing -> complete)
  const statusChannel = supabase
    .channel(`web-status-${userId}`)
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "web_messages",
        filter: `user_id=eq.${userId}`,
      },
      (payload) => {
        const msg = payload.new;
        if (msg.direction === "inbound" && msg.status === "processing") {
          res.write(`data: ${JSON.stringify({ type: "typing" })}\n\n`);
        }
      }
    )
    .subscribe();

  // Keepalive every 30s
  const keepalive = setInterval(() => {
    res.write(":\n\n");
  }, 30000);

  req.on("close", () => {
    clearInterval(keepalive);
    supabase.removeChannel(channel);
    supabase.removeChannel(statusChannel);
  });
});

// ============================================================================
// CONVERSATION THREADS API
// ============================================================================

// GET /api/threads - list all threads
app.get("/api/threads", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not authenticated" });
  try {
    const { data } = await supabase.from("conversation_threads")
      .select("id, title, is_active, created_at, updated_at, messages")
      .eq("user_id", userId)
      .eq("archived", false)
      .order("updated_at", { ascending: false })
      .limit(50);
    const threads = (data || []).map(t => ({
      id: t.id, title: t.title, is_active: t.is_active,
      created_at: t.created_at, updated_at: t.updated_at,
      message_count: (t.messages || []).length,
    }));
    res.json(threads);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/threads/search?q=... - search through conversation content
app.get("/api/threads/search", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not authenticated" });
  const q = (req.query.q || "").toLowerCase().trim();
  if (!q || q.length < 2) return res.json([]);
  try {
    const { data } = await supabase.from("conversation_threads")
      .select("id, title, is_active, updated_at, messages")
      .eq("user_id", userId)
      .eq("archived", false)
      .order("updated_at", { ascending: false })
      .limit(50);
    const results = (data || []).filter(t => {
      if ((t.title || "").toLowerCase().includes(q)) return true;
      // Search message content
      for (const msg of (t.messages || [])) {
        const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "");
        if (text.toLowerCase().includes(q)) return true;
      }
      return false;
    }).map(t => ({
      id: t.id, title: t.title, is_active: t.is_active, updated_at: t.updated_at,
      message_count: (t.messages || []).length,
    }));
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/threads/:id - get thread messages
app.get("/api/threads/:id", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not authenticated" });
  try {
    const { data: rows } = await supabase.from("conversation_threads")
      .select("id, title, messages, summary, is_active, created_at, updated_at")
      .eq("id", req.params.id).eq("user_id", userId).limit(1);
    var data = rows && rows.length > 0 ? rows[0] : null;
    if (!data) return res.status(404).json({ error: "Thread not found" });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/threads/new - archive current, create new
app.post("/api/threads/new", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not authenticated" });
  try {
    // Find current active thread (maybeSingle avoids error if none/multiple exist)
    const { data: activeRows } = await supabase.from("conversation_threads")
      .select("id, messages").eq("user_id", userId).eq("is_active", true).limit(1);
    const active = activeRows && activeRows.length > 0 ? activeRows[0] : null;

    if (active) {
      // Auto-title from first substantial message
      let title = null;
      for (const msg of (active.messages || [])) {
        if (msg.role === "user" && typeof msg.content === "string" && msg.content.length > 10) {
          title = msg.content.substring(0, 50);
          break;
        }
      }
      if (!title) title = "Chat, " + new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short" });
      await supabase.from("conversation_threads")
        .update({ is_active: false, title, updated_at: new Date().toISOString() })
        .eq("id", active.id);
    }

    // Create new
    const { data: newThread } = await supabase.from("conversation_threads")
      .insert({ user_id: userId, is_active: true, platform: "web" })
      .select("id").single();
    res.json({ success: true, thread_id: newThread?.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/threads/:id/activate - switch to this thread
app.post("/api/threads/:id/activate", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not authenticated" });
  try {
    // Deactivate all for this user
    await supabase.from("conversation_threads")
      .update({ is_active: false }).eq("user_id", userId).eq("is_active", true);
    // Activate target (don't update updated_at - only messages should change ordering)
    await supabase.from("conversation_threads")
      .update({ is_active: true })
      .eq("id", req.params.id).eq("user_id", userId);

    // Get the thread for response
    const { data: threadRows } = await supabase.from("conversation_threads")
      .select("id, title, messages").eq("id", req.params.id).limit(1);
    var thread = threadRows && threadRows.length > 0 ? threadRows[0] : null;
    res.json({ success: true, title: thread?.title, message_count: (thread?.messages || []).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/threads/:id - delete one thread
// POST /api/threads/:id/archive — tidy the sidebar, keep the memory. The
// thread row and its messages stay, its distilled summaries stay, it just
// stops being listed until restored. Delete remains the full purge.
app.post("/api/threads/:id/archive", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not authenticated" });
  try {
    const { data } = await supabase.from("conversation_threads")
      .update({ archived: true }).eq("id", req.params.id).eq("user_id", userId).select();
    if (!data || data.length === 0) return res.status(404).json({ error: "Thread not found" });
    if (data[0].is_active) {
      await supabase.from("conversation_threads")
        .insert({ user_id: userId, is_active: true, platform: "web" });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/threads/:id/unarchive — bring it back to the list, and to
// /threads switching, exactly as it was.
app.post("/api/threads/:id/unarchive", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not authenticated" });
  try {
    const { data } = await supabase.from("conversation_threads")
      .update({ archived: false }).eq("id", req.params.id).eq("user_id", userId).select("id");
    if (!data || data.length === 0) return res.status(404).json({ error: "Thread not found" });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/threads/archived — what has been put away, for the sidebar's
// Archived section. Restoring is the only action offered there.
app.get("/api/threads/archived", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not authenticated" });
  try {
    const { data, error } = await supabase.from("conversation_threads")
      .select("id, title, updated_at, messages")
      .eq("user_id", userId).eq("archived", true)
      .order("updated_at", { ascending: false }).limit(50);
    if (error) throw error;
    res.json((data || []).map(t => ({
      id: t.id,
      title: t.title || "Untitled conversation",
      updated_at: t.updated_at,
      message_count: Array.isArray(t.messages) ? t.messages.length : 0,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/threads/:id", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not authenticated" });
  try {
    const { data } = await supabase.from("conversation_threads")
      .delete().eq("id", req.params.id).eq("user_id", userId).select();
    if (!data || data.length === 0) return res.status(404).json({ error: "Thread not found" });

    // Delete means delete, on every surface. The bot's deleteThread purges the
    // thread's distilled memory; this endpoint is the webapp's own copy of
    // that behaviour (services share the database, never code), or the
    // sidebar X would be the one delete that quietly keeps a summary.
    await supabase.from("data_vectors").delete()
      .eq("user_id", userId).eq("service", "memory")
      .eq("external_id", `thread_${req.params.id}`);
    await mustWrite("could not clear that conversation's memory", supabase.from("data_vectors").delete()
      .eq("user_id", userId).eq("service", "memory")
      .in("item_type", ["conversation_summary", "thread_summary"])
      .eq("source_metadata->>thread_id", req.params.id));

    // If it was active, create new
    if (data[0].is_active) {
      await supabase.from("conversation_threads")
        .insert({ user_id: userId, is_active: true, platform: "web" });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/threads - delete ALL threads
app.delete("/api/threads", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not authenticated" });
  try {
    await mustWrite("could not delete those conversations", supabase.from("conversation_threads").delete().eq("user_id", userId));
    // Every thread is going, so every distilled conversation memory goes with
    // it. Scoped by item_type so fact mirrors sharing the service survive.
    await supabase.from("data_vectors").delete()
      .eq("user_id", userId).eq("service", "memory")
      .in("item_type", ["conversation_summary", "thread_summary"]);
    await supabase.from("conversation_threads")
      .insert({ user_id: userId, is_active: true, platform: "web" });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Chat history
// POST /api/chat/clear - clear web chat history
app.post("/api/chat/clear", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });
  try {
    await mustWrite("could not delete your messages", supabase.from("web_messages").delete().eq("user_id", userId));
    // Also clear all threads
    try {
      await mustWrite("could not delete your conversations", supabase.from("conversation_threads").delete().eq("user_id", userId));
      await supabase.from("conversation_threads")
        .insert({ user_id: userId, is_active: true, platform: "web" });
    } catch (e) {
      // conversation_threads table may not exist yet
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to clear" });
  }
});

app.get("/api/chat/history", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) {
    return res.json({ messages: [] });
  }

  // Get the most recent messages (last 100), then reverse to ascending order for display
  const { data: rawData, error } = await supabase
    .from("web_messages")
    .select("id, direction, content, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(100);
  const data = rawData ? rawData.reverse() : [];

  if (error) {
    console.error("[Chat] History error:", error.message);
    return res.status(500).json({ error: "Failed to load history" });
  }

  res.json({ messages: data || [] });
});

// Activity feed for sidebar timeline
app.get("/api/chat/activity", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.json({ activities: [] });

  try {
    const activities = [];

    // Recent inbound messages (user's questions) - group by time gaps
    const { data: messages } = await supabase
      .from("web_messages")
      .select("content, created_at")
      .eq("user_id", userId)
      .eq("direction", "inbound")
      .order("created_at", { ascending: false })
      .limit(30);

    if (messages) {
      let lastTime = null;
      for (const m of messages) {
        const t = new Date(m.created_at).getTime();
        // Only show messages that are 30+ min apart (session breaks)
        if (!lastTime || lastTime - t > 30 * 60 * 1000) {
          const preview = m.content.length > 60 ? m.content.substring(0, 57) + "..." : m.content;
          activities.push({ type: "chat", text: preview, time: m.created_at });
        }
        lastTime = t;
      }
    }

    // Recent memory vectors (conversation summaries, facts)
    const { data: memVectors } = await supabase
      .from("data_vectors")
      .select("content, item_type, source_metadata, updated_at")
      .eq("user_id", userId)
      .eq("service", "memory")
      .order("updated_at", { ascending: false })
      .limit(20);

    if (memVectors) {
      for (const v of memVectors.slice(0, 5)) {
        const label = v.source_metadata?.title || (v.content || "").substring(0, 50);
        activities.push({ type: "brain", text: label, time: v.updated_at });
      }
      // Check for pulse-related vectors
      const pulseVectors = memVectors.filter(v => {
        const content = (v.content || "").toLowerCase();
        return content.includes("pulse") || content.includes("briefing");
      });
      if (pulseVectors.length > 0) {
        const latestPulse = pulseVectors[0];
        activities.push({
          type: "pulse",
          text: pulseNotes.length === 1
            ? "1 pulse check"
            : pulseNotes.length + " pulse checks",
          time: latestPulse.updated_at,
          count: pulseNotes.length,
        });
      }
    }

    // Sort all by time, most recent first
    activities.sort((a, b) => new Date(b.time) - new Date(a.time));

    res.json({ activities: activities.slice(0, 15) });
  } catch (e) {
    console.error("[Chat] Activity error:", e.message);
    res.json({ activities: [] });
  }
});

// Delete an activity item
app.post("/api/chat/activity/delete", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const { type, text } = req.body;
  if (!type || !text) return res.status(400).json({ error: "type and text required" });

  try {
    if (type === "brain") {
      await mustWrite("could not forget that memory", supabase.from("data_vectors").delete().eq("user_id", userId).eq("service", "memory").ilike("content", text.substring(0, 50) + "%"));
    } else if (type === "team") {
    } else if (type === "chat") {
      // Delete web messages matching this preview text
      await supabase.from("web_messages").delete().eq("user_id", userId).eq("direction", "inbound").ilike("content", text.replace("...", "%"));
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("[Chat] Activity delete error:", e.message);
    res.status(500).json({ error: "Delete failed" });
  }
});

// WebSocket auth token for direct browser-to-bot chat
app.get("/api/chat/ws-token", async (req, res) => {
  try {
    let userId = getUserIdFromRequest(req);
    const WS_AUTH_SECRET = process.env.WS_AUTH_SECRET || "fallback-dev-secret";
    const exp = Date.now() + 60000; // 60s validity
    const payload = `${userId}.${exp}`;
    const hmac = crypto.createHmac("sha256", WS_AUTH_SECRET);
    hmac.update(payload);
    const sig = hmac.digest("hex");
    const token = `${payload}.${sig}`;
    res.json({ token, wsUrl: process.env.BOT_WS_URL || "" });
  } catch (err) {
    console.error("[Chat] WS token error:", err.message);
    res.status(500).json({ error: "Failed to create token" });
  }
});

// Check auth status (for chat UI to know if user is logged in)
app.get("/api/chat/status", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) {
      return res.json({ authenticated: false });
    }

    const { data: rows } = await supabase
      .from("profiles")
      .select("id, display_name, email, is_anonymous")
      .eq("id", userId)
      .limit(1);
    const profile = rows && rows.length > 0 ? rows[0] : null;

    res.json({
      authenticated: true,
      isAnonymous: profile?.is_anonymous || false,
      name: profile?.display_name || null,
      email: profile?.email || null,
    });
  } catch (e) {
    console.error("[Auth] chat/status error:", e.message);
    res.json({ authenticated: false });
  }
});

app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// Available services list
app.get("/api/services", (req, res) => {
  res.json(getAvailableServices());
});

// Telegram Mini App status
app.post("/api/telegram/status", async (req, res) => {
  const { initData } = req.body;
  const tgUser = validateTelegramInitData(initData);

  if (!tgUser) {
    return res.status(400).json({ error: "Invalid Telegram session" });
  }

  try {
    const { data: link } = await supabase
      .from("chat_links")
      .select("user_id")
      .eq("platform", "telegram")
      .eq("platform_user_id", tgUser.id.toString())
      .single();

    if (!link) {
      return res.json({ status: "new", name: tgUser.first_name });
    }

    const { data: connections } = await supabase
      .from("connections")
      .select("service")
      .eq("user_id", link.user_id);

    const { data: profile } = await supabase
      .from("profiles")
      .select("email")
      .eq("id", link.user_id)
      .single();

    res.json({
      status: "linked",
      name: tgUser.first_name,
      email: profile?.email,
      services: (connections || []).map(c => c.service),
    });
  } catch (err) {
    console.error("Telegram status error:", err.message);
    res.status(500).json({ error: "Failed to check status" });
  }
});

// LINE LIFF Mini App status
app.post("/api/line/status", async (req, res) => {
  const { accessToken } = req.body;

  const tokenValid = await validateLineAccessToken(accessToken);
  if (!tokenValid) {
    return res.status(400).json({ error: "Invalid LINE session" });
  }

  const lineProfile = await getLineProfile(accessToken);
  if (!lineProfile) {
    return res.status(400).json({ error: "Could not get LINE profile" });
  }

  try {
    const { data: link } = await supabase
      .from("chat_links")
      .select("user_id")
      .eq("platform", "line")
      .eq("platform_user_id", lineProfile.userId)
      .single();

    if (!link) {
      return res.json({ status: "new", name: lineProfile.displayName });
    }

    const { data: connections } = await supabase
      .from("connections")
      .select("service")
      .eq("user_id", link.user_id);

    const { data: profile } = await supabase
      .from("profiles")
      .select("email")
      .eq("id", link.user_id)
      .single();

    res.json({
      status: "linked",
      name: lineProfile.displayName,
      email: profile?.email,
      services: (connections || []).map(c => c.service),
    });
  } catch (err) {
    console.error("LINE status error:", err.message);
    res.status(500).json({ error: "Failed to check status" });
  }
});

// Dashboard status
app.get("/api/status", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });

  try {
    const { data: profile } = await supabase
      .from("profiles")
      .select("display_name, email, settings")
      .eq("id", userId)
      .single();

    const { data: chatLinks } = await supabase
      .from("chat_links")
      .select("platform, platform_user_id, activation_code, expires_at")
      .eq("user_id", userId);

    const { data: connections } = await supabase
      .from("connections")
      .select("service")
      .eq("user_id", userId);

    const now = new Date();
    const platforms = {};
    for (const [key, info] of Object.entries(SUPPORTED_PLATFORMS)) {
      const link = chatLinks?.find((l) => l.platform === key);
      const codeExpired = link?.expires_at && new Date(link.expires_at) < now;
      const pendingCode = (link?.activation_code && !codeExpired) ? link.activation_code : null;

      platforms[key] = {
        ...info,
        connected: !!(link && link.platform_user_id),
        pendingCode,
      };
    }

    res.json({
      name: profile?.display_name || "User",
      email: profile?.email || "",
      settings: profile?.settings || {},
      services: (connections || []).map((c) => c.service),
      platforms,
      availableServices: getAvailableServices(),
    });
  } catch (err) {
    console.error("Status error:", err.message);
    res.status(500).json({ error: "Failed to load status" });
  }
});

// Connected accounts (for settings page)
app.get("/api/connections", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  console.log("GET /api/connections — userId:", userId);
  if (!userId) return res.status(401).json({ error: "Not logged in" });

  try {
    const { data: connections, error: connErr } = await supabase
      .from("connections")
      .select("service, metadata, updated_at")
      .eq("user_id", userId);

    if (connErr) throw connErr;

    const result = (connections || []).map(c => ({
      service: c.service,
      name: SERVICES[c.service]?.name || c.service,
      logoUrl: SERVICES[c.service]?.logoUrl || "",
      isSignup: SERVICES[c.service]?.isSignup || false,
      provides: SERVICES[c.service]?.provides || [],
      metadata: c.metadata || null,
      connectedAt: c.updated_at,
    }));

    res.json(result);

    // Backfill metadata in background for connections that are missing it
    for (const c of (connections || [])) {
      if (c.metadata || !SERVICES[c.service]) continue;
      (async () => {
        try {
          const { data: row } = await supabase
            .from("connections")
            .select("tokens")
            .eq("user_id", userId)
            .eq("service", c.service)
            .single();

          const decrypted = require("./crypto-tokens").decryptTokens(row?.tokens);
          if (decrypted?.access_token) {
            const metadata = await fetchAccountMetadata(c.service, SERVICES[c.service], { access_token: decrypted.access_token });
            if (metadata) {
              await mustWrite("could not update the connection", supabase.from("connections").update({ metadata }).eq("user_id", userId).eq("service", c.service));
              console.log(`Backfilled metadata for ${c.service}`);
            }
          }
        } catch (e) {
          console.error(`Metadata backfill failed (${c.service}):`, e.message);
        }
      })();
    }
  } catch (err) {
    console.error("Connections error:", err.message);
    res.status(500).json({ error: "Failed to load connections" });
  }
});

// Shopify API key paste flow
app.post("/api/connect-shopify-token", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });

  const { storeDomain, accessToken } = req.body;
  if (!storeDomain || !accessToken) return res.status(400).json({ error: "Store domain and access token are required" });

  // Normalise domain
  const domain = storeDomain.replace(/\.myshopify\.com$/i, "").trim() + ".myshopify.com";

  // Validate domain format to prevent SSRF
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.myshopify\.com$/.test(domain)) {
    return res.status(400).json({ error: "Invalid store domain. Must be yourstore.myshopify.com" });
  }

  // Validate token by calling Shopify API
  try {
    const shopData = await new Promise((resolve, reject) => {
      const httpReq = https.request({
        hostname: domain,
        path: "/admin/api/2024-01/shop.json",
        method: "GET",
        headers: { "X-Shopify-Access-Token": accessToken },
      }, (httpRes) => {
        const chunks = [];
        httpRes.on("data", (c) => chunks.push(c));
        httpRes.on("end", () => {
          if (httpRes.statusCode !== 200) return reject(new Error(`Shopify returned ${httpRes.statusCode}`));
          try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
          catch { reject(new Error("Invalid response from Shopify")); }
        });
      });
      httpReq.on("error", reject);
      httpReq.end();
    });

    const shopName = shopData?.shop?.name || domain;
    const shopEmail = shopData?.shop?.email || null;

    // Save connection
    const { encryptTokens } = require("./crypto-tokens");
    const row = {
      user_id: userId,
      service: "shopify",
      tokens: encryptTokens({ access_token: accessToken }),
      config: { scopes: ["read_products", "read_orders", "read_all_orders", "read_customers", "read_analytics", "read_inventory", "read_shopify_payments_payouts"] },
      metadata: { shopDomain: domain, name: shopName, email: shopEmail, method: "api_key" },
      updated_at: new Date().toISOString(),
    };
    await mustWrite("could not save the connection", supabase.from("connections").upsert(row, { onConflict: "user_id,service" }));

    res.json({ success: true, shopName, domain });
  } catch (e) {
    console.error("Shopify token validation failed:", e.message);
    res.status(400).json({ error: "Could not connect to your store. Check the domain and token are correct." });
  }
});

// Generate activation code
// Removed: /api/generate-code (activation-code linking) — single-tenant maps any
// inbound sender to the admin; "connect a platform" is just messaging the bot.

// Connect multiple services (queue-based)
app.post("/api/connect-multiple", (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });

  const { services } = req.body;
  if (!Array.isArray(services) || services.length === 0) {
    return res.status(400).json({ error: "No services provided" });
  }

  for (const key of services) {
    if (!SERVICES[key] || SERVICES[key].isSignup) {
      return res.status(400).json({ error: `Invalid service: ${key}` });
    }
  }

  const queue = JSON.stringify(services);
  res.setHeader("Set-Cookie", `ch_connect_queue=${encodeURIComponent(queue)}; Path=/; HttpOnly; Secure; SameSite=Lax`);
  res.json({ redirectUrl: `/auth/${services[0]}` });
});

// Disconnect a service
app.post("/api/disconnect", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });

  const { service } = req.body;

  // Best-effort revocation of a Google grant at Google's end, so "disconnect"
  // means revoked, not just forgotten. Works with access or refresh token.
  const revokeGoogleGrant = async (tokens) => {
    try {
      const t = require("./crypto-tokens").decryptTokens(tokens) || {};
      const tok = t.refresh_token || t.access_token;
      if (!tok) return;
      await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: tok }),
      });
    } catch (_) { /* row still gets deleted; user can also revoke at Google */ }
  };

  // Extra Google accounts disconnect like any integration
  if (typeof service === "string" && /^google_extra_[a-z0-9]+$/.test(service)) {
    try {
      const { data: row } = await supabase.from("connections").select("tokens").eq("user_id", userId).eq("service", service).single();
      if (row?.tokens) await revokeGoogleGrant(row.tokens);
      await mustWrite("could not disconnect that service", supabase.from("connections").delete().eq("user_id", userId).eq("service", service));
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: "Failed to disconnect" });
    }
  }

  if (!service || !SERVICES[service]) {
    return res.status(400).json({ error: "Invalid service" });
  }

  if (SERVICES[service].isSignup) {
    // Disconnecting the sign-in account is allowed: revoke the grant at the
    // provider (Google supports programmatic revoke; Microsoft revocation is
    // done from the user's Microsoft account page), delete all related
    // connection rows, and end the session since the login identity is gone.
    try {
      if (service === "google") {
        const { data: rows } = await supabase.from("connections")
          .select("service, tokens").eq("user_id", userId).like("service", "google%");
        for (const r of (rows || [])) {
          if (r.tokens) await revokeGoogleGrant(r.tokens);
        }
        await supabase.from("connections").delete().eq("user_id", userId).like("service", "google%");
      } else {
        await mustWrite("could not disconnect that service", supabase.from("connections").delete().eq("user_id", userId).eq("service", service));
      }
      res.setHeader("Set-Cookie", "ch_user=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
      return res.json({ success: true, signout: true });
    } catch (err) {
      console.error("Sign-in account disconnect error:", err.message);
      return res.status(500).json({ error: "Failed to disconnect" });
    }
  }

  try {
    await supabase
      .from("connections")
      .delete()
      .eq("user_id", userId)
      .eq("service", service);

    res.json({ success: true });
  } catch (err) {
    console.error("Disconnect error:", err.message);
    res.status(500).json({ error: "Failed to disconnect" });
  }
});

app.post("/api/disconnect-platform", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });

  const { platform } = req.body;
  if (!platform || !SUPPORTED_PLATFORMS[platform]) {
    return res.status(400).json({ error: "Invalid platform" });
  }

  try {
    await supabase
      .from("chat_links")
      .delete()
      .eq("user_id", userId)
      .eq("platform", platform);

    res.json({ success: true });
  } catch (err) {
    console.error("Platform disconnect error:", err.message);
    res.status(500).json({ error: "Failed to disconnect platform" });
  }
});

// --- Pulse settings ---

app.get("/api/pulse", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });

  try {
    // Read dashboard pulse settings from profiles.settings (reliable JSONB column)
    const { data: profile } = await supabase
      .from("profiles")
      .select("settings")
      .eq("id", userId)
      .single();

    const ps = profile?.settings?.pulse_settings || {};

    // Read enabled state from pulse_config (operational table the bot uses)
    const { data: pulseRow } = await supabase
      .from("pulse_config")
      .select("enabled, interval_minutes, quiet_hours_start, quiet_hours_end")
      .eq("user_id", userId)
      .maybeSingle();

    // proactiveLevel from profile settings is the single source of truth
    const level = ps.proactiveLevel || (pulseRow?.enabled ? "medium" : "off");

    // Auto-enrol: no explicit choice defaults to the user's first linked chat
    // app, PERSISTED so the delivery engine's "only selected apps" rule and
    // the UI always agree. (WhatsApp is a valid choice: proactive messages
    // reach it while Meta's 24h customer-service window is open, and skip it
    // otherwise — see bot lib/proactive.js.)
    let deliveryPlatforms = ps.deliveryPlatforms || [];
    if (!deliveryPlatforms.length) {
      const { data: links } = await supabase
        .from("chat_links").select("platform").eq("user_id", userId);
      if (links && links.length) {
        deliveryPlatforms = [links[0].platform];
        const settingsObj = profile?.settings || {};
        settingsObj.pulse_settings = { ...(settingsObj.pulse_settings || {}), deliveryPlatforms };
        await supabase.from("profiles").update({ settings: settingsObj }).eq("id", userId).then(() => {}, () => {});
      }
    }

    res.json({
      enabled: level !== "off",
      proactiveLevel: level,
      intervalMinutes: pulseRow?.interval_minutes ?? 30,
      quietStart: ps.quietStart ?? pulseRow?.quiet_hours_start ?? 22,
      quietEnd: ps.quietEnd ?? pulseRow?.quiet_hours_end ?? 7,
      quietEnabled: ps.quietEnabled !== false,
      deliveryPlatforms,
      // Send confirmation preference lives on the same settings object; surface
      // it here so the settings tab can render the toggle in one fetch.
      confirmSends: profile?.settings?.require_send_confirmation !== false,
    });
  } catch (err) {
    console.error("Pulse config error:", err.message);
    res.status(500).json({ error: "Failed to load pulse config" });
  }
});

// Toggle whether ClosedHand confirms before sending email on the user's behalf
// (chat and background agents). Default on; off is opt-in for bulk senders.
app.post("/api/settings/confirm-sends", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not authenticated" });
  try {
    const { enabled } = req.body;
    const { data: profile } = await supabase.from("profiles").select("settings").eq("id", userId).single();
    const settings = profile?.settings || {};
    settings.require_send_confirmation = enabled !== false;
    const { error } = await supabase.from("profiles").update({ settings, updated_at: new Date().toISOString() }).eq("id", userId);
    if (error) throw error;
    res.json({ success: true, confirmSends: settings.require_send_confirmation });
  } catch (e) {
    console.error("confirm-sends save error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/pulse", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });

  const { proactiveLevel, quietStart, quietEnd, quietEnabled, deliveryPlatforms } = req.body;

  // Map level to interval and enabled state
  const levels = {
    off: { enabled: false, interval_minutes: 30 },
    low: { enabled: true, interval_minutes: 60 },
    medium: { enabled: true, interval_minutes: 30 },
    high: { enabled: true, interval_minutes: 15 },
  };

  const setting = levels[proactiveLevel];
  if (!setting) return res.status(400).json({ error: "Invalid level" });

  // Validate deliveryPlatforms — must be array of connected platform names.
  // WhatsApp is allowed: the bot delivers there only while Meta's 24h
  // customer-service window is open, and skips it otherwise.
  const validPlatforms = Object.keys(SUPPORTED_PLATFORMS);
  const platforms = Array.isArray(deliveryPlatforms)
    ? deliveryPlatforms.filter(p => validPlatforms.includes(p))
    : [];

  const safeQuietStart = typeof quietStart === "number" ? Math.max(0, Math.min(23, quietStart)) : 22;
  const safeQuietEnd = typeof quietEnd === "number" ? Math.max(0, Math.min(23, quietEnd)) : 7;

  try {
    // 1. Save dashboard settings to profiles.settings.pulse_settings (JSONB — always works)
    const { data: profile } = await supabase
      .from("profiles")
      .select("settings")
      .eq("id", userId)
      .single();

    const currentSettings = profile?.settings || {};
    const prevPulse = currentSettings.pulse_settings || {};
    // Merge: a request that omits deliveryPlatforms must not wipe them
    currentSettings.pulse_settings = {
      proactiveLevel,
      quietStart: safeQuietStart,
      quietEnd: safeQuietEnd,
      quietEnabled: quietEnabled !== false,
      deliveryPlatforms: Array.isArray(deliveryPlatforms) ? platforms : (prevPulse.deliveryPlatforms || []),
    };

    const { error: profileError } = await supabase
      .from("profiles")
      .update({ settings: currentSettings, updated_at: new Date().toISOString() })
      .eq("id", userId);

    if (profileError) {
      console.error(`Pulse profile save error for ${userId}:`, profileError.message);
      throw profileError;
    }

    // 2. Sync core fields to pulse_config for the bot (only columns that definitely exist)
    const { error: pulseError } = await supabase
      .from("pulse_config")
      .upsert({
        user_id: userId,
        enabled: setting.enabled,
        interval_minutes: setting.interval_minutes,
        quiet_hours_start: safeQuietStart,
        quiet_hours_end: safeQuietEnd,
      }, { onConflict: "user_id" });

    if (pulseError) {
      console.error(`Pulse config sync error for ${userId}:`, pulseError.message);
      // Non-fatal — dashboard settings already saved to profiles
    }

    console.log(`Pulse saved for ${userId}: level=${proactiveLevel}, quiet=${safeQuietStart}-${safeQuietEnd}, platforms=${platforms.join(",") || "none"}`);
    res.json({ success: true });
  } catch (err) {
    console.error("Pulse save error:", err.message);
    res.status(500).json({ error: "Failed to save pulse config" });
  }
});

// ============================================================
// AGENTS — Mission Control API
// ============================================================

// GET /api/connections/scopes — which connected Google accounts are missing
// permissions the app now asks for.
//
// Scope changes do not apply to grants already issued, and each extra account
// holds its own, so an account can silently sit on an older permission set. The
// only symptom is a confusing failure much later, which is exactly what
// happened when a draft edit landed in the wrong mailbox because the account
// holding it could not write drafts.
app.get("/api/connections/scopes", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });

  const REQUIRED = (SERVICES.google.scopes || []).filter(s => s.includes("/auth/"));
  const LABELS = {
    "gmail.readonly": "read your email",
    "gmail.compose": "write and send email, and edit drafts",
    "calendar.events": "read and change calendar events",
    "drive.readonly": "read your Drive files",
    "drive.file": "manage files it creates in your Drive",
  };

  try {
    const { data: conns } = await supabase
      .from("connections").select("service, tokens, metadata")
      .eq("user_id", userId).like("service", "google%");

    const out = [];
    for (const c of (conns || [])) {
      let granted = [];
      try {
        const toks = require("./crypto-tokens").decryptTokens(c.tokens);
        const body = new URLSearchParams({
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          refresh_token: toks.refresh_token,
          grant_type: "refresh_token",
        });
        const tok = await (await fetch("https://oauth2.googleapis.com/token", { method: "POST", body })).json();
        if (tok.access_token) {
          const info = await (await fetch("https://oauth2.googleapis.com/tokeninfo?access_token=" + tok.access_token)).json();
          granted = String(info.scope || "").split(" ").filter(Boolean);
        }
      } catch (_) { /* treat as unknown rather than as missing */ }

      if (granted.length === 0) continue;
      const missing = REQUIRED.filter(r => !granted.includes(r));
      out.push({
        service: c.service,
        email: c.metadata?.email || null,
        needs_reconnect: missing.length > 0,
        missing: missing.map(m => {
          const short = m.split("/auth/")[1];
          return { scope: short, label: LABELS[short] || short };
        }),
      });
    }
    res.json(out);
  } catch (err) {
    console.error("Scope check error:", err.message);
    res.status(500).json({ error: "Failed to check permissions" });
  }
});

// GET /api/agents — list user's recent agent tasks
app.get("/api/agents", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });

  try {
    const { data, error } = await supabase
      .from("agent_tasks")
      .select("id, goal, title, status, model, result, progress, tools_used, error, created_at, completed_at, result_edited_at")
      .eq("user_id", userId)
      .in("status", ["running", "pending", "completed", "failed", "cancelled"])
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("Agents list error:", err.message);
    res.status(500).json({ error: "Failed to load agents" });
  }
});

// GET /api/agents/stats — aggregate metrics for mission control
app.get("/api/agents/stats", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const { data: tasks, error } = await supabase
      .from("agent_tasks")
      .select("status, created_at, completed_at")
      .eq("user_id", userId);

    if (error) throw error;

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

    const active = tasks.filter(t => t.status === "running" || t.status === "pending").length;
    const completedToday = tasks.filter(t => t.status === "completed" && t.completed_at && t.completed_at >= todayStart).length;
    const completedTotal = tasks.filter(t => t.status === "completed").length;
    const failed = tasks.filter(t => t.status === "failed").length;

    // Average duration of completed tasks
    let avgDuration = 0;
    const completed = tasks.filter(t => t.status === "completed" && t.created_at && t.completed_at);
    if (completed.length > 0) {
      const totalMs = completed.reduce((sum, t) => sum + (new Date(t.completed_at) - new Date(t.created_at)), 0);
      avgDuration = Math.round(totalMs / completed.length / 1000);
    }

    res.json({ active, completedToday, completedTotal, failed, avgDuration });
  } catch (e) {
    console.error("Agent stats error:", e);
    res.status(500).json({ error: "Failed to load stats" });
  }
});

// DELETE /api/agents/:id — clear a finished run from the list
// POST /api/agents/:id/stop — mark a running agent cancelled. The bot's run
// loop checks status between iterations, halts, and confirms in the chat the
// agent belongs to, so the user hears "stopped" where they were talking.
app.post("/api/agents/:id/stop", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not authenticated" });
  try {
    const { data } = await supabase.from("agent_tasks")
      .update({ status: "cancelled", completed_at: new Date().toISOString() })
      .eq("id", req.params.id).eq("user_id", userId)
      .in("status", ["running", "pending"])
      .select("id");
    if (!data || data.length === 0) return res.status(404).json({ error: "No running agent with that id" });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/agents/:id", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });
  try {
    // Only finished runs: deleting a row out from under a live agent would
    // leave it writing progress to something that no longer exists.
    const { error } = await supabase
      .from("agent_tasks")
      .delete()
      .eq("id", req.params.id)
      .eq("user_id", userId)
      .in("status", ["completed", "failed", "cancelled"]);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error("Agent delete error:", err.message);
    res.status(500).json({ error: "Failed to delete" });
  }
});

// GET /api/agents/:id — get full agent result
app.get("/api/agents/:id", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });

  try {
    const { data: task, error } = await supabase
      .from("agent_tasks")
      .select("id, user_id, goal, status, model, result, progress, tools_used, error, created_at, completed_at")
      .eq("id", req.params.id)
      .single();

    if (error || !task) return res.status(404).json({ error: "Agent not found" });
    if (task.user_id !== userId) return res.status(403).json({ error: "Not authorized" });

    res.json(task);
  } catch (err) {
    console.error("Agent fetch error:", err.message);
    res.status(500).json({ error: "Failed to load agent" });
  }
});

// GET /api/agents/:id/pdf — a finished run's output, typeset for download.
// The web view renders the same markdown dialect; this is the take-away copy.
app.get("/api/agents/:id/pdf", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });

  try {
    const { data: run, error } = await supabase
      .from("agent_tasks")
      .select("id, user_id, goal, title, status, result, created_at, completed_at, result_edited_at")
      .eq("id", req.params.id)
      .single();

    if (error || !run) return res.status(404).json({ error: "Agent not found" });
    if (run.user_id !== userId) return res.status(403).json({ error: "Not authorized" });
    if (!run.result) return res.status(409).json({ error: "This run has no output to download yet" });

    const { runPdf, runTitle } = require("./run-pdf");
    const date = String(run.completed_at || run.created_at || "").substring(0, 10);
    const safe = runTitle(run).replace(/[^\w\s-]/g, "").replace(/\s+/g, " ").trim().substring(0, 60) || "run";
    // ?view=1 shows the same document in the browser's own PDF viewer instead
    // of downloading it; the filename still applies if they save from there.
    const disposition = req.query.view === "1" ? "inline" : "attachment";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `${disposition}; filename="ClosedHand - ${safe}${date ? ` - ${date}` : ""}.pdf"`);
    runPdf(run).pipe(res);
  } catch (err) {
    console.error("Agent PDF error:", err.message);
    res.status(500).json({ error: "Could not build the PDF" });
  }
});

// POST /api/agents/:id/cancel — cancel a running agent
app.post("/api/agents/:id/cancel", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });

  try {
    const { data: task, error: fetchErr } = await supabase
      .from("agent_tasks")
      .select("user_id, status")
      .eq("id", req.params.id)
      .single();

    if (fetchErr || !task) return res.status(404).json({ error: "Agent not found" });
    if (task.user_id !== userId) return res.status(403).json({ error: "Not authorized" });
    if (task.status !== "running") return res.status(400).json({ error: "Agent is not running" });

    const { error } = await supabase
      .from("agent_tasks")
      .update({ status: "cancelled", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", req.params.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error("Agent cancel error:", err.message);
    res.status(500).json({ error: "Failed to cancel agent" });
  }
});

// DELETE /api/agents/:id — delete an agent record
app.delete("/api/agents/:id", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });

  try {
    const { data: task, error: fetchErr } = await supabase
      .from("agent_tasks")
      .select("user_id")
      .eq("id", req.params.id)
      .single();

    if (fetchErr || !task) return res.status(404).json({ error: "Agent not found" });
    if (task.user_id !== userId) return res.status(403).json({ error: "Not authorized" });

    const { error } = await supabase
      .from("agent_tasks")
      .delete()
      .eq("id", req.params.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error("Agent delete error:", err.message);
    res.status(500).json({ error: "Failed to delete agent" });
  }
});

// POST /api/agents — create a new agent task from the dashboard
app.post("/api/agents", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const { goal } = req.body;
    if (!goal || typeof goal !== "string" || goal.trim().length < 3) {
      return res.status(400).json({ error: "Please provide a task description" });
    }

    // Check concurrency limit
    const { data: running } = await supabase
      .from("agent_tasks")
      .select("id")
      .eq("user_id", userId)
      .eq("status", "running");

    if (running && running.length >= 8) {
      return res.status(429).json({ error: "Too many active agents. Wait for some to complete." });
    }

    // Create a pending task in Supabase — the bot process picks it up
    const { data: task, error: insertErr } = await supabase
      .from("agent_tasks")
      .insert({
        user_id: userId,
        goal: goal.trim(),
        model: "pending",
        platform: "dashboard",
        chat_id: "dashboard",
        status: "pending",
        progress: [],
        messages: [],
        tools_used: [],
      })
      .select()
      .single();

    if (insertErr) throw insertErr;

    res.json({ success: true, taskId: task.id, model: "pending" });
  } catch (e) {
    console.error("Create agent error:", e);
    res.status(500).json({ error: "Failed to create agent task" });
  }
});

// ============================================================
// AUTOMATIONS
// ============================================================

// List saved automations
app.get("/api/automations", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const { data, error } = await supabase
      .from("automations")
      .select("id, name, description, status, trigger_type, trigger_cron, trigger_human_schedule, trigger_event_source, trigger_event_condition, task_model, task_use_cloud, output_urgent, output_destinations, chain_target_id, created_at, updated_at")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false });
    if (error) throw error;

    // Attach latest run status to each automation
    const autos = data || [];
    if (autos.length > 0) {
      const { data: runs } = await supabase
        .from("automation_runs")
        .select("automation_id, status")
        .eq("user_id", userId)
        .in("status", ["running", "pending"])
        .order("started_at", { ascending: false });
      if (runs) {
        for (const auto of autos) {
          const activeRun = runs.find(r => r.automation_id === auto.id);
          if (activeRun) auto.latest_run = { status: activeRun.status };
        }
      }
    }

    res.json(autos);
  } catch (e) {
    console.error("List automations error:", e);
    res.status(500).json({ error: "Failed to load automations" });
  }
});

// Stats
// --- Team Projects API ---




app.get("/api/automations/stats", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    // Agents run from two places: a saved one on its trigger, and a one-off
    // started from chat. Counting only the first said "last activity 130 days
    // ago" on a day something had run overnight, because the saved agent had
    // not run since March while chat had been busy throughout.
    const [runsRes, autosRes, tasksRes] = await Promise.all([
      supabase.from("automation_runs").select("status, started_at, completed_at").eq("user_id", userId),
      supabase.from("automations").select("id, status").eq("user_id", userId),
      supabase.from("agent_tasks").select("status, created_at, completed_at").eq("user_id", userId),
    ]);

    const runs = runsRes.data || [];
    const autos = autosRes.data || [];
    const tasks = tasksRes.data || [];
    const todayStart = new Date(new Date().setHours(0,0,0,0)).toISOString();

    // Running means running, not enabled. The old count was of saved agents
    // with status active, which is whether a trigger is armed.
    // A run left marked running by a crash or a redeploy stays that way for
    // ever, and one from March was keeping this card on 1 with nothing
    // running. The bot restarts on every deploy, so anything that claims to
    // have been going for hours is not going at all.
    const staleBefore = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
    const liveish = (t) => t && t > staleBefore;
    const running = tasks.filter(t => (t.status === "running" || t.status === "pending") && liveish(t.created_at)).length
      + runs.filter(r => r.status === "running" && liveish(r.started_at)).length;
    const savedCount = autos.length;
    const runsToday = runs.filter(r => r.started_at >= todayStart).length
      + tasks.filter(t => t.created_at >= todayStart).length;

    let lastActivity = null;
    for (const t of [...runs.map(r => r.completed_at || r.started_at),
                     ...tasks.map(t => t.completed_at || t.created_at)]) {
      if (t && (!lastActivity || t > lastActivity)) lastActivity = t;
    }

    res.json({ running, savedCount, runsToday, lastActivity });
  } catch (e) {
    console.error("Automation stats error:", e);
    res.status(500).json({ error: "Failed to load stats" });
  }
});

// Create saved automation
app.post("/api/automations", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const { name, description, trigger_type, trigger_cron, trigger_timezone, trigger_human_schedule,
      trigger_event_source, trigger_event_condition, task_prompt, task_model, task_tools,
      task_use_cloud, output_destinations, output_urgent, chain_target_id } = req.body;

    if (!name || !task_prompt) return res.status(400).json({ error: "Name and task prompt required" });

    let fullPrompt = task_prompt;
    if (req.body.quality_check) {
      fullPrompt += '\n\nQUALITY CHECK: Before delivering results, verify against these criteria: ' + req.body.quality_check + '. If any criteria fail, iterate and improve before reporting.';
    }

    const { data, error } = await supabase
      .from("automations")
      .insert({
        user_id: userId, name: name.trim(), description: description || "",
        status: trigger_type === "manual" ? "idle" : "active",
        trigger_type: trigger_type || "manual",
        trigger_cron: trigger_cron || null, trigger_timezone: trigger_timezone || "Europe/London",
        trigger_human_schedule: trigger_human_schedule || null,
        trigger_event_source: trigger_event_source || null,
        trigger_event_condition: trigger_event_condition || null,
        task_prompt: fullPrompt, task_model: task_model || "sonnet",
        task_tools: task_tools || [], task_use_cloud: task_use_cloud || false,
        task_max_duration: 900,
        output_destinations: output_destinations || ["chat_platforms", "dashboard"],
        output_urgent: output_urgent || false,
        chain_target_id: chain_target_id || null,
        platform: "dashboard", chat_id: null,
      })
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (e) {
    console.error("Create automation error:", e);
    if (e.message?.includes("duplicate")) return res.status(409).json({ error: "An automation with that name already exists" });
    res.status(500).json({ error: "Failed to create automation" });
  }
});

// Update automation
app.put("/api/automations/:id", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const { data, error } = await supabase
      .from("automations")
      .update({ ...req.body, updated_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .eq("user_id", userId)
      .select()
      .single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Not found" });
    res.json(data);
  } catch (e) {
    console.error("Update automation error:", e.message || e);
    res.status(500).json({ error: e.message || "Failed to update" });
  }
});

// Delete automation
app.delete("/api/automations/:id", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const { data, error } = await supabase
      .from("automations")
      .delete()
      .eq("id", req.params.id)
      .eq("user_id", userId)
      .select();
    if (error) throw error;
    if (!data?.length) return res.status(404).json({ error: "Not found" });
    res.json({ success: true });
  } catch (e) {
    console.error("Delete automation error:", e);
    res.status(500).json({ error: "Failed to delete" });
  }
});

// Trigger a run (inserts pending record, bot picks it up)
app.post("/api/automations/:id/run", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    // Verify automation exists and belongs to user
    const { data: auto } = await supabase
      .from("automations")
      .select("id, name, task_model")
      .eq("id", req.params.id)
      .eq("user_id", userId)
      .single();
    if (!auto) return res.status(404).json({ error: "Not found" });

    // Check concurrency
    const { data: running } = await supabase
      .from("automation_runs")
      .select("id")
      .eq("user_id", userId)
      .in("status", ["running", "pending"]);
    if (running && running.length >= 8) {
      return res.status(429).json({ error: "Too many active runs. Wait for some to complete." });
    }

    // Create pending run
    const { data: run, error } = await supabase
      .from("automation_runs")
      .insert({
        automation_id: auto.id, user_id: userId,
        status: "pending", model: "pending",
        triggered_by: "manual", platform: "dashboard", chat_id: "dashboard",
        progress: [], messages: [], tools_used: [],
      })
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, runId: run.id });
  } catch (e) {
    console.error("Trigger run error:", e);
    res.status(500).json({ error: "Failed to start run" });
  }
});

// Pause automation
app.post("/api/automations/:id/pause", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const { data, error } = await supabase
      .from("automations")
      .update({ status: "paused", updated_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .eq("user_id", userId)
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Failed to pause" });
  }
});

// Resume automation
app.post("/api/automations/:id/resume", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const { data, error } = await supabase
      .from("automations")
      .update({ status: "active", updated_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .eq("user_id", userId)
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Failed to resume" });
  }
});

// Run history for an automation
app.get("/api/automations/:id/runs", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const { data, error } = await supabase
      .from("automation_runs")
      .select("id, status, model, tools_used, output_summary, error, started_at, completed_at, duration_secs, triggered_by")
      .eq("automation_id", req.params.id)
      .eq("user_id", userId)
      .order("started_at", { ascending: false })
      .limit(20);
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: "Failed to load history" });
  }
});

// Single run detail
app.get("/api/automations/runs/:runId", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const { data, error } = await supabase
      .from("automation_runs")
      .select("id, automation_id, status, model, tools_used, progress, input_context, output_summary, full_report, error, started_at, completed_at, duration_secs, triggered_by, chain_source_id, messages")
      .eq("id", req.params.runId)
      .eq("user_id", userId)
      .single();
    if (error || !data) return res.status(404).json({ error: "Not found" });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "Failed to load run" });
  }
});

// Quick run (one-off, no saved automation)
app.post("/api/automations/quick-run", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const { prompt } = req.body;
    if (!prompt || typeof prompt !== "string" || prompt.trim().length < 3) {
      return res.status(400).json({ error: "Please describe what you want done" });
    }

    // Check concurrency
    const { data: running } = await supabase
      .from("automation_runs")
      .select("id")
      .eq("user_id", userId)
      .in("status", ["running", "pending"]);
    if (running && running.length >= 8) {
      return res.status(429).json({ error: "Too many active runs" });
    }

    const { data: run, error } = await supabase
      .from("automation_runs")
      .insert({
        automation_id: null, user_id: userId,
        status: "pending", model: "pending",
        triggered_by: "quick_run",
        input_context: prompt.trim(),
        platform: "dashboard", chat_id: "dashboard",
        progress: [], messages: [], tools_used: [],
      })
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, runId: run.id });
  } catch (e) {
    console.error("Quick run error:", e);
    res.status(500).json({ error: "Failed to start task" });
  }
});

// ============================================================
// SKILLS
// ============================================================

// List installed skills
app.get("/api/skills", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const { data, error } = await supabase
      .from("user_skills")
      .select("id, name, description, source_url, category, installed_at")
      .eq("user_id", userId)
      .order("installed_at", { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: "Failed to load skills" });
  }
});

// Install skill from URL
app.post("/api/skills/install", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "URL required" });

    // Fetch the markdown file
    // Convert GitHub URLs to raw content URLs
    let rawUrl = url;
    if (url.includes("github.com") && !url.includes("raw.githubusercontent.com")) {
      rawUrl = url
        .replace("github.com", "raw.githubusercontent.com")
        .replace("/blob/", "/");
    }

    const response = await fetch(rawUrl);
    if (!response.ok) return res.status(400).json({ error: "Could not fetch skill from URL" });
    const content = await response.text();

    if (content.length > 50000) return res.status(400).json({ error: "Skill file too large (max 50KB)" });
    if (!content.trim()) return res.status(400).json({ error: "Empty file" });

    // Extract name and description from frontmatter or first heading
    let name = "custom-skill";
    let description = "";
    const headingMatch = content.match(/^#\s+(.+)/m);
    if (headingMatch) name = headingMatch[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").substring(0, 50);
    const descMatch = content.match(/^(?:#+\s+.+\n+)?(.{10,200})/m);
    if (descMatch) description = descMatch[1].trim().substring(0, 200);

    // AI security scan
    const scan = await scanSkillContent(content);
    console.log(`[security-scan] Skill "${name}" from ${url}: ${scan.risk_level} - ${scan.summary}`);

    if (scan.risk_level === "blocked") {
      return res.json({ blocked: true, scan });
    }
    if (scan.risk_level === "warning" && !req.body.accept_warnings) {
      return res.json({ needs_confirmation: true, scan });
    }

    // Save to Supabase
    const { data, error } = await supabase
      .from("user_skills")
      .upsert({
        user_id: userId,
        name,
        description,
        source_url: url,
        content,
        category: "community",
      }, { onConflict: "user_id,name" })
      .select()
      .single();
    if (error) throw error;

    res.json({
      success: true,
      skill: { id: data.id, name: data.name, description: data.description },
      warnings: redFlags.length > 0 ? redFlags : undefined
    });
  } catch (e) {
    console.error("Skill install error:", e);
    res.status(500).json({ error: "Failed to install skill" });
  }
});

// Delete installed skill
app.delete("/api/skills/:id", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const { error } = await supabase
      .from("user_skills")
      .delete()
      .eq("id", req.params.id)
      .eq("user_id", userId);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Failed to delete skill" });
  }
});

// ============================================================
// USER MCP CONNECTIONS
// ============================================================

app.get("/api/mcps", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const { data, error } = await supabase
      .from("user_mcps")
      .select("id, name, server_url, auth_type, status, tools_discovered, installed_via, logo_url, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: "Failed to load MCP connections" });
  }
});

// An MCP server announces itself in its initialize reply, which is where its
// real name lives: "Notion MCP" rather than whatever its hostname happens to
// spell. The reply may come back as plain JSON or as an SSE frame, so both
// shapes have to be read.
async function readServerInfo(response) {
  try {
    const raw = await response.text();
    for (const line of raw.split(/\r?\n/)) {
      const t = line.replace(/^data:\s*/, "").trim();
      if (!t.startsWith("{")) continue;
      try {
        const d = JSON.parse(t);
        if (d.result && d.result.serverInfo) return d.result.serverInfo;
      } catch { /* next frame */ }
    }
  } catch { /* fall back to the URL */ }
  return null;
}

// Half of what servers declare is a product name and half is a package id:
// "Notion MCP" and "DeepWiki" alongside "docs-ai-search" and
// "@huggingface/mcp-service". Rules that tell those apart end up as a list of
// suffixes to strip, which the next server breaks. Ask instead, once, at
// connect time, and give it the address and the tools as well as the declared
// name, since between them they identify the product even when the name does
// not. Failure just falls through to the older answers.
async function nameViaModel(serverInfo, serverUrl, toolNames) {
  if (!process.env.XAI_API_KEY) return null;
  try {
    const r = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.XAI_API_KEY },
      body: JSON.stringify({
        model: "grok-4.5",
        max_tokens: 16,
        messages: [
          { role: "system", content: "You name a connection in a list of the user's connected services. Reply with the product or company name only, nothing else. Two or three words at most. Use the brand as it is normally written. Ignore packaging noise like mcp, server, service, api, stdio, scoped npm prefixes and version numbers. If nothing identifiable is on offer, reply with the domain name." },
          { role: "user", content: `URL: ${serverUrl}\nName it reports: ${(serverInfo?.name || "(none)")}\nTools: ${(toolNames || []).slice(0, 12).join(", ") || "(unknown)"}` },
        ],
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const out = String(j?.choices?.[0]?.message?.content || "").trim().replace(/^["']|["']$/g, "");
    // A name, not a sentence. Anything else means it misunderstood, and the
    // fallbacks are perfectly good.
    if (!out || out.length > 40 || out.split(/\s+/).length > 4 || /[\n<>{}]/.test(out)) return null;
    return out;
  } catch { return null; }
}

// Copy a connection's icon into our own storage.
//
// Two reasons not to point the dashboard straight at the server's URL: it
// tells that server every time the user opens their dashboard, and the image
// then changes or disappears whenever they feel like it. Fetch once, keep our
// own copy.
//
// The address comes from the MCP server, so it is treated as hostile: https
// only, no private or loopback addresses, must actually return an image, and
// it is capped well below anything a logo needs.
const ICON_TYPES = {
  "image/svg+xml": "svg", "image/png": "png", "image/jpeg": "jpg",
  "image/webp": "webp", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico",
};

async function fetchIcon(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    // Names that resolve inward are the whole SSRF trick.
    if (/^(localhost$|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1)/i.test(u.hostname)) return null;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname)) return null;
    const r = await fetch(u.toString(), { redirect: "follow", signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const type = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const ext = ICON_TYPES[type];
    if (!ext) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 262144) return null;
    return { buf, ext, type };
  } catch { return null; }
}

async function storeMcpIcon(serverInfo, serverUrl) {
  // What the connection ships with, and failing that the site's own favicon,
  // which is the same picture the user sees in their browser tab.
  const declared = serverInfo?.icons?.[0]?.src;
  const candidates = [];
  if (declared) {
    try { candidates.push(new URL(declared, serverUrl).toString()); } catch { /* ignore */ }
  }
  try {
    const host = new URL(serverUrl).hostname.replace(/^(www|mcp|api|server|remote)\./, "");
    candidates.push(`https://${host}/favicon.ico`);
  } catch { /* ignore */ }

  for (const c of candidates) {
    const got = await fetchIcon(c);
    if (!got) continue;
    try {
      const key = `mcp/${crypto.createHash("sha1").update(serverUrl).digest("hex").slice(0, 16)}.${got.ext}`;
      const { error } = await supabase.storage.from("logos")
        .upload(key, got.buf, { contentType: got.type, upsert: true });
      if (error) { console.log("[mcp-icon] upload failed:", error.message); return null; }
      return supabase.storage.from("logos").getPublicUrl(key).data.publicUrl;
    } catch (e) { console.log("[mcp-icon] store failed:", e.message); return null; }
  }
  return null;
}

async function resolveMcpName(serverInfo, serverUrl, toolNames) {
  return (await nameViaModel(serverInfo, serverUrl, toolNames)) || mcpDisplayName(serverInfo, serverUrl);
}

// What to call the connection: what it calls itself, and only failing that,
// what its address suggests.
function mcpDisplayName(serverInfo, serverUrl) {
  const declared = String(serverInfo?.name || "").trim();
  if (declared) return declared.length > 60 ? declared.slice(0, 60) : declared;
  return mcpNameFromUrl(serverUrl);
}

// Mirrors mcpNameFromUrl in the dashboard. A custom connection is named after
// its own address, because the name the server declares in its initialize
// handshake is not readable until after OAuth, and the name is needed before it.
function mcpNameFromUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^(www|mcp|api|server|remote)\./, "");
    const label = host.split(".")[0] || "custom";
    return label.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  } catch { return "Custom"; }
}

app.post("/api/mcps", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const { server_url, auth_token, auth_type } = req.body;
    if (!server_url) return res.status(400).json({ error: "Server URL required" });
    // The name is no longer asked for, so an absent one is normal, not an error.
    // Validate URL
    try {
      const parsed = new URL(server_url);
      if (parsed.protocol !== "https:") return res.status(400).json({ error: "HTTPS required for MCP servers" });
    } catch { return res.status(400).json({ error: "Invalid URL" }); }

    // Try to discover tools and scan for security issues
    let scanResult = null;
    let declaredInfo = null;
    let declaredTools = [];
    try {
      const headers = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" };
      if (auth_token) {
        if ((auth_type || "bearer") === "bearer" || auth_type === "oauth") headers["Authorization"] = "Bearer " + auth_token;
        else if (auth_type === "header") headers["x-api-key"] = auth_token;
      }
      const baseUrl = server_url.trim().replace(/\/+$/, "");
      // Initialize session
      const initResp = await fetch(baseUrl, {
        method: "POST", headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "ClosedHand", version: "1.0.0" } } }),
        signal: AbortSignal.timeout(10000),
      });
      if (initResp.ok) {
        const sessionId = initResp.headers.get("mcp-session-id");
        if (sessionId) headers["Mcp-Session-Id"] = sessionId;
        declaredInfo = await readServerInfo(initResp);
        // List tools
        const toolsResp = await fetch(baseUrl, {
          method: "POST", headers,
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
          signal: AbortSignal.timeout(10000),
        });
        if (toolsResp.ok) {
          const toolsData = await toolsResp.json();
          const tools = toolsData.result?.tools || toolsData.tools || [];
          declaredTools = tools.map((t) => t.name).filter(Boolean);
          if (tools.length > 0) {
            scanResult = await scanMcpTools(tools);
            console.log(`[security-scan] MCP "${mcpDisplayName(declaredInfo, server_url)}" ${server_url}: ${scanResult.risk_level} - ${scanResult.summary}`);
          }
        }
      }
    } catch (e) {
      console.log("[security-scan] MCP tool discovery failed (will scan later):", e.message);
    }

    if (scanResult?.risk_level === "blocked") {
      return res.json({ blocked: true, scan: scanResult });
    }
    if (scanResult?.risk_level === "warning" && !req.body.accept_warnings) {
      return res.json({ needs_confirmation: true, scan: scanResult });
    }

    const { data, error } = await supabase
      .from("user_mcps")
      .upsert({
        user_id: userId,
        // What the server calls itself, or its address if it said nothing.
        // An explicit name from the caller still wins, for API clients.
        name: String(req.body.name || "").trim() || await resolveMcpName(declaredInfo, server_url, declaredTools),
        logo_url: await storeMcpIcon(declaredInfo, server_url),
        server_url: server_url.trim(),
        auth_token: auth_token || null,
        auth_type: auth_type || "bearer",
        status: "connected",
        installed_via: "manual",
      }, { onConflict: "user_id,server_url" })
      .select("id, name, server_url, status")
      .single();
    if (error) throw error;
    res.json(data);
  } catch (e) {
    console.error("Add MCP error:", e);
    res.status(500).json({ error: "Failed to add MCP connection" });
  }
});

app.delete("/api/mcps/:id", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const { error } = await supabase
      .from("user_mcps")
      .delete()
      .eq("id", req.params.id)
      .eq("user_id", userId);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Failed to delete MCP connection" });
  }
});

app.post("/api/mcps/:id/test", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const { data: mcp } = await supabase
      .from("user_mcps")
      .select("*")
      .eq("id", req.params.id)
      .eq("user_id", userId)
      .single();
    if (!mcp) return res.status(404).json({ error: "Not found" });

    // Try to discover tools
    const buildTestHeaders = (token) => {
      const h = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      };
      if (token) {
        if (mcp.auth_type === "bearer" || mcp.auth_type === "oauth") {
          h["Authorization"] = "Bearer " + token;
        } else if (mcp.auth_type === "header") {
          h["x-api-key"] = token;
        }
      }
      return h;
    };

    const baseUrl = mcp.server_url.replace(/\/+$/, "");

    // Parse an MCP response that may be JSON or SSE
    // SSE streams may stay open indefinitely, so we read incrementally
    // and return as soon as we get a JSON-RPC result/error.
    async function parseMcpResp(resp) {
      const ct = resp.headers.get("content-type") || "";
      if (ct.includes("text/event-stream")) {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const results = [];
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            // Parse any complete "data: ..." lines so far
            const lines = buffer.split("\n");
            // Keep the last (possibly incomplete) line in the buffer
            buffer = lines.pop();
            for (const line of lines) {
              if (line.startsWith("data: ")) {
                try { results.push(JSON.parse(line.slice(6))); } catch (e) {}
              }
            }
            // If we found a JSON-RPC result or error, we are done
            const match = results.find(r => r.result !== undefined || r.error !== undefined);
            if (match) {
              reader.cancel();
              return match;
            }
          }
        } catch (e) {
          // reader may throw on cancel, that is fine
          if (results.length === 0) throw e;
        }
        return results.find(r => r.result !== undefined || r.error !== undefined) || results[0] || {};
      }
      return resp.json();
    }

    // Full MCP handshake: initialize -> notify -> tools/list
    async function mcpHandshake(token) {
      const headers = buildTestHeaders(token);
      // Step 1: Initialize
      const initResp = await fetch(baseUrl, {
        method: "POST", headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
          protocolVersion: "2025-03-26", capabilities: {},
          clientInfo: { name: "ClosedHand", version: "1.0.0" },
        }}),
        signal: AbortSignal.timeout(10000),
      });
      if (!initResp.ok) return { ok: false, status: initResp.status };
      // Must consume the body (may be SSE stream)
      await parseMcpResp(initResp);
      const sessionId = initResp.headers.get("mcp-session-id");
      if (sessionId) headers["Mcp-Session-Id"] = sessionId;

      // Step 2: Notify initialized (fire and forget)
      fetch(baseUrl, {
        method: "POST", headers,
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});

      // Step 3: List tools
      const toolsResp = await fetch(baseUrl, {
        method: "POST", headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
        signal: AbortSignal.timeout(10000),
      });
      if (!toolsResp.ok) return { ok: false, status: toolsResp.status };
      const data = await parseMcpResp(toolsResp);
      return { ok: true, data };
    }

    let result = await mcpHandshake(mcp.auth_token);

    // If auth failed and OAuth, try refreshing the token
    if (!result.ok && mcp.auth_type === "oauth" && mcp.oauth_refresh_token && mcp.oauth_token_url && mcp.oauth_client_id) {
      try {
        const refreshBody = new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: mcp.oauth_refresh_token,
          client_id: mcp.oauth_client_id,
        });
        if (mcp.oauth_client_secret) refreshBody.set("client_secret", mcp.oauth_client_secret);

        const refreshResp = await fetch(mcp.oauth_token_url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: refreshBody.toString(),
          signal: AbortSignal.timeout(10000),
        });

        if (refreshResp.ok) {
          const tokens = await refreshResp.json();
          mcp.auth_token = tokens.access_token;
          const updateData = { auth_token: tokens.access_token };
          if (tokens.refresh_token) {
            mcp.oauth_refresh_token = tokens.refresh_token;
            updateData.oauth_refresh_token = tokens.refresh_token;
          }
          if (tokens.expires_in) {
            updateData.oauth_token_expiry = Date.now() + (tokens.expires_in * 1000);
          }
          await supabase.from("user_mcps").update(updateData).eq("id", mcp.id);
          console.log(`Refreshed MCP OAuth token for ${mcp.name} during test`);

          // Retry with new token
          result = await mcpHandshake(mcp.auth_token);
        }
      } catch (refreshErr) {
        console.error("MCP token refresh failed during test:", refreshErr.message);
      }
    }

    // If still failing after refresh
    if (!result.ok) {
      await supabase.from("user_mcps").update({ status: "error" }).eq("id", mcp.id);
      return res.json({ success: false, error: "Connection failed (status " + (result.status || "unknown") + "). Try removing and re-adding.", needs_auth: true });
    }

    const data = result.data || {};
    const tools = data.result?.tools || data.tools || [];
    const toolNames = tools.map(t => t.name);

    await mustWrite("could not save the MCP server", supabase.from("user_mcps").update({
      status: "connected",
      tools_discovered: toolNames
    }).eq("id", mcp.id));

    res.json({ success: true, tools: toolNames });
  } catch (e) {
    console.error("MCP test error:", e);
    res.json({ success: false, error: e.message });
  }
});

// POST /api/mcps/:id/fix — attempt to automatically fix a failing MCP
app.post("/api/mcps/:id/fix", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const { data: mcp } = await supabase
      .from("user_mcps")
      .select("*")
      .eq("id", req.params.id)
      .eq("user_id", userId)
      .single();
    if (!mcp) return res.status(404).json({ error: "Not found" });

    const maxAttempts = 3;
    let lastError = "";

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      console.log(`[MCP Fix] Attempt ${attempt}/${maxAttempts} for ${mcp.name}`);

      // Step 1: Refresh OAuth token if available
      if (mcp.auth_type === "oauth" && mcp.oauth_refresh_token && mcp.oauth_token_url && mcp.oauth_client_id) {
        try {
          const refreshBody = new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: mcp.oauth_refresh_token,
            client_id: mcp.oauth_client_id,
          });
          if (mcp.oauth_client_secret) refreshBody.set("client_secret", mcp.oauth_client_secret);
          const refreshResp = await fetch(mcp.oauth_token_url, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: refreshBody.toString(),
            signal: AbortSignal.timeout(10000),
          });
          if (refreshResp.ok) {
            const tokens = await refreshResp.json();
            const updateData = { auth_token: tokens.access_token };
            if (tokens.refresh_token) updateData.oauth_refresh_token = tokens.refresh_token;
            if (tokens.expires_in) updateData.oauth_token_expiry = Date.now() + (tokens.expires_in * 1000);
            await mustWrite("could not save the MCP server", supabase.from("user_mcps").update(updateData).eq("id", mcp.id));
            mcp.auth_token = tokens.access_token;
            if (tokens.refresh_token) mcp.oauth_refresh_token = tokens.refresh_token;
            console.log(`[MCP Fix] Token refreshed for ${mcp.name}`);
          } else {
            lastError = "Token refresh failed (" + refreshResp.status + ")";
            console.log(`[MCP Fix] ${lastError}`);
          }
        } catch (e) {
          lastError = "Token refresh error: " + e.message;
          console.log(`[MCP Fix] ${lastError}`);
        }
      }

      // Step 2: Call the test endpoint internally (it has all the SSE/handshake logic)
      try {
        const testUrl = `http://localhost:${PORT}/api/mcps/${mcp.id}/test`;
        const testResp = await fetch(testUrl, {
          method: "POST",
          headers: { "Cookie": req.headers.cookie || "" },
          signal: AbortSignal.timeout(25000),
        });
        const testResult = await testResp.json();
        if (testResult.success) {
          console.log(`[MCP Fix] Fixed on attempt ${attempt}! Found ${testResult.tools?.length || 0} tools for ${mcp.name}`);
          return res.json({ success: true, fixed: true, tools: testResult.tools, attempts: attempt });
        }
        lastError = testResult.error || "Test failed";
        console.log(`[MCP Fix] Test failed on attempt ${attempt}: ${lastError}`);
      } catch (e) {
        lastError = e.message;
        console.log(`[MCP Fix] Attempt ${attempt} error: ${lastError}`);
      }
    }

    // All attempts failed
    await supabase.from("user_mcps").update({ status: "error" }).eq("id", mcp.id);
    const needsReauth = mcp.auth_type === "oauth" && lastError.includes("401");
    res.json({ success: false, fixed: false, error: lastError, needs_reauth: needsReauth });
  } catch (e) {
    console.error("MCP debug error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// SCHEDULES & ACCOUNT MANAGEMENT
// ============================================================

// GET /api/schedules — list active cron jobs
app.get("/api/schedules", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });

  try {
    const { data, error } = await supabase
      .from("schedules")
      .select("name, cron_expression, task, created_at")
      .eq("user_id", userId)
      .eq("enabled", true);

    if (error) throw error;

    res.json((data || []).map(s => ({
      name: s.name,
      cron: s.cron_expression,
      task: s.task,
      createdAt: s.created_at,
    })));
  } catch (err) {
    console.error("Schedules fetch error:", err.message);
    res.status(500).json({ error: "Failed to load schedules" });
  }
});

// DELETE /api/schedules/:name — remove a schedule
app.delete("/api/schedules/:name", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });

  const name = decodeURIComponent(req.params.name);
  try {
    const { data, error } = await supabase
      .from("schedules")
      .delete()
      .eq("user_id", userId)
      .eq("name", name)
      .select();

    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: "Schedule not found" });

    res.json({ success: true });
  } catch (err) {
    console.error("Schedule delete error:", err.message);
    res.status(500).json({ error: "Failed to delete schedule" });
  }
});

// GET /api/reminders — the user's scheduled reminders
app.get("/api/reminders", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });
  try {
    const { data, error } = await supabase
      .from("schedules")
      .select("name, cron_expression, task, enabled, run_once, archived_at, timezone")
      .eq("user_id", userId)
      .order("name");
    if (error) throw error;
    // A cron line means nothing to the user; say when it actually fires, in
    // the timezone the schedule was created in. Fall back to the raw cron
    // only if the expression will not parse.
    const nextRunOf = (r) => {
      try {
        const tz = r.timezone || "Europe/London";
        const next = require("cron-parser").parseExpression(r.cron_expression, { tz }).next().toDate();
        return next.toLocaleString("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
      } catch (_) { return null; }
    };
    // Upcoming means things happening once, soon. Anything that repeats is an
    // agent and belongs in the agents list, or it would sit in both places
    // saying different things about itself. A cron pinned to one day and one
    // month is a single date, same rule the scheduler retires them by.
    const oneOff = (r) => {
      if (r.run_once === true) return true;
      if (r.run_once === false) return false;
      const f = String(r.cron_expression || "").trim().split(/\s+/);
      return f.length >= 5 && /^\d+$/.test(f[2]) && /^\d+$/.test(f[3]);
    };
    const rows = (data || []);
    // Live one-offs, plus the five most recently completed so the user can
    // look back at what ClosedHand did on their behalf.
    const live = rows.filter((r) => r.enabled && oneOff(r)).map((r) => ({ ...r, next_run: nextRunOf(r) }));
    const past = rows.filter((r) => !r.enabled && r.archived_at)
      .sort((a, b) => (b.archived_at || "").localeCompare(a.archived_at || ""))
      .slice(0, 5)
      .map((r) => ({ ...r, archived: true }));
    res.json(live.concat(past));
  } catch (e) {
    res.status(500).json({ error: "Failed to load reminders" });
  }
});

// GET /api/flights — tracked flights from notes
app.get("/api/flights", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });

  try {
    const { data, error } = await supabase
      .from("facts")
      .select("key, value")
      .eq("user_id", userId)
      .like("key", "flight-%");

    if (error) throw error;

    const cutoff = Date.now() - 24 * 3600000;
    const flights = (data || [])
      .map(row => {
        try {
          // Notes are wrapped: {"value": "<flight json>", created, ...}
          let f = JSON.parse(row.value);
          if (f && typeof f.value === "string") f = JSON.parse(f.value);
          f._key = row.key;
          return f;
        } catch { return null; }
      })
      .filter(f => {
        if (!f || !f.departure?.dateTime) return false;
        return new Date(f.departure.dateTime).getTime() > cutoff;
      })
      .sort((a, b) => new Date(a.departure.dateTime) - new Date(b.departure.dateTime));

    res.json(flights);
  } catch (err) {
    console.error("Flights fetch error:", err.message);
    res.status(500).json({ error: "Failed to load flights" });
  }
});

// GET /api/location — saved location from profile settings
app.get("/api/location", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });

  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("settings")
      .eq("id", userId)
      .single();

    if (error) throw error;
    res.json({ location: data?.settings?.location || null });
  } catch (err) {
    console.error("Location fetch error:", err.message);
    res.status(500).json({ error: "Failed to load location" });
  }
});

// PUT /api/location — save location to profile settings
app.put("/api/location", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });

  const { name, latitude, longitude } = req.body || {};
  if (!name || latitude == null || longitude == null) {
    return res.status(400).json({ error: "name, latitude, longitude required" });
  }

  try {
    const { data: profile, error: fetchErr } = await supabase
      .from("profiles")
      .select("settings")
      .eq("id", userId)
      .single();

    if (fetchErr) throw fetchErr;

    const currentSettings = profile?.settings || {};
    const { error: updateErr } = await supabase
      .from("profiles")
      .update({
        settings: { ...currentSettings, location: { name, latitude, longitude, updatedAt: new Date().toISOString() } },
        updated_at: new Date().toISOString(),
      })
      .eq("id", userId);

    if (updateErr) throw updateErr;
    res.json({ success: true });
  } catch (err) {
    console.error("Location save error:", err.message);
    res.status(500).json({ error: "Failed to save location" });
  }
});

// GET /api/api-key — check if user has their own API key set
app.get("/api/api-key", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });

  try {
    const { data: profile } = await supabase.from("profiles").select("settings").eq("id", userId).single();
    const s = profile?.settings || {};
    const provider = s.llm_provider || "anthropic";
    const keyField = { anthropic: "anthropic_api_key", openai: "openai_api_key", gemini: "gemini_api_key", custom: "custom_api_key" }[provider];
    const key = s[keyField] || "";
    // Which models the key actually runs. For the big three that is the
    // resolved set picked from the provider's own list at save time; for a
    // custom endpoint it is whatever the user named.
    const models = provider === "custom"
      ? (s.custom_model ? { default: s.custom_model, fast: s.custom_model_fast || undefined } : undefined)
      : (s.byok_models || undefined);
    res.json({
      hasKey: !!key, provider,
      // A local endpoint can be keyless yet fully configured.
      configured: !!key || (provider === "custom" && !!s.custom_base_url && !!s.custom_model),
      maskedKey: key ? key.slice(0, 8) + "..." + key.slice(-4) : "",
      models,
      customBaseUrl: provider === "custom" ? (s.custom_base_url || "") : undefined,
      customModel: provider === "custom" ? (s.custom_model || "") : undefined,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to check API key" });
  }
});

// Newest-model resolution for providers without a tracking alias.
//
// Undated ids already follow point releases, but nothing at Anthropic or
// OpenAI names "the newest generation, whatever it is", deliberately: a new
// generation changes price and behaviour, and providers will not switch that
// silently. So each tier has a wish list, newest first, and the first entry
// the user's own key can actually see wins. Guessed future names are harmless
// here, an id the list does not contain is simply skipped, and the resolved
// set refreshes every time the key is saved again.
const BYOK_CANDIDATES = {
  anthropic: {
    fast:    ["claude-haiku-5", "claude-haiku-4-5", "claude-3-5-haiku-latest"],
    default: ["claude-sonnet-5", "claude-sonnet-4-6", "claude-sonnet-4-5"],
    strong:  ["claude-opus-5", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5"],
  },
  openai: {
    fast:    ["gpt-5.2-mini", "gpt-5.1-mini", "gpt-5-mini", "gpt-4.1-mini", "gpt-4o-mini"],
    default: ["gpt-5.2", "gpt-5.1", "gpt-5", "gpt-4.1", "gpt-4o"],
    strong:  ["gpt-5.2", "gpt-5.1", "gpt-5", "o3", "gpt-4o"],
  },
};

async function resolveByokModels(provider, apiKey) {
  let ids = [];
  try {
    if (provider === "anthropic") {
      const r = await fetch("https://api.anthropic.com/v1/models?limit=100", {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) return null;
      ids = ((await r.json()).data || []).map((m) => m.id);
    } else if (provider === "openai") {
      const r = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) return null;
      ids = ((await r.json()).data || []).map((m) => m.id);
    } else {
      return null; // gemini tracks itself via -latest aliases
    }
  } catch { return null; }

  // The list often holds dated snapshots while we store the alias, so a
  // candidate matches either exactly or as the stem of a dated id. The alias
  // is what gets stored, so point releases keep flowing without a re-save.
  const has = (cand) => ids.some((id) => id === cand || id.startsWith(cand + "-2"));
  const out = {};
  for (const [tier, prefs] of Object.entries(BYOK_CANDIDATES[provider] || {})) {
    const winner = prefs.find(has);
    if (winner) out[tier] = winner;
  }
  return Object.keys(out).length === 3 ? out : null;
}

// POST /api/llm/models — list what a custom endpoint offers, so the model
// fields can suggest real ids instead of asking the user to guess one
// character-perfectly. GET {base}/models is part of the same OpenAI-compatible
// convention as /chat/completions, so it works wherever the endpoint will.
app.post("/api/llm/models", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });
  const { baseUrl, apiKey } = req.body || {};
  const cleanUrl = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(cleanUrl)) return res.status(400).json({ error: "Base URL must start with http(s)://" });
  try {
    const headers = {};
    if (apiKey && String(apiKey).trim()) headers["Authorization"] = `Bearer ${String(apiKey).trim()}`;
    const r = await fetch(`${cleanUrl}/models`, { headers, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return res.status(400).json({ error: `Endpoint returned ${r.status}` });
    const j = await r.json();
    const ids = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean);
    res.json({ models: ids.slice(0, 400).sort() });
  } catch (e) {
    res.status(400).json({ error: "Could not reach that endpoint" });
  }
});

// PUT /api/api-key — save user's API key for chosen provider
app.put("/api/api-key", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });

  const { apiKey, provider, setProviderOnly, baseUrl, model, modelFast } = req.body || {};
  const allProviders = ["anthropic", "openai", "gemini", "custom"];
  const prov = allProviders.includes(provider) ? provider : "anthropic";

  // Just switch provider without setting a key
  if (setProviderOnly) {
    try {
      const { data: profile } = await supabase.from("profiles").select("settings").eq("id", userId).single();
      const settings = profile?.settings || {};
      settings.llm_provider = prov;
      await mustWrite("could not save your settings", supabase.from("profiles").update({ settings, updated_at: new Date().toISOString() }).eq("id", userId));
      return res.json({ success: true, provider: prov });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  try {
    const { data: profile } = await supabase.from("profiles").select("settings").eq("id", userId).single();
    const currentSettings = profile?.settings || {};

    const keyField = { anthropic: "anthropic_api_key", openai: "openai_api_key", gemini: "gemini_api_key", custom: "custom_api_key" }[prov];

    // A custom endpoint is a URL, a model name and possibly a key. Prove it
    // can do the one thing everything here depends on, a tool call, before
    // accepting it: a model that answers politely but cannot call functions
    // would connect fine and then fail on every real request.
    if (prov === "custom") {
      // Clearing the URL is how a custom setup is removed.
      if (!String(baseUrl || "").trim()) {
        delete currentSettings.custom_base_url;
        delete currentSettings.custom_model;
        delete currentSettings.custom_api_key;
        if (currentSettings.llm_provider === "custom") delete currentSettings.llm_provider;
        await mustWrite("could not save your settings", supabase.from("profiles").update({ settings: currentSettings, updated_at: new Date().toISOString() }).eq("id", userId));
        return res.json({ success: true, removed: true });
      }
      const cleanUrl = String(baseUrl || "").trim().replace(/\/+$/, "");
      const cleanModel = String(model || "").trim();
      if (!/^https?:\/\//.test(cleanUrl)) return res.status(400).json({ error: "Base URL must start with http(s)://" });
      if (!cleanModel) return res.status(400).json({ error: "Model name required, e.g. moonshotai/kimi-k2" });
      try {
        const headers = { "Content-Type": "application/json" };
        if (apiKey && apiKey.trim()) headers["Authorization"] = `Bearer ${apiKey.trim()}`;
        const r = await fetch(`${cleanUrl}/chat/completions`, {
          method: "POST", headers,
          body: JSON.stringify({
            model: cleanModel, max_tokens: 100,
            messages: [{ role: "user", content: "What is 2+2? Use the calculator tool." }],
            tools: [{ type: "function", function: { name: "calculator", description: "Evaluate a maths expression", parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] } } }],
            tool_choice: "auto",
          }),
          signal: AbortSignal.timeout(20000),
        });
        if (!r.ok) {
          const e = await r.text().catch(() => "");
          return res.status(400).json({ error: `Endpoint rejected the test call (${r.status}): ${e.substring(0, 200)}` });
        }
        const j = await r.json();
        const madeToolCall = j?.choices?.[0]?.message?.tool_calls?.length > 0;
        if (!madeToolCall) {
          return res.status(400).json({ error: "Connected, but this model did not make a tool call. ClosedHand needs tool calling to do anything, so this model will not work." });
        }
      } catch (e) {
        return res.status(400).json({ error: `Could not reach that endpoint: ${String(e.message).substring(0, 150)}` });
      }
      currentSettings.custom_base_url = cleanUrl;
      currentSettings.custom_model = cleanModel;
      // Optional cheaper sibling for internal chores. Not tool-tested: it only
      // does classification and summaries, and a bad name fails loudly there.
      if (modelFast && String(modelFast).trim()) currentSettings.custom_model_fast = String(modelFast).trim();
      else delete currentSettings.custom_model_fast;
      if (apiKey && apiKey.trim()) currentSettings.custom_api_key = apiKey.trim();
      else delete currentSettings.custom_api_key;
      currentSettings.llm_provider = "custom";
      await mustWrite("could not save your settings", supabase.from("profiles").update({ settings: currentSettings, updated_at: new Date().toISOString() }).eq("id", userId));
      return res.json({ success: true });
    }

    if (!apiKey || apiKey.trim() === "") {
      delete currentSettings[keyField];
      if (currentSettings.llm_provider === prov) delete currentSettings.llm_provider;
      delete currentSettings.byok_models;
      await mustWrite("could not save your settings", supabase.from("profiles").update({ settings: currentSettings, updated_at: new Date().toISOString() }).eq("id", userId));
      return res.json({ success: true, removed: true });
    }

    // Validate key format
    const prefixes = { anthropic: "sk-ant-", openai: "sk-", gemini: "AIza" };
    if (prefixes[prov] && !apiKey.startsWith(prefixes[prov])) {
      return res.status(400).json({ error: `Invalid ${prov} API key format.` });
    }

    // Validate with a test call
    try {
      if (prov === "anthropic") {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": apiKey, "content-type": "application/json", "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 5, messages: [{ role: "user", content: "hi" }] }),
        });
        if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(400).json({ error: e.error?.message || "Key validation failed." }); }
      } else if (prov === "openai") {
        const r = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "gpt-4o-mini", max_tokens: 5, messages: [{ role: "user", content: "hi" }] }),
        });
        if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(400).json({ error: e.error?.message || "Key validation failed." }); }
      } else if (prov === "gemini") {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 5 } }),
        });
        if (!r.ok) { const e = await r.json().catch(() => ({})); return res.status(400).json({ error: e.error?.message || "Key validation failed." }); }
      }
    } catch (e) {
      return res.status(400).json({ error: "Could not validate API key." });
    }

    currentSettings[keyField] = apiKey.trim();
    currentSettings.llm_provider = prov;
    // Pick the newest models this key can see; the static table is the fallback.
    const resolvedModels = await resolveByokModels(prov, apiKey.trim());
    if (resolvedModels) currentSettings.byok_models = resolvedModels;
    else delete currentSettings.byok_models;
    await mustWrite("could not save your settings", supabase.from("profiles").update({ settings: currentSettings, updated_at: new Date().toISOString() }).eq("id", userId));
    res.json({ success: true, models: resolvedModels || undefined });
  } catch (err) {
    console.error("API key save error:", err.message);
    res.status(500).json({ error: "Failed to save API key" });
  }
});

// GET /api/weather — current weather for saved location
app.get("/api/weather", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });

  try {
    const { data: profile, error: fetchErr } = await supabase
      .from("profiles")
      .select("settings")
      .eq("id", userId)
      .single();

    if (fetchErr) throw fetchErr;

    const loc = profile?.settings?.location;
    if (!loc || !loc.latitude || !loc.longitude) {
      return res.json({ weather: null });
    }

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,weather_code&timezone=auto`;
    const body = await new Promise((resolve, reject) => {
      https.get(url, (resp) => {
        const chunks = [];
        resp.on("data", (c) => chunks.push(c));
        resp.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      }).on("error", reject);
    });
    const weatherData = JSON.parse(body);

    const wxCodes = {
      0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
      45: "Foggy", 48: "Depositing rime fog",
      51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
      61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
      71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow",
      77: "Snow grains", 80: "Slight rain showers", 81: "Moderate rain showers",
      82: "Violent rain showers", 85: "Slight snow showers", 86: "Heavy snow showers",
      95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail",
    };

    const current = weatherData.current;
    res.json({
      weather: {
        temperature: current.temperature_2m,
        unit: weatherData.current_units?.temperature_2m || "°C",
        weatherCode: current.weather_code,
        conditions: wxCodes[current.weather_code] || `Code ${current.weather_code}`,
        locationName: loc.name,
      },
    });
  } catch (err) {
    console.error("Weather fetch error:", err.message);
    res.status(500).json({ error: "Failed to load weather" });
  }
});

// === Knowledge Graph (Context Brain) ===

function extractWikiLinks(content) {
  const matches = content.match(/\[\[([^\]]+)\]\]/g) || [];
  return [...new Set(matches.map(m => m.slice(2, -2)))];
}

// GET /api/context-status — how full the live conversation is, so the memory
// tab can say truthfully whether anything has needed condensing yet. The
// char/4 estimate matches the bot's own pressure gauge, and the window is the
// platform default; for BYOK users it is approximate, which is fine for a
// gauge whose job is "nowhere near" versus "getting close".
app.get("/api/context-status", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });
  try {
    const { data } = await supabase.from("conversations").select("messages").eq("user_id", userId).single();
    const msgs = data?.messages || [];
    const tokens = Math.ceil(JSON.stringify(msgs).length / 4);
    const windowTokens = 500000;
    res.json({
      tokens,
      windowTokens,
      pct: Math.min(100, Math.round((tokens / (windowTokens * 0.75)) * 1000) / 10),
      messageCount: Array.isArray(msgs) ? msgs.length : 0,
    });
  } catch (e) {
    res.status(500).json({ error: "Failed" });
  }
});

// List all memory vectors (for graph rendering)
app.get("/api/knowledge", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const { data, error } = await supabase
      .from("data_vectors")
      .select("id, external_id, content, item_type, source_metadata, updated_at")
      .eq("user_id", userId)
      .eq("service", "memory")
      .order("updated_at", { ascending: false });
    if (error) throw error;
    // Map to legacy format for dashboard compatibility
    const nodes = (data || []).map(v => ({
      title: v.source_metadata?.title || v.external_id || (v.content || "").substring(0, 50),
      tags: [v.item_type],
      links: [],
      updated_at: v.updated_at,
      _id: v.id,
      _external_id: v.external_id,
    }));
    res.json(nodes);
  } catch (e) {
    console.error("Knowledge list error:", e);
    res.status(500).json({ error: "Failed to load knowledge" });
  }
});

// Search memory vectors (MUST be before :title route)
app.get("/api/knowledge/search", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const q = (req.query.q || "").trim();
    if (!q) return res.json([]);
    const { data, error } = await supabase
      .from("data_vectors")
      .select("id, external_id, content, item_type, source_metadata, updated_at")
      .eq("user_id", userId)
      .eq("service", "memory")
      .ilike("content", `%${q}%`)
      .limit(20);
    if (error) throw error;
    const nodes = (data || []).map(v => ({
      title: v.source_metadata?.title || v.external_id || (v.content || "").substring(0, 50),
      tags: [v.item_type],
      links: [],
      updated_at: v.updated_at,
    }));
    res.json(nodes);
  } catch (e) {
    console.error("Knowledge search error:", e);
    res.status(500).json({ error: "Search failed" });
  }
});

// Read full memory vector
app.get("/api/knowledge/:title", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const extId = decodeURIComponent(req.params.title);
    const { data, error } = await supabase
      .from("data_vectors")
      .select("id, external_id, content, item_type, source_metadata, updated_at, created_at")
      .eq("user_id", userId)
      .eq("service", "memory")
      .eq("external_id", extId)
      .single();
    if (error || !data) return res.status(404).json({ error: "Memory entry not found" });
    res.json({
      title: data.source_metadata?.title || data.external_id,
      content: data.content,
      tags: [data.item_type],
      links: [],
      created_at: data.created_at,
      updated_at: data.updated_at,
    });
  } catch (e) {
    console.error("Knowledge read error:", e);
    res.status(500).json({ error: "Failed to read entry" });
  }
});

// Create or update memory vector (for dashboard edits)
app.put("/api/knowledge/:title", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const extId = decodeURIComponent(req.params.title);
    const { content } = req.body;
    if (typeof content !== "string") return res.status(400).json({ error: "Content required" });
    const { error } = await supabase
      .from("data_vectors")
      .update({ content, updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("service", "memory")
      .eq("external_id", extId);
    if (error) throw error;
    res.json({ success: true, title: extId });
  } catch (e) {
    console.error("Knowledge write error:", e);
    res.status(500).json({ error: "Failed to save" });
  }
});

// Delete memory vector
app.delete("/api/knowledge/:title", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const extId = decodeURIComponent(req.params.title);
    const { data, error } = await supabase
      .from("data_vectors")
      .delete()
      .eq("user_id", userId)
      .eq("service", "memory")
      .eq("external_id", extId)
      .select();
    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: "Entry not found" });
    res.json({ success: true });
  } catch (e) {
    console.error("Knowledge delete error:", e);
    res.status(500).json({ error: "Failed to delete note" });
  }
});

// ============================================================================
// USER RULES API (persistent preferences)
// ============================================================================

app.get("/api/rules", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not authenticated" });
  try {
    const { data } = await supabase.from("user_rules")
      .select("id, rule, active, source, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: true });
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/rules/:id", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not authenticated" });
  try {
    const { active } = req.body;
    await mustWrite("could not save that rule", supabase.from("user_rules")
      .update({ active: !!active })
      .eq("id", req.params.id).eq("user_id", userId));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/rules", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not authenticated" });
  try {
    const { rule } = req.body;
    if (!rule) return res.status(400).json({ error: "rule is required" });
    const { data } = await supabase.from("user_rules")
      .insert({ user_id: userId, rule, source: "user" })
      .select("id, rule, active, source, created_at").single();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/rules/:id", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not authenticated" });
  try {
    await mustWrite("could not delete that rule", supabase.from("user_rules").delete().eq("id", req.params.id).eq("user_id", userId));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// SAVED NOTES API (pinned facts)
// ============================================================================

// The dashboard writes pinned facts too, and a fact lives in two stores: the
// `facts` row the bot reads into its prompt every turn, and a `data_vectors`
// row that Context Brain lists and passive recall searches. This endpoint set
// only ever touched the first, so a note edited here kept its old wording in
// recall and a note deleted here went on surfacing in conversation after it
// had gone from the list. Shared with the bot's pin_fact via a vendored copy,
// because the webapp cannot import from lib/.
const { factVectors, isInternalFactKey } = require("./fact-vectors");
const _factVectors = factVectors({
  supabase,
  embed: (text) => require("./rag-processor").embedSingle(text),
});

// GET /api/notes — list all user-facing saved notes
app.get("/api/notes", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const { data, error } = await supabase
      .from("facts")
      .select("key, value, updated_at")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false });
    if (error) throw error;

    // Filter out internal keys and deserialize metadata
    const notes = (data || [])
      .filter(row => !isInternalFactKey(row.key))
      .map(row => {
        let val = row.value;
        let meta = {};
        if (typeof val === "string" && val.startsWith("{")) {
          try {
            const parsed = JSON.parse(val);
            if (parsed && typeof parsed === "object" && parsed.value !== undefined) {
              val = parsed.value;
              meta = { created: parsed.created, lastAccessed: parsed.lastAccessed, accessCount: parsed.accessCount || 0 };
            }
          } catch (e) {}
        }
        return { key: row.key, value: val, updated_at: row.updated_at, ...meta };
      });
    res.json(notes);
  } catch (e) {
    console.error("Notes list error:", e);
    res.status(500).json({ error: "Failed to load notes" });
  }
});

// PUT /api/notes/:key — create or update a saved note
app.put("/api/notes/:key", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const key = decodeURIComponent(req.params.key);
    const { value } = req.body;
    if (!value || typeof value !== "string") return res.status(400).json({ error: "value is required (string)" });

    // Check for existing note to preserve metadata
    const { data: existing } = await supabase
      .from("facts")
      .select("value")
      .eq("user_id", userId)
      .eq("key", key)
      .single();

    const now = new Date().toISOString();
    let created = now;
    let accessCount = 0;
    if (existing?.value) {
      try {
        const parsed = JSON.parse(existing.value);
        if (parsed && parsed.created) { created = parsed.created; accessCount = parsed.accessCount || 0; }
      } catch (e) {}
    }

    const serialized = JSON.stringify({ value, created, lastAccessed: now, accessCount });
    const { error } = await supabase
      .from("facts")
      .upsert({ user_id: userId, key, value: serialized, updated_at: now }, { onConflict: "user_id,key" });
    if (error) throw error;

    // The fact is saved either way; only recall is affected if this fails, and
    // reporting the save as failed would invite the user to save it again.
    let recall = "updated";
    try {
      await _factVectors.mirrorFact(userId, key, value);
    } catch (e) {
      recall = "stale";
      console.error(`[Notes] Saved "${key}" but could not update its Context Brain entry:`, e.message);
    }
    res.json({ success: true, key, recall });
  } catch (e) {
    console.error("Notes save error:", e);
    res.status(500).json({ error: "Failed to save note" });
  }
});

// DELETE /api/notes/:key — delete a saved note
app.delete("/api/notes/:key", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const key = decodeURIComponent(req.params.key);
    const { data, error } = await supabase
      .from("facts")
      .delete()
      .eq("user_id", userId)
      .eq("key", key)
      .select();
    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: "Note not found" });

    // A vector left behind here is the visible failure: the note is gone from
    // the list and the bot still recalls it.
    try {
      await _factVectors.removeFactVector(userId, key);
    } catch (e) {
      console.error(`[Notes] Deleted "${key}" but its Context Brain entry remains:`, e.message);
    }
    res.json({ success: true });
  } catch (e) {
    console.error("Notes delete error:", e);
    res.status(500).json({ error: "Failed to delete note" });
  }
});

// GET /api/sandbox — sandbox status for authenticated user
app.get("/api/sandbox", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });

  try {
    const { data } = await supabase
      .from("sandboxes")
      .select("status, created_at, last_used_at, total_exec_count, volume_size_mb")
      .eq("user_id", userId)
      .single();

    if (!data || data.status === "destroyed") {
      return res.json({ exists: false, status: "not_created" });
    }

    res.json({
      exists: true,
      status: data.status,
      created_at: data.created_at,
      last_used_at: data.last_used_at,
      total_exec_count: data.total_exec_count || 0,
      volume_size_mb: data.volume_size_mb || 5120,
    });
  } catch (err) {
    console.error("Sandbox status error:", err.message);
    res.status(500).json({ error: "Failed to load sandbox status" });
  }
});

// ============================================================
// Dataset endpoints (dashboard read/delete for dataset tables)
// ============================================================

// GET /api/files - everything that has passed through chat, both directions
app.get("/api/files", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const { data, error } = await supabase
      .from("attachments")
      .select("attachment_id, file_name, description, media_type, size_bytes, direction, created_at")
      .eq("user_id", userId)
      // Only what ClosedHand made. A file the user sent is still kept, so it
      // can be read again later, but they already have it and listing it back
      // to them is not a resource, it is clutter.
      .eq("direction", "out")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: "Failed to load files" });
  }
});

// GET /api/files/:id/download - hand the file back
app.get("/api/files/:id/download", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    // Scoped to the caller, so an id alone cannot reach another user's file.
    const { data: row } = await supabase
      .from("attachments")
      .select("file_name, media_type, storage_path")
      .eq("user_id", userId).eq("attachment_id", req.params.id).single();
    if (!row) return res.status(404).json({ error: "Not found" });
    const { data: blob, error } = await supabase.storage.from("attachments").download(row.storage_path);
    if (error || !blob) return res.status(404).json({ error: "File no longer stored" });
    res.setHeader("Content-Type", row.media_type || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${(row.file_name || "file").replace(/"/g, "")}"`);
    res.send(Buffer.from(await blob.arrayBuffer()));
  } catch (e) {
    res.status(500).json({ error: "Download failed" });
  }
});

// GET /api/uploads - files the user sent ClosedHand in chat (direction=in).
// Listed under Context Brain, not Files: they are part of what ClosedHand can
// re-read on request, and the user manages them where the memory lives.
app.get("/api/uploads", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const { data, error } = await supabase
      .from("attachments")
      .select("attachment_id, file_name, description, media_type, size_bytes, created_at")
      .eq("user_id", userId)
      .eq("direction", "in")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: "Failed to load uploads" });
  }
});

// DELETE /api/uploads - clear every stored copy of files the user sent.
app.delete("/api/uploads", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const { data: rows, error } = await supabase
      .from("attachments").select("attachment_id, storage_path")
      .eq("user_id", userId).eq("direction", "in");
    if (error) throw error;
    if (!rows || !rows.length) return res.json({ success: true, deleted: 0 });
    const paths = rows.map(r => r.storage_path).filter(Boolean);
    for (let i = 0; i < paths.length; i += 100) {
      await supabase.storage.from("attachments").remove(paths.slice(i, i + 100));
    }
    await supabase.from("attachments").delete().eq("user_id", userId).eq("direction", "in");
    res.json({ success: true, deleted: rows.length });
  } catch (e) {
    res.status(500).json({ error: "Clear failed" });
  }
});

// DELETE /api/files - clear every file ClosedHand has sent (direction=out,
// exactly what the dashboard lists). Inbound copies of files the USER sent
// stay, or "read that file I sent you" would quietly stop working.
app.delete("/api/files", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const { data: rows, error } = await supabase
      .from("attachments").select("attachment_id, storage_path")
      .eq("user_id", userId).eq("direction", "out");
    if (error) throw error;
    if (!rows || !rows.length) return res.json({ success: true, deleted: 0 });
    const paths = rows.map(r => r.storage_path).filter(Boolean);
    // Storage first, then rows: a failed storage delete leaves the row, so
    // the file stays visible rather than becoming an orphaned object.
    for (let i = 0; i < paths.length; i += 100) {
      await supabase.storage.from("attachments").remove(paths.slice(i, i + 100));
    }
    await supabase.from("attachments").delete().eq("user_id", userId).eq("direction", "out");
    res.json({ success: true, deleted: rows.length });
  } catch (e) {
    res.status(500).json({ error: "Clear failed" });
  }
});

// DELETE /api/files/:id - remove the record and the stored copy
app.delete("/api/files/:id", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const { data: row } = await supabase
      .from("attachments").select("storage_path")
      .eq("user_id", userId).eq("attachment_id", req.params.id).single();
    if (!row) return res.status(404).json({ error: "Not found" });
    await supabase.storage.from("attachments").remove([row.storage_path]);
    await mustWrite("could not delete that file", supabase.from("attachments").delete().eq("user_id", userId).eq("attachment_id", req.params.id));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Delete failed" });
  }
});

// GET /api/datasets - list user's datasets
app.get("/api/datasets", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });
  try {
    const { data, error } = await supabase.from("datasets").select("*").eq("user_id", userId).order("created_at", { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    console.error("Datasets list error:", err.message);
    res.status(500).json({ error: "Failed to list datasets" });
  }
});

// GET /api/datasets/:id/export - the same table as a file the user can keep
app.get("/api/datasets/:id/export", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });
  try {
    const { data: ds } = await supabase.from("datasets").select("name, columns").eq("id", req.params.id).eq("user_id", userId).single();
    if (!ds) return res.status(404).json({ error: "Dataset not found" });
    const { data: rows } = await supabase.from("dataset_rows").select("data, row_index").eq("dataset_id", req.params.id).order("row_index", { ascending: true });
    const cols = (ds.columns || []).map((c) => c.name);
    // Quote everything and double any quote inside. Commas and line breaks in
    // a cell are what turn an export into a corrupt file.
    const cell = (v) => `"${String(v === null || v === undefined ? "" : v).replace(/"/g, '""')}"`;
    const csv = [cols.map(cell).join(",")]
      .concat((rows || []).map((r) => cols.map((c) => cell((r.data || {})[c])).join(",")))
      .join("\r\n");
    const safeName = String(ds.name || "dataset").replace(/[^a-z0-9 _-]/gi, "").trim() || "dataset";
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.csv"`);
    res.send("\uFEFF" + csv); // BOM, so Excel opens it as UTF-8
  } catch (err) {
    res.status(500).json({ error: "Export failed" });
  }
});

// GET /api/datasets/:id/rows - get rows for a dataset
app.get("/api/datasets/:id/rows", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });
  try {
    const { data: ds } = await supabase.from("datasets").select("columns").eq("id", req.params.id).eq("user_id", userId).single();
    if (!ds) return res.status(404).json({ error: "Dataset not found" });
    const { data: rows } = await supabase.from("dataset_rows").select("id, data, row_index, created_at").eq("dataset_id", req.params.id).order("row_index", { ascending: true });
    res.json({ columns: ds.columns, rows: rows || [] });
  } catch (err) {
    console.error("Dataset rows error:", err.message);
    res.status(500).json({ error: "Failed to load rows" });
  }
});

// DELETE /api/datasets/:id - delete a dataset
app.delete("/api/datasets/:id", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });
  try {
    const { data: ds } = await supabase.from("datasets").select("id").eq("id", req.params.id).eq("user_id", userId).single();
    if (!ds) return res.status(404).json({ error: "Dataset not found" });
    await mustWrite("could not delete that dataset", supabase.from("datasets").delete().eq("id", ds.id));
    res.json({ success: true });
  } catch (err) {
    console.error("Dataset delete error:", err.message);
    res.status(500).json({ error: "Failed to delete dataset" });
  }
});

// DELETE /api/datasets/rows/:rowId - delete a single row
app.delete("/api/datasets/rows/:rowId", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });
  try {
    const { data: row } = await supabase.from("dataset_rows").select("id, dataset_id").eq("id", req.params.rowId).eq("user_id", userId).single();
    if (!row) return res.status(404).json({ error: "Row not found" });
    await supabase.from("dataset_rows").delete().eq("id", row.id);
    const { count } = await supabase.from("dataset_rows").select("id", { count: "exact", head: true }).eq("dataset_id", row.dataset_id);
    await supabase.from("datasets").update({ row_count: count || 0 }).eq("id", row.dataset_id);
    res.json({ success: true });
  } catch (err) {
    console.error("Dataset row delete error:", err.message);
    res.status(500).json({ error: "Failed to delete row" });
  }
});

// ============================================================
// RAG Library endpoints (source-connector based)
// ============================================================

const ragProcessor = require("./rag-processor");

// POST /api/rag/sources - connect a new folder source
app.post("/api/rag/sources", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });
  const { origin, path: folderPath, selectedFiles, account } = req.body;
  if (!origin || !folderPath) return res.status(400).json({ error: "origin and path required" });
  if (!["cloud", "bridge", "gdrive", "onedrive", "dropbox"].includes(origin)) return res.status(400).json({ error: "Invalid origin" });
  // An account is only meaningful for the cloud stores, and must be one the
  // user actually holds, so a request cannot name someone else's connection.
  let acct = null;
  if (account && (origin === "gdrive" || origin === "onedrive")) {
    const prefix = origin === "gdrive" ? "google" : "microsoft";
    const { data: owns } = await supabase.from("connections").select("service").eq("user_id", userId).eq("service", account).single();
    if (!owns || !String(account).startsWith(prefix)) return res.status(400).json({ error: "Unknown account for this source" });
    acct = account;
  }
  try {
    const insertData = { user_id: userId, origin, path: folderPath, status: "pending" };
    if (selectedFiles && selectedFiles.length > 0) insertData.selected_files = selectedFiles;
    if (acct) insertData.account = acct;
    const { data, error } = await supabase.from("rag_sources").insert(insertData).select().single();
    if (error) return res.status(400).json({ error: error.message.includes("unique") ? "This folder is already connected" : error.message });
    res.json({ success: true, source: data });
    // Fire async indexing
    ragProcessor.processSource(data.id, userId, origin, folderPath, selectedFiles || null, acct).catch(e => console.error("[RAG] processSource error:", e.message));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/rag/sources - list sources
app.get("/api/rag/sources", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });
  const { data } = await supabase.from("rag_sources").select("*").eq("user_id", userId).order("created_at", { ascending: false });
  const sources = data || [];

  // Which files a search cannot reach. The source row carries the count, but a
  // count on its own leaves the user hunting; the names are what tell them
  // whether the gap matters, and a failed file is otherwise indistinguishable
  // from an indexed one until a search comes back empty.
  if (sources.length > 0) {
    const { data: failed } = await supabase.from("rag_documents")
      .select("source_id, name, error_message")
      .eq("user_id", userId)
      .eq("status", "error");
    const bySource = {};
    for (const d of failed || []) {
      if (!bySource[d.source_id]) bySource[d.source_id] = [];
      bySource[d.source_id].push({ name: d.name, error: d.error_message });
    }
    for (const s of sources) s.failed_files = bySource[s.id] || [];
  }
  res.json(sources);
});

// DELETE /api/rag/sources/:id - remove source + documents + chunks
app.delete("/api/rag/sources/:id", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });
  const { data } = await supabase.from("rag_sources").select("id").eq("id", req.params.id).eq("user_id", userId).single();
  if (!data) return res.status(404).json({ error: "Source not found" });
  const { error: delErr } = await supabase.from("rag_sources").delete().eq("id", data.id);
  // No try/catch in this handler, so answer directly rather than throwing into
  // nothing: an async throw in Express 4 leaves the request hanging.
  if (delErr) return res.status(500).json({ error: `could not remove that source (${delErr.message})` });
  res.json({ success: true });
});

// POST /api/rag/sources/:id/reindex - trigger reindex
app.post("/api/rag/sources/:id/reindex", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });
  const { data: source } = await supabase.from("rag_sources").select("*").eq("id", req.params.id).eq("user_id", userId).single();
  if (!source) return res.status(404).json({ error: "Source not found" });
  // Allow re-triggering even if stuck in "indexing" (process may have died on redeploy)
  res.json({ success: true, status: "indexing" });
  ragProcessor.processSource(source.id, userId, source.origin, source.path, source.selected_files || null, source.account || null).catch(e => console.error("[RAG] reindex error:", e.message));
});

// GET /api/rag/available-sources - which source types are available
app.get("/api/rag/available-sources", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json([]);
  try {
    const { data } = await supabase.from("connections").select("service, metadata").eq("user_id", userId);
    const connected = (data || []).map(c => c.service);
    const sandbox = await getSandboxInfo(userId).catch(() => null);
    const accountsFor = (prefix) => (data || [])
      .filter(c => c.service === prefix || c.service.startsWith(prefix + "_extra_"))
      .map(c => ({ account: c.service, email: c.metadata?.email || "", primary: c.service === prefix }));
    res.json({
      gdrive: connected.includes("google"),
      onedrive: connected.includes("microsoft"),
      dropbox: connected.includes("dropbox"),
      cloud: !!sandbox,
      bridge: true,
      gdriveAccounts: accountsFor("google"),
      onedriveAccounts: accountsFor("microsoft"),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/index/progress - USI indexing progress per service
app.get("/api/index/progress", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not authenticated" });
  try {
    const { data } = await supabase.from("index_progress").select("*").eq("user_id", userId);
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/rag/browse - browse folders for source selection
app.get("/api/rag/browse", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });
  const { origin, path: browsePath, account } = req.query;
  if (!origin) return res.status(400).json({ error: "origin required" });
  try {
    const files = await ragProcessor.scanFolder(userId, origin, browsePath || (origin === "cloud" ? "/workspace" : "~"), { account: account || undefined });
    res.json({ files: files || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// The lexical arm of File Search. Reported once: a missing index degrades
// search rather than breaking it, but it should not do so silently.
let _ragLexUnavailableReported = false;

async function ragLexicalSearch(userId, tokens) {
  if (!tokens.length) return [];
  try {
    const { data, error } = await supabase.rpc("search_rag_chunks_lexical", {
      match_user_id: userId,
      query_tokens: tokens,
      match_count: 40,
    });
    if (error) {
      if (!_ragLexUnavailableReported) {
        _ragLexUnavailableReported = true;
        console.log(`[RAG] Lexical search unavailable (${error.message}); running vector-only. Apply migration 034 to enable it.`);
      }
      return [];
    }
    return data || [];
  } catch (e) {
    if (!_ragLexUnavailableReported) {
      _ragLexUnavailableReported = true;
      console.log(`[RAG] Lexical search failed (${e.message}); running vector-only.`);
    }
    return [];
  }
}

// GET /api/rag/search?q=... -- hybrid search over the indexed library
app.get("/api/rag/search", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });

  const query = req.query.q;
  if (!query || query.length < 3) return res.status(400).json({ error: "Query too short (min 3 chars)" });

  try {
    // Two retrievers over the same library, as passive recall does over mail.
    //
    // The filename is the case that was outright broken. It is not in
    // rag_chunks.content and not in the embedded text, so a photo searched by
    // its own name came back at rank 9 behind eight other photos, below the
    // confidence bar. Only the lexical arm reads it.
    //
    // Exact terms in the body are a weaker case than they look, and the note
    // is here so nobody removes this arm on the strength of a small index: the
    // raw chunk IS part of what gets embedded, so a dense vector alone already
    // finds an identifier when there are a hundred chunks to choose from. What
    // it does not give is a guarantee that survives the top-N cut on a library
    // a thousand times bigger.
    const { lexicalTokens } = require("./lexical");
    const tokens = lexicalTokens(query, { corpus: "files" });

    // Split a filename the way the lexical index does, so "IMG_1038.JPG",
    // "IMG_1038" and "1038" agree here exactly as they do in Postgres. Whole
    // tokens only: matching on substrings would make "report" hit
    // "QualityControlReport20180905" and the tier would stop meaning anything.
    const nameParts = (s) => String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const queryNameParts = [...new Set(tokens.flatMap(nameParts))];
    const isNameMatch = (docName) => {
      if (queryNameParts.length === 0) return false;
      const have = new Set(nameParts(docName));
      return queryNameParts.every(t => have.has(t));
    };

    // Both arms in parallel: the lexical arm is a GIN index scan and the
    // vector arm is dominated by the query embed, so hybrid costs one round
    // trip, not the sum of the two.
    const [embedding, lexRows] = await Promise.all([
      ragProcessor.embedSingle(query).catch(() => null),
      ragLexicalSearch(userId, tokens),
    ]);

    let vecRows = [];
    if (embedding) {
      const { data: matches, error } = await supabase.rpc("match_rag_chunks", {
        query_embedding: JSON.stringify(embedding),
        match_user_id: userId,
        match_threshold: 0.25,
        // Fetch deep once. The expensive parts of a search (embedding the query,
        // the vector scan) happen per request, not per result, so pulling 40 and
        // paging client-side costs the same as pulling 10 and is instant for the
        // user. Re-querying for a second page would repeat the whole thing.
        match_count: 40,
      });
      if (error) throw new Error(error.message);
      vecRows = matches || [];
    }

    // A dead embedder no longer means a dead search: lexical alone is a
    // genuine result set, not a consolation prize.
    if (!embedding && lexRows.length === 0) {
      return res.status(500).json({ error: "Embedding failed" });
    }

    // Reciprocal Rank Fusion, keyed on the chunk. Cosine similarity and
    // ts_rank_cd are on incomparable, query-dependent scales, so any fixed
    // blend needs calibration that drifts; RRF reads only ordinal position and
    // degrades to "whatever the other arm found" when one returns nothing.
    // This decides which candidates the cross-encoder sees and nothing more:
    // the reranker below is the only component that reads query and document
    // together, so it is the only one whose ordering is a quality judgement.
    const RRF_K = 60;
    const fused = new Map();
    const contribute = (m, i, arm) => {
      const key = m.id || `${arm}:${i}`;
      const prev = fused.get(key);
      if (!prev) { fused.set(key, { row: m, score: 1 / (RRF_K + i + 1), arms: new Set([arm]) }); return; }
      prev.score += 1 / (RRF_K + i + 1);
      prev.arms.add(arm);
      // The stored row stays the vector one for a hit both arms found: it is
      // contributed first and it is the one carrying the similarity the
      // display path falls back on when the reranker is unavailable.
    };
    vecRows.forEach((m, i) => contribute(m, i, "vec"));
    lexRows.forEach((m, i) => contribute(m, i, "lex"));

    const merged = [...fused.values()].sort((a, b) => b.score - a.score);

    // Enrich with document names + origin/path
    const docIds = [...new Set(merged.map(x => x.row.document_id))];
    let docMap = {};
    if (docIds.length > 0) {
      const { data: docs } = await supabase.from("rag_documents").select("id, name, origin, file_path").in("id", docIds);
      for (const d of docs || []) docMap[d.id] = d;
    }

    let results = merged.map(({ row: m, arms }) => {
      const doc = docMap[m.document_id] || {};
      return {
        document_id: m.document_id,
        document_name: doc.name || "Unknown",
        origin: doc.origin || null,
        file_path: doc.file_path || null,
        content: m.content || "",
        _chunk_content: m.content || "",
        similarity: m.similarity,
        chunk_index: m.chunk_index,
        metadata: m.metadata || {},
        _arms: [...arms].join("+"),
      };
    });

    // Rerank for better relevance (graceful fallback if reranker unavailable)
    {
      try {
        // Vendored, not imported from lib/: the webapp is a separate service and
        // its container has no lib/ at all, so this require always threw and
        // File Search results were never reranked, silently.
        const { rerank } = require("./reranker");
        // Judge on the name AND the body. For a search by filename the name is
        // the whole match, and scoring a photo's empty body against its own
        // name would send every filename hit off the cliff below. The body
        // goes back afterwards, because the UI shows the name separately.
        //
        // Every candidate, not the top 30: the collapse below needs a score
        // for each chunk to pick the one that represents its document, and a
        // chunk trimmed here would take its document with it. This costs
        // nothing extra, the reranker already scores the whole array and
        // topK only decides how much of it comes back.
        const judged = await rerank(query, results.map(r => ({ ...r, content: r.document_name + "\n" + r.content })), results.length);
        results = judged.map(r => ({ ...r, content: r._chunk_content }));
      } catch (e) { /* unranked, in RRF order; the collapse and cap still apply */ }
    }

    // A result is a document, not a chunk. Retrieval works on chunks because
    // that is the unit that gets embedded, but a person searching a library is
    // looking for a file: one inspection report held ranks 1, 3 and 4 of its
    // own result page, which reads as three findings and is one, and pushed
    // the other matching documents off the top.
    //
    // Collapsing AFTER the reranker, not before, is the point: the chunk that
    // represents a document should be chosen by the component that reads the
    // query and the text together. RRF order would have picked by ordinal
    // agreement between two retrievers, which is candidate-set bookkeeping and
    // says nothing about which passage actually answers the question.
    //
    // The winning chunk is carried whole (content, chunk_index, metadata), so
    // Expand, Ask about this, Download and the chunk meta line keep working on
    // the passage that matched rather than an arbitrary one.
    {
      const byDoc = new Map();
      for (const r of results) {
        const prev = byDoc.get(r.document_id);
        if (!prev) { byDoc.set(r.document_id, { ...r, chunk_matches: 1 }); continue; }
        const matches = prev.chunk_matches + 1;
        // ?? -Infinity: with the reranker unavailable nothing is scored, and
        // the first chunk seen wins, which is RRF order rather than arbitrary.
        const winner = (r._rerank_score ?? -Infinity) > (prev._rerank_score ?? -Infinity) ? { ...r } : prev;
        winner.chunk_matches = matches;
        byDoc.set(r.document_id, winner);
      }
      results = [...byDoc.values()];
    }

    // A 0.25 recall threshold is right for feeding the reranker, but wrong as
    // a display bar: with a small index the nearest neighbour is returned no
    // matter how unrelated, so "picture with blue eyes" surfaced a credit-card
    // spreadsheet at 30% as though it were an answer. Flag weak hits so the UI
    // can say "nothing really matched" instead of presenting noise as a result.
    // Relevance comes from the reranker, not cosine. Measured on this index
    // for "blue eyes": cosine spans 0.350-0.399 for BOTH the seven correct
    // photos and an empty timetable document, so no cosine threshold can
    // separate them. The cross-encoder reads query and document together and
    // returns 4.2e-1 down to 9.6e-2 for the genuine matches, then falls off a
    // cliff to 8.0e-4 and below for everything else: a ~120x gap.
    const RELEVANT = 0.05;   // clearly about the query
    const PLAUSIBLE = 0.005; // worth offering, below the cliff
    const scored = results.map(r => ({
      ...r,
      relevance: r._rerank_score,
      _name_match: isNameMatch(r.document_name),
      low_confidence: r._rerank_score !== undefined
        ? r._rerank_score < RELEVANT
        // Reranker unavailable. Cosine is the fallback for a vector hit, but a
        // lexical-only hit has no cosine and does not need one: the query term
        // is literally in the text or the filename.
        : r.similarity === undefined ? false : (r.similarity || 0) < 0.35,
    }));

    // Typing a document's name should return that document, and the
    // cross-encoder has no way to say so. It ranks topical relevance, and
    // asked for "EASY IMEX INSPECTION REPORT" it is not wrong about the QC
    // report whose text mentions Easy Imex inspections throughout; it is
    // answering a question about the subject rather than the request for a
    // named file.
    //
    // Measured on the same library both ways, because the gap is not a tuning
    // problem in either: reranking chunk text alone scores the correctly named
    // documents 0.36 and 0.27 against 1.00 for the QC report, and reranking
    // the name with the text lifts them to 0.98 against 0.999. Far apart or
    // nearly equal, the named document loses. So this is a sort tier and not
    // an adjustment to the score, which would need a different magic number
    // for each of those distributions and would still be guessing.
    //
    // Deliberately narrow: EVERY distinctive token of the query must appear in
    // the filename, so this fires on "the document called X" and stays out of
    // the way of "what did the inspection find". A promoted document still has
    // to clear the noise floor, or a filename coincidence could lead a page of
    // genuine answers. Within each tier the reranker still decides.
    scored.sort((a, b) => {
      const an = a._name_match && (a.relevance === undefined || a.relevance >= PLAUSIBLE);
      const bn = b._name_match && (b.relevance === undefined || b.relevance >= PLAUSIBLE);
      if (an !== bn) return an ? -1 : 1;
      return (b.relevance ?? -Infinity) - (a.relevance ?? -Infinity);
    });

    // Trim the noise tail rather than padding to a fixed count. Returning a
    // quarter of a small index guarantees junk on page one, which is what put
    // an empty date-grid document among photos of people. Keep a few below the
    // cliff so a poor query still shows its closest content, flagged as weak.
    let out = scored;
    if (scored.some(r => r.relevance !== undefined)) {
      const keep = scored.filter(r => (r.relevance ?? 0) >= PLAUSIBLE);
      out = keep.length >= 3 ? keep : scored.slice(0, 5);
    }
    out = out.slice(0, 30);
    const noStrongMatches = out.length > 0 && out.every(r => r.low_confidence);

    // _chunk_content is scaffolding for the rerank round trip, not payload.
    res.json({
      results: out.map(({ _chunk_content, ...r }) => r),
      no_strong_matches: noStrongMatches,
    });
  } catch (err) {
    console.error("RAG search error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rag/retrieve - download original file for a chunk
app.post("/api/rag/retrieve", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });
  const { document_id } = req.body;
  if (!document_id) return res.status(400).json({ error: "Missing document_id" });
  const { data: doc } = await supabase.from("rag_documents")
    .select("name, origin, file_path")
    .eq("id", document_id).eq("user_id", userId).single();
  if (!doc) return res.status(404).json({ error: "Document not found" });

  try {
    const buffer = await ragProcessor.fetchFileContent(userId, doc.origin, doc.file_path);
    const ext = (doc.name || "").split(".").pop().toLowerCase();
    const mimeMap = { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", html: "text/html" };
    res.setHeader("Content-Type", mimeMap[ext] || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${doc.name}"`);
    res.send(buffer);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/rag/residency - get current data residency level
app.get("/api/rag/residency", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ level: "standard" });
  const { data } = await supabase.from("profiles").select("settings").eq("id", userId).single();
  res.json({ level: data?.settings?.rag_residency || "standard" });
});

// POST /api/rag/residency - set data residency level
app.post("/api/rag/residency", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });
  const { level } = req.body;
  if (!["standard", "zero"].includes(level)) return res.status(400).json({ error: "Invalid level" });
  const { data: profile } = await supabase.from("profiles").select("settings").eq("id", userId).single();
  const settings = profile?.settings || {};
  settings.rag_residency = level;
  const { error: saveErr } = await supabase.from("profiles").update({ settings }).eq("id", userId);
  if (saveErr) return res.status(500).json({ error: `could not save your settings (${saveErr.message})` });
  res.json({ success: true, level });
});

// --- Sandbox file manager helpers ---
const _sandboxUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// Bridge curl upload: receives file streamed directly from Bridge's local disk
const _bridgeUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } }); // 500MB max
app.post("/api/bridge/file-upload", _bridgeUpload.single("file"), async (req, res) => {
  const token = req.body.token;
  const tokenData = _uploadTokens.get(token);
  if (!tokenData || Date.now() > tokenData.expires) {
    _uploadTokens.delete(token);
    return res.status(401).json({ error: "Invalid or expired upload token" });
  }
  _uploadTokens.delete(token); // one-time use

  try {
    const info = await getSandboxInfo(tokenData.userId);
    if (!info) return res.status(404).json({ error: "Sandbox not found" });

    const destPath = req.body.path || tokenData.destPath;
    const isDir = req.body.isTar === "true";
    const fileBuffer = req.file.buffer;

    const b64 = fileBuffer.toString("base64");

    if (isDir) {
      // Write tar to sandbox temp, extract into dest
      const tmpTar = "/workspace/.tmp_upload_" + crypto.randomUUID().substring(0, 8) + ".tar";
      await sandboxFetch(info, "POST", "/files/write", { path: tmpTar, content: b64, encoding: "base64" }, 120000);
      await sandboxFetch(info, "POST", "/exec", {
        language: "bash",
        code: `mkdir -p "${destPath}" && tar xf "${tmpTar}" -C "${destPath}" && rm -f "${tmpTar}"`
      }, 60000);
    } else {
      // Single file: write directly via sandbox /files/write (limit raised to 500MB)
      const parentDir = destPath.substring(0, destPath.lastIndexOf("/")) || "/workspace";
      await sandboxFetch(info, "POST", "/exec", { language: "bash", code: `mkdir -p "${parentDir}"` }, 5000).catch(() => {});
      await sandboxFetch(info, "POST", "/files/write", { path: destPath, content: b64, encoding: "base64" }, 120000);
    }

    console.log(`[bridge-upload] ${isDir ? "dir" : "file"} -> ${destPath} (${fileBuffer.length} bytes)`);
    res.json({ success: true, path: destPath, size: fileBuffer.length });
  } catch (e) {
    console.error("[bridge-upload] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

async function getSandboxInfo(userId) {
  const { data } = await supabase
    .from("sandboxes")
    .select("hostname, sandbox_token, status, volume_size_mb")
    .eq("user_id", userId)
    .single();
  if (!data || data.status !== "active") return null;
  return { hostname: data.hostname, token: data.sandbox_token, volume_size_mb: data.volume_size_mb };
}

function sandboxFetch(info, method, path, body, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const url = `http://${info.hostname}:8080${path}`;
    const parsed = new URL(url);
    const headers = { "X-Sandbox-Token": info.token, "Content-Type": "application/json" };
    let postData = null;
    if (body) { postData = JSON.stringify(body); headers["Content-Length"] = Buffer.byteLength(postData); }
    const req = http.request({ hostname: parsed.hostname, port: parsed.port || 8080, path: parsed.pathname + parsed.search, method, headers }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode >= 400) return reject(new Error(`Sandbox ${res.statusCode}: ${text.substring(0, 200)}`));
        try { resolve(JSON.parse(text)); } catch { resolve({ raw: text }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error("Sandbox timeout")); });
    if (postData) req.write(postData);
    req.end();
  });
}

// Initialize RAG processor with sandbox/bridge access
ragProcessor.init({ getSandboxInfo, sandboxFetch, bridgeRequest: async (userId, action, params, timeout) => {
  return bridgeWsRequest(userId, action, params, timeout || 15000);
}});

// --- Workspace file cache (updates Supabase so bot has current file listing) ---
async function refreshWorkspaceCache(userId) {
  try {
    const info = await getSandboxInfo(userId);
    if (!info) return;
    const result = await sandboxFetch(info, "POST", "/files/list", { path: "/workspace" });
    const files = (result.files || result.entries || []).slice(0, 150);
    const { data: sandbox } = await supabase.from("sandboxes").select("metadata").eq("user_id", userId).single();
    const metadata = sandbox?.metadata || {};
    metadata.workspace_files = {
      files: files.map(f => ({ name: f.name, size: f.size || 0, type: f.type || (f.isDirectory ? "directory" : "file") })),
      cached_at: new Date().toISOString(),
    };
    await supabase.from("sandboxes").update({ metadata }).eq("user_id", userId);
  } catch (e) { /* sandbox may be sleeping */ }
}

// --- Always On Sync ---

// POST /api/sync/mark - mark a local file as "always on" (copies to cloud)
app.post("/api/sync/mark", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });
  const { localPath } = req.body;
  if (!localPath) return res.status(400).json({ error: "localPath required" });
  const name = localPath.split("/").pop();
  const destPath = "/workspace/" + name;
  try {
    const info = await getSandboxInfo(userId);
    if (!info) return res.status(404).json({ error: "Cloud Computer not enabled" });

    // Check if directory or file
    const cleanPath = localPath.replace(/^~\/?/, "").replace(/'/g, "'\\''");
    let isDir = false;
    try {
      const chk = await bridgeWsRequest(userId, "shell.run", {
        command: `bash -c 'test -d "$HOME/${cleanPath}" && echo "DIR" || echo "FILE"'`
      });
      isDir = (chk?.result?.stdout || chk?.stdout || "").trim() === "DIR";
    } catch (_) {}

    // Copy directly using chunked helper (no HTTP self-call)
    if (isDir) {
      await bridgeCopyDirToSandbox(userId, localPath, destPath, info);
    } else {
      await bridgeCopyFileToSandbox(userId, localPath, destPath, info);
    }
    console.log("[Sync] mark: copied", localPath, "->", destPath);
    // Get baseline metadata for sync tracking
    let localSize = 0, localMtime = 0;
    try {
      const s = await bridgeWsRequest(userId, "shell.run", {
        command: `stat -f '%z %m' "$HOME/${cleanPath}" 2>/dev/null`
      }, 5000);
      const parts = (s?.result?.stdout || s?.stdout || "").trim().split(" ");
      localSize = Number(parts[0]) || 0;
      localMtime = Number(parts[1]) || 0;
    } catch (_) {}
    await supabase.from("facts").upsert({
      user_id: userId, key: "_sync_" + localPath.replace(/[^a-zA-Z0-9]/g, "_"),
      value: JSON.stringify({
        localPath, cloudPath: destPath, syncedAt: new Date().toISOString(), status: "synced",
        lastLocalSize: localSize, lastLocalMtime: localMtime,
        lastCloudSize: localSize, lastCloudMtime: 0, // cloud mtime not available immediately after upload
      }),
    }, { onConflict: "user_id,key" });
    console.log("[Sync] mark: success", { localPath, destPath });
    res.json({ success: true, cloudPath: destPath });
  } catch (e) { console.error("[Sync] mark: error", e.message); res.status(500).json({ error: e.message }); }
});

// POST /api/sync/unmark - remove "always on" status
app.post("/api/sync/unmark", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });
  const { localPath } = req.body;
  if (!localPath) return res.status(400).json({ error: "localPath required" });
  try {
    const syncKey = "_sync_" + localPath.replace(/[^a-zA-Z0-9]/g, "_");
    // Look up the actual cloud path from the sync record (may differ from filename after rename)
    let cloudPath = "/workspace/" + localPath.split("/").pop(); // fallback
    const { data: note } = await supabase.from("facts").select("value").eq("user_id", userId).eq("key", syncKey).single();
    if (note?.value) {
      try { cloudPath = JSON.parse(note.value).cloudPath || cloudPath; } catch (_) {}
    }
    const info = await getSandboxInfo(userId);
    if (info) await sandboxFetch(info, "POST", "/files/delete", { path: cloudPath }).catch(() => {});
    await supabase.from("facts").delete().eq("user_id", userId).eq("key", syncKey);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/sync/list - get all synced files for current user
app.get("/api/sync/list", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json([]);
  const { data } = await supabase.from("facts").select("key, value").eq("user_id", userId).like("key", "_sync_%");
  const synced = (data || []).map(n => { try { return JSON.parse(n.value); } catch (e) { return null; } }).filter(Boolean);
  res.json(synced);
});

// ── Bidirectional sync engine ────────────────────────────────────────
// Every 30s, for each connected Bridge user, check synced files for changes.
// If local file changed → re-upload to cloud. If cloud file changed → push to local.
const _syncRunning = new Set(); // prevent overlapping runs per user

async function runSyncCycle() {
  // Iterate all connected Bridge users
  for (const [key, ws] of bridgeConnections) {
    if (!key.startsWith("user:") || ws.readyState !== 1) continue;
    const userId = key.replace("user:", "");
    if (_syncRunning.has(userId)) continue;
    _syncRunning.add(userId);
    try {
      await syncUserFiles(userId);
    } catch (e) {
      console.log(`[Sync] Cycle error for ${userId}: ${e.message}`);
    }
    _syncRunning.delete(userId);
  }
}

async function syncUserFiles(userId) {
  // Get all sync records for this user
  const { data: notes } = await supabase.from("facts").select("key, value").eq("user_id", userId).like("key", "_sync_%");
  if (!notes || notes.length === 0) return;

  const info = await getSandboxInfo(userId);
  if (!info) return;

  for (const note of notes) {
    let sync;
    try { sync = JSON.parse(note.value); } catch (_) { continue; }
    if (!sync.localPath || !sync.cloudPath) continue;

    try {
      // Get local file stat via Bridge
      const cleanPath = sync.localPath.replace(/^~\/?/, "").replace(/'/g, "'\\''");
      const localStat = await bridgeWsRequest(userId, "shell.run", {
        command: `stat -f '%z %m' "$HOME/${cleanPath}" 2>/dev/null`
      }, 8000).catch(() => null);
      const localStatStr = (localStat?.result?.stdout || localStat?.stdout || "").trim();
      const [localSize, localMtime] = localStatStr.split(" ").map(Number);

      // Get cloud file stat via sandbox
      const cloudParent = sync.cloudPath.substring(0, sync.cloudPath.lastIndexOf("/")) || "/workspace";
      const cloudName = sync.cloudPath.split("/").pop();
      let cloudSize = 0, cloudMtime = 0;
      try {
        const listing = await sandboxFetch(info, "POST", "/files/list", { path: cloudParent });
        const files = listing?.files || listing?.items || (Array.isArray(listing) ? listing : []);
        const match = files.find(f => f.name === cloudName);
        if (match) {
          cloudSize = match.size || 0;
          cloudMtime = match.modified ? new Date(match.modified).getTime() / 1000 : 0;
        }
      } catch (_) {}

      // Compare with last known state
      const lastLocalSize = sync.lastLocalSize || 0;
      const lastLocalMtime = sync.lastLocalMtime || 0;
      const lastCloudSize = sync.lastCloudSize || 0;
      const lastCloudMtime = sync.lastCloudMtime || 0;

      const localChanged = localSize && localMtime && (localSize !== lastLocalSize || localMtime !== lastLocalMtime);
      const cloudChanged = cloudSize && cloudMtime && (cloudSize !== lastCloudSize || cloudMtime !== lastCloudMtime);

      // First sync: just record the metadata, don't copy
      if (!lastLocalMtime && !lastCloudMtime) {
        sync.lastLocalSize = localSize || 0;
        sync.lastLocalMtime = localMtime || 0;
        sync.lastCloudSize = cloudSize || 0;
        sync.lastCloudMtime = cloudMtime || 0;
        await supabase.from("facts").update({ value: JSON.stringify(sync) }).eq("user_id", userId).eq("key", note.key);
        continue;
      }

      if (localChanged && !cloudChanged) {
        // Local file changed → push to cloud
        console.log(`[Sync] Local changed, uploading: ${sync.localPath} → ${sync.cloudPath}`);
        await bridgeCopyFileToSandbox(userId, sync.localPath, sync.cloudPath, info);
        // Wait for upload to complete (poll for size change, max 30s)
        await new Promise(r => setTimeout(r, 3000));
      } else if (cloudChanged && !localChanged) {
        // Cloud file changed → push to local
        console.log(`[Sync] Cloud changed, downloading: ${sync.cloudPath} → ${sync.localPath}`);
        const destLocal = sync.localPath;
        const name = destLocal.split("/").pop();
        const localDir = destLocal.substring(0, destLocal.length - name.length);
        try {
          const fileData = await sandboxFetch(info, "POST", "/files/download", { path: sync.cloudPath });
          const content = fileData.content || fileData.raw || "";
          await bridgeWsRequest(userId, "files.write", {
            path: destLocal, content, encoding: fileData.encoding || "base64"
          }, 30000);
        } catch (e) {
          console.log(`[Sync] Cloud→local push failed: ${e.message}`);
        }
      } else if (localChanged && cloudChanged) {
        // Both changed (conflict) → local wins (user's machine is authoritative)
        console.log(`[Sync] Conflict on ${sync.localPath}, local wins`);
        await bridgeCopyFileToSandbox(userId, sync.localPath, sync.cloudPath, info);
        await new Promise(r => setTimeout(r, 3000));
        // Rare enough to deserve a heads-up: the cloud-side edit was discarded
        try {
          const fname = sync.localPath.split("/").pop();
          await supabase.from("web_messages").insert({
            user_id: userId, direction: "outbound", status: "complete",
            content: `Heads up: "${fname}" was edited on your computer and on your cloud computer at the same time. Your local version won, so the cloud-side edit was overwritten. If ClosedHand was working on that file, ask it to redo the change.`,
          });
        } catch (e) { console.log(`[Sync] conflict notice failed: ${e.message}`); }
      }

      // Update stored metadata
      // Re-stat to get post-sync values
      if (localChanged || cloudChanged) {
        const newLocalStat = await bridgeWsRequest(userId, "shell.run", {
          command: `stat -f '%z %m' "$HOME/${cleanPath}" 2>/dev/null`
        }, 8000).catch(() => null);
        const newLocalStr = (newLocalStat?.result?.stdout || newLocalStat?.stdout || "").trim();
        const [nls, nlm] = newLocalStr.split(" ").map(Number);

        let ncs = 0, ncm = 0;
        try {
          const listing = await sandboxFetch(info, "POST", "/files/list", { path: cloudParent });
          const files = listing?.files || listing?.items || (Array.isArray(listing) ? listing : []);
          const match = files.find(f => f.name === cloudName);
          if (match) { ncs = match.size || 0; ncm = match.modified ? new Date(match.modified).getTime() / 1000 : 0; }
        } catch (_) {}

        sync.lastLocalSize = nls || localSize || 0;
        sync.lastLocalMtime = nlm || localMtime || 0;
        sync.lastCloudSize = ncs || cloudSize || 0;
        sync.lastCloudMtime = ncm || cloudMtime || 0;
        sync.lastSyncAt = new Date().toISOString();
        await supabase.from("facts").update({ value: JSON.stringify(sync) }).eq("user_id", userId).eq("key", note.key);
      }
    } catch (e) {
      console.log(`[Sync] Error syncing ${sync.localPath}: ${e.message}`);
    }
  }
}

// Run sync cycle every 30 seconds
setInterval(runSyncCycle, 30000);

// Also run a sync immediately when a file is first marked
// (the sync/mark endpoint already copies, but this records baseline metadata)

// GET /api/sandbox/activity - recent activity for the cloud computer
app.get("/api/sandbox/activity", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json([]);
  try {
    // Get recent automation runs (table may not exist)
    let runs = [];
    try {
      const { data } = await supabase
        .from("automation_runs")
        .select("id, status, model, triggered_by, created_at, completed_at, result")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(10);
      runs = data || [];
    } catch (e) { /* table may not exist */ }

    // Get storage info
    const info = await getSandboxInfo(userId);
    let storage = null;
    if (info) {
      try {
        const storageResp = await sandboxFetch(info, "POST", "/exec", { language: "bash", code: "du -sh /workspace 2>/dev/null | cut -f1" }, 5000);
        storage = (storageResp.stdout || storageResp.output || "").trim();
      } catch (e) { /* sandbox may be sleeping */ }
    }

    // Get recent sync events
    let syncs = [];
    try {
      const { data } = await supabase
        .from("facts")
        .select("key, value")
        .eq("user_id", userId)
        .like("key", "_sync_%");
      syncs = (data || []).map(s => { try { return JSON.parse(s.value); } catch (e) { return null; } }).filter(Boolean);
    } catch (e) {}

    res.json({
      runs,
      storage: storage || "0",
      volume_size_mb: info?.volume_size_mb || 5120,
      syncs,
      online: !!info,
    });
  } catch (e) {
    res.json({ runs: [], storage: "0", syncs: [], online: false });
  }
});

// GET /api/sandbox/files?path=/workspace
app.get("/api/sandbox/files", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });
  try {
    const info = await getSandboxInfo(userId);
    if (!info) return res.status(404).json({ error: "Cloud Computer not enabled" });
    const dirPath = req.query.path || "/workspace";
    const result = await sandboxFetch(info, "POST", "/files/list", { path: dirPath });
    res.json({ files: result.files || result.entries || [] });
  } catch (err) {
    console.error("Sandbox files error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sandbox/upload (multipart)
app.post("/api/sandbox/upload", _sandboxUpload.single("file"), async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });
  try {
    const info = await getSandboxInfo(userId);
    if (!info) return res.status(404).json({ error: "Cloud Computer not enabled" });
    const filePath = req.body.path || ("/workspace/" + (req.file?.originalname || "upload"));
    const content = req.file.buffer.toString("base64");
    await sandboxFetch(info, "POST", "/files/write", { path: filePath, content, encoding: "base64" });
    res.json({ success: true, path: filePath });
    refreshWorkspaceCache(userId).catch(() => {});
  } catch (err) {
    console.error("Sandbox upload error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sandbox/download?path=/workspace/file.txt
app.get("/api/sandbox/download", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });
  try {
    const info = await getSandboxInfo(userId);
    if (!info) return res.status(404).json({ error: "Cloud Computer not enabled" });
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: "path required" });
    const result = await sandboxFetch(info, "POST", "/files/download", { path: filePath });
    const name = filePath.split("/").pop();
    if (result.content) {
      const buffer = Buffer.from(result.content, result.encoding || "base64");
      res.setHeader("Content-Disposition", "attachment; filename=\"" + name + "\"");
      res.setHeader("Content-Type", "application/octet-stream");
      res.send(buffer);
    } else if (result.raw) {
      res.setHeader("Content-Disposition", "attachment; filename=\"" + name + "\"");
      res.setHeader("Content-Type", "text/plain");
      res.send(result.raw);
    } else {
      res.status(404).json({ error: "File not found" });
    }
  } catch (err) {
    console.error("Sandbox download error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/sandbox/files?path=/workspace/file.txt
app.delete("/api/sandbox/files", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });
  try {
    const info = await getSandboxInfo(userId);
    if (!info) return res.status(404).json({ error: "Cloud Computer not enabled" });
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: "path required" });
    await sandboxFetch(info, "POST", "/files/delete", { path: filePath });
    // Clean up any sync records that point to this cloud path
    try {
      const { data: syncNotes } = await supabase.from("facts").select("key, value").eq("user_id", userId).like("key", "_sync_%");
      if (syncNotes) {
        for (const note of syncNotes) {
          try {
            const parsed = JSON.parse(note.value);
            if (parsed.cloudPath === filePath) {
              await supabase.from("facts").delete().eq("user_id", userId).eq("key", note.key);
              console.log("[Delete] Cleaned up sync record for", filePath);
            }
          } catch (e) { /* skip unparseable */ }
        }
      }
    } catch (syncErr) { console.error("[Delete] Sync cleanup error:", syncErr.message); }
    res.json({ success: true });
    refreshWorkspaceCache(userId).catch(() => {});
  } catch (err) {
    console.error("Sandbox delete error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sandbox/rename
app.post("/api/sandbox/rename", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });
  try {
    const info = await getSandboxInfo(userId);
    if (!info) return res.status(404).json({ error: "Cloud Computer not enabled" });
    const { oldPath, newPath } = req.body;
    if (!oldPath || !newPath) return res.status(400).json({ error: "oldPath and newPath required" });
    // Use exec to rename since there's no dedicated rename endpoint
    await sandboxFetch(info, "POST", "/exec", { language: "bash", code: "mv " + JSON.stringify(oldPath) + " " + JSON.stringify(newPath) });
    // If this file is synced, rename the local copy too and update the sync record
    try {
      const { data: syncNotes } = await supabase.from("facts").select("key, value").eq("user_id", userId).like("key", "_sync_%");
      for (const note of syncNotes || []) {
        try {
          const sync = JSON.parse(note.value);
          if (sync.cloudPath === oldPath) {
            const oldName = oldPath.split("/").pop();
            const newName = newPath.split("/").pop();
            // Rename local file via Bridge
            if (oldName !== newName && sync.localPath) {
              const localDir = sync.localPath.substring(0, sync.localPath.length - oldName.length);
              const newLocalPath = localDir + newName;
              const cleanOld = sync.localPath.replace(/^~\/?/, "").replace(/'/g, "'\\''");
              const cleanNew = newLocalPath.replace(/^~\/?/, "").replace(/'/g, "'\\''");
              try {
                await bridgeWsRequest(userId, "shell.run", {
                  command: `mv "$HOME/${cleanOld}" "$HOME/${cleanNew}"`
                }, 10000);
                console.log("[Sync] Renamed local file:", sync.localPath, "->", newLocalPath);
                // Update sync record with new paths and new key
                const oldKey = note.key;
                const newKey = "_sync_" + newLocalPath.replace(/[^a-zA-Z0-9]/g, "_");
                sync.localPath = newLocalPath;
                sync.cloudPath = newPath;
                // Delete old key, insert new key (localPath changed so key changes)
                await supabase.from("facts").delete().eq("user_id", userId).eq("key", oldKey);
                await supabase.from("facts").upsert({
                  user_id: userId, key: newKey, value: JSON.stringify(sync)
                }, { onConflict: "user_id,key" });
              } catch (e) {
                // Bridge offline or rename failed, just update cloud path
                console.log("[Sync] Local rename failed (Bridge offline?):", e.message);
                sync.cloudPath = newPath;
                await supabase.from("facts").update({ value: JSON.stringify(sync) }).eq("user_id", userId).eq("key", note.key);
              }
            } else {
              // Only directory changed, not filename
              sync.cloudPath = newPath;
              await supabase.from("facts").update({ value: JSON.stringify(sync) }).eq("user_id", userId).eq("key", note.key);
            }
          }
        } catch (_) {}
      }
    } catch (_) {}
    res.json({ success: true });
    refreshWorkspaceCache(userId).catch(() => {});
  } catch (err) {
    console.error("Sandbox rename error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sandbox/exec -- run a shell command in the sandbox
app.post("/api/sandbox/exec", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });
  try {
    const info = await getSandboxInfo(userId);
    if (!info) return res.status(404).json({ error: "Cloud Computer not enabled" });
    const { command } = req.body;
    if (!command) return res.status(400).json({ error: "command required" });
    const result = await sandboxFetch(info, "POST", "/exec", { language: "bash", code: command }, 30000);
    res.json({ output: result.stdout || result.output || "", error: result.stderr || "" });
    refreshWorkspaceCache(userId).catch(() => {});
  } catch (err) {
    console.error("Sandbox exec error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sandbox/search?q=foo&path=/workspace/sub -- recursive find inside the panel's current path
app.get("/api/sandbox/search", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });
  const raw = (req.query.q || "").trim();
  const safe = raw.replace(/[^\w.\- ]/g, "").slice(0, 80);
  if (!safe) return res.json({ files: [] });
  // Lock search root to /workspace subtree
  const reqPath = (req.query.path || "/workspace").trim().replace(/\.\./g, "");
  const searchRoot = reqPath.indexOf("/workspace") === 0 ? reqPath.replace(/\/$/, "") : "/workspace";
  const safeRoot = searchRoot.replace(/[`"\\$]/g, "");
  try {
    const info = await getSandboxInfo(userId);
    if (!info) return res.status(404).json({ error: "Cloud Computer not enabled" });
    // Prune dotfiles and node_modules up front instead of filtering after descending.
    const cmd = `find "${safeRoot}" \\( -name '.*' -o -name 'node_modules' \\) -prune -o -iname '*${safe}*' -printf '%y\\t%s\\t%T@\\t%p\\n' 2>/dev/null | head -200`;
    const result = await sandboxFetch(info, "POST", "/exec", { language: "bash", code: cmd }, 15000);
    const out = (result.stdout || result.output || "").trim();
    const files = out ? out.split("\n").map((line) => {
      const parts = line.split("\t");
      if (parts.length < 4) return null;
      const typeChar = parts[0];
      const sizeStr = parts[1];
      const mtimeStr = parts[2];
      const path = parts.slice(3).join("\t");
      if (!path || path === "/workspace") return null;
      const name = path.split("/").pop();
      if (!name || name.startsWith(".")) return null;
      return {
        name,
        path,
        type: typeChar === "d" ? "directory" : "file",
        size: parseInt(sizeStr, 10) || 0,
        modified: mtimeStr ? new Date(parseFloat(mtimeStr) * 1000).toISOString() : null,
      };
    }).filter(Boolean) : [];
    res.json({ files });
  } catch (err) {
    console.error("Sandbox search error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Helper: send a request to Bridge via direct WebSocket (skips HTTP relay for speed)
async function bridgeWsRequest(userId, action, params, timeout = 60000) {
  const ws = bridgeConnections.get("user:" + userId);
  if (!ws || ws.readyState !== 1) throw new Error("Bridge not connected");
  const requestId = crypto.randomUUID();
  if (!ws._pendingCallbacks) ws._pendingCallbacks = new Map();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws._pendingCallbacks.delete(requestId);
      reject(new Error("Bridge request timed out"));
    }, timeout);
    ws._pendingCallbacks.set(requestId, { resolve, reject, timer });
    ws.send(JSON.stringify({ type: "request", id: requestId, action, params: params || {} }));
  });
}

// Copy file from Bridge to sandbox via curl upload (streams from disk, no base64 over WebSocket)
async function bridgeCopyFileToSandbox(userId, sourcePath, destPath, info) {
  const cleanPath = sourcePath.replace(/^~\/?/, "").replace(/'/g, "'\\''");
  const token = crypto.randomUUID();
  const baseUrl = BASE_URL;

  // Register one-time upload token (5 min expiry)
  _uploadTokens.set(token, { userId, destPath, expires: Date.now() + 300000, isDir: false });

  // Ensure parent directory exists on sandbox
  const parentDir = destPath.substring(0, destPath.lastIndexOf("/")) || "/workspace";
  await sandboxFetch(info, "POST", "/exec", {
    language: "bash", code: `mkdir -p "${parentDir}"`
  }, 5000).catch(() => {});

  // Tell Bridge to curl the file directly to our upload endpoint (runs in background)
  const curlCmd = `bash -c 'curl -s -X POST -F "file=@$HOME/${cleanPath}" -F "path=${destPath}" -F "token=${token}" ${baseUrl}/api/bridge/file-upload > /tmp/.ch_upload_${token.substring(0, 8)} 2>&1 &'`;

  console.log(`[copy-curl] ${sourcePath} -> ${destPath} (starting curl upload)`);
  await bridgeWsRequest(userId, "shell.run", { command: curlCmd });

  // Poll for completion: check if file appeared on sandbox
  for (let i = 0; i < 120; i++) { // up to 2 minutes
    await new Promise(r => setTimeout(r, 1000));
    // Token consumed means upload endpoint received and processed the file
    if (!_uploadTokens.has(token)) {
      // Verify file exists on sandbox
      try {
        const check = await sandboxFetch(info, "POST", "/exec", {
          language: "bash", code: `test -f "${destPath}" && stat -c%s "${destPath}" 2>/dev/null || stat -f%z "${destPath}" 2>/dev/null || echo "0"`
        }, 5000);
        const size = parseInt((check.stdout || check.output || "0").trim());
        if (size > 0) {
          console.log(`[copy-curl] ${sourcePath} -> ${destPath} complete (${size} bytes)`);
          return;
        }
      } catch (e) { /* sandbox check failed, keep polling */ }
    }
  }

  // Clean up token if upload never happened
  _uploadTokens.delete(token);
  throw new Error("File upload timed out. The file may be too large or Bridge lost connection.");
}

// Copy directory from Bridge to sandbox via curl upload (tar + stream)
async function bridgeCopyDirToSandbox(userId, sourcePath, destPath, info) {
  const cleanPath = sourcePath.replace(/^~\/?/, "").replace(/'/g, "'\\''");
  const token = crypto.randomUUID();
  const baseUrl = BASE_URL;

  // Register one-time upload token (5 min expiry)
  _uploadTokens.set(token, { userId, destPath, expires: Date.now() + 300000, isDir: true });

  // Ensure dest dir exists on sandbox
  await sandboxFetch(info, "POST", "/exec", {
    language: "bash", code: `mkdir -p "${destPath}"`
  }, 5000).catch(() => {});

  // Tell Bridge to tar the directory and pipe to curl (runs in background)
  const curlCmd = `bash -c 'cd "$HOME/${cleanPath}" && tar cf - . 2>/dev/null | curl -s -X POST -F "file=@-;filename=dir.tar" -F "path=${destPath}" -F "isTar=true" -F "token=${token}" ${baseUrl}/api/bridge/file-upload > /tmp/.ch_upload_${token.substring(0, 8)} 2>&1 &'`;

  console.log(`[copy-curl-dir] ${sourcePath} -> ${destPath} (starting tar+curl upload)`);
  await bridgeWsRequest(userId, "shell.run", { command: curlCmd });

  // Poll for completion
  for (let i = 0; i < 120; i++) { // up to 2 minutes
    await new Promise(r => setTimeout(r, 1000));
    if (!_uploadTokens.has(token)) {
      // Verify directory was extracted
      try {
        const check = await sandboxFetch(info, "POST", "/exec", {
          language: "bash", code: `test -d "${destPath}" && ls -1 "${destPath}" 2>/dev/null | wc -l || echo "0"`
        }, 5000);
        const count = parseInt((check.stdout || check.output || "0").trim());
        if (count > 0) {
          console.log(`[copy-curl-dir] ${sourcePath} -> ${destPath} complete (${count} entries)`);
          return;
        }
      } catch (e) { /* keep polling */ }
    }
  }

  _uploadTokens.delete(token);
  throw new Error("Directory upload timed out. The directory may be too large or Bridge lost connection.");
}

// POST /api/sandbox/copy-from-local — fetch file from Bridge, save to sandbox
app.post("/api/sandbox/copy-from-local", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });
  try {
    const { sourcePath, destPath } = req.body;
    if (!sourcePath || !destPath) return res.status(400).json({ error: "sourcePath and destPath required" });
    const cleanPath = sourcePath.replace(/^~\/?/, "").replace(/'/g, "'\\''");

    // Check if path is a directory via direct Bridge WebSocket
    let isDirectory = false;
    try {
      const checkResult = await bridgeWsRequest(userId, "shell.run", {
        command: `bash -c 'test -d "$HOME/${cleanPath}" && echo "DIR" || echo "FILE"'`
      });
      const checkOut = (checkResult?.result?.stdout || checkResult?.stdout || "").trim();
      isDirectory = checkOut === "DIR";
    } catch (e) {
      console.log("[copy-from-local] dir check failed, assuming file:", e.message);
    }

    const info = await getSandboxInfo(userId);
    if (!info) return res.status(404).json({ error: "Cloud Computer not enabled" });

    if (isDirectory) {
      await bridgeCopyDirToSandbox(userId, sourcePath, destPath, info);
    } else {
      await bridgeCopyFileToSandbox(userId, sourcePath, destPath, info);
    }

    res.json({ success: true });
    refreshWorkspaceCache(userId).catch(() => {});
  } catch (err) {
    console.error("Copy from local error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sandbox/copy-to-local — download from sandbox, write to local via Bridge
app.post("/api/sandbox/copy-to-local", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });
  try {
    const { sourcePath, destPath } = req.body;
    if (!sourcePath || !destPath) return res.status(400).json({ error: "sourcePath and destPath required" });
    // Read from sandbox
    const info = await getSandboxInfo(userId);
    if (!info) return res.status(404).json({ error: "Cloud Computer not enabled" });
    const fileData = await sandboxFetch(info, "POST", "/files/download", { path: sourcePath });
    const content = fileData.content || fileData.raw || "";
    // Write to local via Bridge
    const bridgeResp = await fetch(BASE_URL + "/api/bridge/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, action: "files.write", params: { path: destPath, content, encoding: fileData.encoding || "base64" }, secret: process.env.BRIDGE_RELAY_SECRET || process.env.COOKIE_SECRET || "" }),
    });
    const bridgeData = await bridgeResp.json();
    if (!bridgeResp.ok) return res.status(502).json({ error: bridgeData.error || "Bridge write failed" });
    res.json({ success: true });
  } catch (err) {
    console.error("Copy to local error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/bridge/files?path=~ — list local files via Bridge
app.get("/api/bridge/files", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });
  try {
    const dirPath = req.query.path || "~";
    // Use the internal bridge request relay (same process, same server)
    const fakeReq = { body: { userId, action: "files.list", params: { path: dirPath }, secret: process.env.BRIDGE_RELAY_SECRET || process.env.COOKIE_SECRET } };
    const fakeRes = {
      _status: 200, _body: null,
      status(s) { this._status = s; return this; },
      json(d) { this._body = d; },
    };
    // Find the WS and send request directly using the bridge request handler logic
    const ws = bridgeConnections.get("user:" + userId);
    if (!ws || ws.readyState !== 1) {
      return res.status(502).json({ error: "Bridge offline" });
    }
    // Try files.list first, fall back to shell.run ls for completeness
    let files = [];
    try {
      const result = await bridgeWsRequest(userId, "files.list", { path: dirPath }, 15000);
      const rawFiles = result?.items || result?.files || (Array.isArray(result) ? result : []);
      files = rawFiles.map(f => ({
        name: f.name,
        type: f.isDirectory || f.type === "directory" ? "directory" : "file",
        size: f.size || 0,
        modified: f.modified || f.modifiedDate || null,
      }));
    } catch (e) {
      console.log(`[Bridge/files] files.list failed: ${e.message}, trying shell.run ls`);
    }

    // If files.list returned very few results, supplement with ls
    if (files.length < 5) {
      try {
        const cleanPath = dirPath.replace(/^~\/?/, "").replace(/'/g, "'\\''");
        const lsPath = dirPath === "~" || dirPath === "~/" ? "$HOME" : `$HOME/${cleanPath}`;
        const lsResult = await bridgeWsRequest(userId, "shell.run", {
          command: `ls -1p "${lsPath}" 2>/dev/null`
        }, 10000);
        const lsOut = (lsResult?.result?.stdout || lsResult?.stdout || "").trim();
        if (lsOut) {
          const lsNames = new Set(files.map(f => f.name));
          const lines = lsOut.split("\n").filter(Boolean);
          for (const line of lines) {
            const isDir = line.endsWith("/");
            const name = isDir ? line.slice(0, -1) : line;
            if (name && !name.startsWith(".") && !lsNames.has(name)) {
              files.push({ name, type: isDir ? "directory" : "file", size: 0, modified: null });
            }
          }
        }
      } catch (e) {
        console.log(`[Bridge/files] ls fallback also failed: ${e.message}`);
      }
    }

    res.json({ files });
  } catch (err) {
    console.log(`[Bridge/files] Error for userId: ${err.message}`);
    res.status(502).json({ error: "Bridge offline" });
  }
});

// GET /api/bridge/search?q=foo&path=~/Documents -- recursive find inside the panel's current path
app.get("/api/bridge/search", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });
  const raw = (req.query.q || "").trim();
  const safe = raw.replace(/[^\w.\- ]/g, "").slice(0, 80);
  if (!safe) return res.json({ files: [] });
  const ws = bridgeConnections.get("user:" + userId);
  if (!ws || ws.readyState !== 1) return res.status(502).json({ error: "Bridge offline" });
  // Normalize requested path (must be ~ or ~/subpath). Reject anything else.
  const rawPath = (req.query.path || "~").trim();
  const rel = rawPath.replace(/^~\/?/, "").replace(/\.\./g, "").replace(/[`"\\$]/g, "");
  const cdTarget = rel ? `"$HOME/${rel}"` : `"$HOME"`;
  const displayBase = rel ? "~/" + rel.replace(/\/$/, "") : "~";
  try {
    // Prune heavy dirs (Library, node_modules, Applications, dotfiles) so we don't descend into them at all.
    // Two passes (dirs, files) keep output ordered and BSD-find compatible (no -printf).
    // -maxdepth caps pathological trees.
    // Use ".?*" (not ".*") to match hidden names: ".*" would also match the starting directory "."
    // and BSD find would prune-at-root and return nothing.
    const prune = `\\( -name '.?*' -o -name 'node_modules' -o -name 'Library' -o -name 'Applications' -o -name '.Trash' \\) -prune`;
    // awk handles \t as a tab on both BSD and GNU; BSD sed would emit the literal backslash-t.
    const cmd = `cd ${cdTarget} 2>/dev/null && { ` +
      `find . -maxdepth 6 ${prune} -o -type d -iname '*${safe}*' -print 2>/dev/null | head -50 | awk '{print "d\\t" $0}'; ` +
      `find . -maxdepth 6 ${prune} -o -type f -iname '*${safe}*' -print 2>/dev/null | head -150 | awk '{print "f\\t" $0}'; ` +
      `}`;
    const result = await bridgeWsRequest(userId, "shell.run", { command: cmd }, 25000);
    const out = (result?.result?.stdout || result?.stdout || "").trim();
    const files = out ? out.split("\n").map((line) => {
      const idx = line.indexOf("\t");
      if (idx < 0) return null;
      const typeChar = line.slice(0, idx);
      let r = line.slice(idx + 1);
      if (!r || r === ".") return null;
      if (r.indexOf("./") === 0) r = r.slice(2);
      const displayPath = displayBase === "~" ? "~/" + r : displayBase + "/" + r;
      const name = r.split("/").pop();
      if (!name || name.startsWith(".")) return null;
      return {
        name,
        path: displayPath,
        type: typeChar === "d" ? "directory" : "file",
        size: 0,
        modified: null,
      };
    }).filter(Boolean) : [];
    res.json({ files });
  } catch (err) {
    console.log(`[Bridge/search] Error: ${err.message}`);
    res.status(502).json({ error: "Bridge offline" });
  }
});

// Thumbnail cache and pending tokens
const _thumbCache = new Map(); // "userId:path" -> { buffer, mime, expires }
const _thumbTokens = new Map(); // token -> { resolve, reject, expires }

// Clean stale cache entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _thumbCache) { if (v.expires < now) _thumbCache.delete(k); }
  for (const [k, v] of _thumbTokens) { if (v.expires < now) { v.reject(new Error("expired")); _thumbTokens.delete(k); } }
}, 600000);

// GET /api/bridge/thumbnail?path=~/path/to/image.jpg - serve local image via Bridge curl upload
app.get("/api/bridge/thumbnail", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).end();
  const filePath = req.query.path;
  if (!filePath) return res.status(400).end();

  // Check memory cache
  const cacheKey = userId + ":" + filePath;
  const cached = _thumbCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    res.setHeader("Content-Type", cached.mime);
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.send(cached.buffer);
  }

  try {
    const cleanPath = filePath.replace(/^~\/?/, "").replace(/'/g, "'\\''");
    const token = crypto.randomUUID();
    const baseUrl = BASE_URL;

    // Create a promise that resolves when the Bridge uploads the file
    const thumbPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { _thumbTokens.delete(token); reject(new Error("timeout")); }, 12000);
      _thumbTokens.set(token, { resolve, reject, timer, expires: Date.now() + 15000 });
    });

    // Tell Bridge to curl the file to our upload endpoint (same proven mechanism as file copies)
    const cmd = `curl -s -X POST -F "file=@$HOME/${cleanPath}" "${baseUrl}/api/bridge/thumb-upload?token=${token}"`;
    bridgeWsRequest(userId, "shell.run", { command: cmd }, 12000).catch(() => {});

    const { buffer, mime } = await thumbPromise;
    _thumbCache.set(cacheKey, { buffer, mime, expires: Date.now() + 3600000 });
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(buffer);
  } catch (e) {
    console.log(`[Bridge/thumb] Failed for ${filePath}: ${e.message}`);
    res.status(502).end();
  }
});

// POST /api/bridge/thumb-upload?token=xxx - receives the file from Bridge curl
app.post("/api/bridge/thumb-upload", _bridgeUpload.single("file"), (req, res) => {
  const token = req.query.token;
  const pending = _thumbTokens.get(token);
  if (!pending || pending.expires < Date.now()) return res.status(401).json({ error: "Invalid token" });
  clearTimeout(pending.timer);
  _thumbTokens.delete(token);
  if (!req.file) return res.status(400).json({ error: "No file" });
  const name = req.file.originalname || "";
  const ext = name.split(".").pop().toLowerCase();
  const mime = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" }[ext] || "image/jpeg";
  pending.resolve({ buffer: req.file.buffer, mime });
  res.json({ ok: true });
});

// POST /api/account/clear-conversations — empty conversation history only
app.post("/api/account/clear-conversations", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });

  try {
    const { error } = await supabase
      .from("conversations")
      .update({ messages: [], summary: null })
      .eq("user_id", userId);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error("Clear conversations error:", err.message);
    res.status(500).json({ error: "Failed to clear conversations" });
  }
});

// POST /api/account/clear-data — reset all data but keep profile & connections
app.post("/api/account/clear-data", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });

  try {
    // Fetch attachment paths for storage cleanup
    const { data: attachments } = await supabase
      .from("attachments")
      .select("storage_path")
      .eq("user_id", userId);

    const storagePaths = (attachments || []).map(a => a.storage_path).filter(Boolean);

    // Parallel delete all user data (keep profiles, connections, chat_links)
    // Also clear onboarding state from profile settings so it re-triggers
    const { data: profile } = await supabase
      .from("profiles")
      .select("settings")
      .eq("id", userId)
      .single();

    const currentSettings = profile?.settings || {};
    const { onboarding_step, preferred_name, bot_name, personality, ...cleanSettings } = currentSettings;

    await Promise.all([
      supabase.from("conversations").update({ messages: [], summary: null }).eq("user_id", userId),
      supabase.from("facts").delete().eq("user_id", userId),
      supabase.from("schedules").delete().eq("user_id", userId),
      supabase.from("attachments").delete().eq("user_id", userId),
      supabase.from("pulse_config").delete().eq("user_id", userId),
      supabase.from("agent_tasks").delete().eq("user_id", userId),
      supabase.from("data_vectors").delete().eq("user_id", userId).eq("service", "memory"),
      supabase.from("profiles").update({ settings: cleanSettings, updated_at: new Date().toISOString() }).eq("id", userId),
    ]);

    // Clean up storage bucket
    if (storagePaths.length > 0) {
      await supabase.storage.from("attachments").remove(storagePaths);
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Clear data error:", err.message);
    res.status(500).json({ error: "Failed to reset data" });
  }
});

// DELETE /api/account — full account deletion
app.delete("/api/account", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });

  try {
    // Fetch attachment paths for storage cleanup
    const { data: attachments } = await supabase
      .from("attachments")
      .select("storage_path")
      .eq("user_id", userId);

    const storagePaths = (attachments || []).map(a => a.storage_path).filter(Boolean);

    // Delete all user data from every table
    await Promise.all([
      supabase.from("conversations").delete().eq("user_id", userId),
      supabase.from("facts").delete().eq("user_id", userId),
      supabase.from("schedules").delete().eq("user_id", userId),
      supabase.from("attachments").delete().eq("user_id", userId),
      supabase.from("pulse_config").delete().eq("user_id", userId),
      supabase.from("connections").delete().eq("user_id", userId),
      supabase.from("chat_links").delete().eq("user_id", userId),
      supabase.from("agent_tasks").delete().eq("user_id", userId),
      supabase.from("data_vectors").delete().eq("user_id", userId).eq("service", "memory"),
      supabase.from("sandboxes").delete().eq("user_id", userId),
      supabase.from("wa_pending_links").delete().eq("user_id", userId),
    ]);

    // Clean up storage bucket
    if (storagePaths.length > 0) {
      await supabase.storage.from("attachments").remove(storagePaths);
    }

    // Delete profile last (other tables FK to it)
    await supabase.from("profiles").delete().eq("id", userId);

    // Clear auth cookie and redirect
    res.setHeader("Set-Cookie", "ch_user=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
    res.json({ success: true, redirect: "/" });
  } catch (err) {
    console.error("Account delete error:", err.message);
    res.status(500).json({ error: "Failed to delete account" });
  }
});

// ============================================================
// SUPABASE HELPERS
// ============================================================



// ============================================================
// BRIDGE (Mac app) ENDPOINTS
// ============================================================

// Bridge pairing
app.post("/api/bridge/pair", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "Pairing code required" });

    // Store the pairing request in Supabase for the bot to pick up
    const token = require("crypto").randomBytes(32).toString("hex");
    const { error } = await supabase
      .from("user_bridges")
      .upsert({
        user_id: userId,
        token,
        status: "pending_pair",
        pairing_code: code.toUpperCase(),
        paired_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    console.error("Bridge pair error:", e.message);
    res.status(500).json({ error: "Pairing failed" });
  }
});

// Check bridge status
app.get("/api/bridge/status", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    const { data } = await supabase
      .from("user_bridges")
      .select("status, paired_at")
      .eq("user_id", userId)
      .single();
    if (!data) return res.json({ status: "not_paired" });
    // Check if there's actually a live WebSocket
    const ws = bridgeConnections.get("user:" + userId);
    const actuallyConnected = ws && ws.readyState === 1;
    // Return connected only if WS is live. Do NOT delete the pairing record
    // if WS is temporarily absent - Bridge may reconnect.
    res.json({ status: actuallyConnected ? "connected" : data.status === "connected" ? "reconnecting" : data.status, paired_at: data.paired_at });
  } catch (e) {
    res.json({ status: "not_paired" });
  }
});

// Disconnect bridge
app.delete("/api/bridge", async (req, res) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    await supabase.from("user_bridges").delete().eq("user_id", userId);
    res.json({ success: true });
  } catch (e) {
    console.error("Bridge disconnect error:", e.message);
    res.status(500).json({ error: "Failed to disconnect" });
  }
});

// Bridge push sync: Bridge app pushes email/calendar data directly
// Authenticated by bridge token (same token used for WebSocket auth)
app.post("/api/bridge/sync-cache", async (req, res) => {
  try {
    // Extract bridge token from Authorization header
    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return res.status(401).json({ error: "Bridge token required" });

    // Look up user by bridge token
    const { data: bridge, error: bridgeErr } = await supabase
      .from("user_bridges")
      .select("user_id")
      .eq("token", token)
      .single();
    if (bridgeErr || !bridge) return res.status(403).json({ error: "Invalid bridge token" });

    const userId = bridge.user_id;
    const { items } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items array required" });
    }

    console.log(`[Bridge-Sync] Received ${items.length} items from Bridge for user ${userId}`);

    // Build rows for upsert into data_cache, deduplicate by source+external_id
    const now = new Date().toISOString();
    const seen = new Set();
    const rows = items.filter(item => {
      const key = `${item.source || "bridge"}:${item.external_id || ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map(item => ({
      user_id: userId,
      source: item.source || "bridge",
      type: item.type || "unknown",
      external_id: String(item.external_id || ""),
      data: item.data || {},
      synced_at: now,
      received_at: (() => {
        try {
          if (!item.received_at) return null;
          // Try standard parse first
          let d = new Date(item.received_at);
          if (!isNaN(d.getTime())) return d.toISOString();
          // Try AppleScript format: "Thursday, 3 April 2026 at 10:30:00"
          const cleaned = String(item.received_at).replace(/^\w+,\s*/, "").replace(" at ", " ");
          d = new Date(cleaned);
          if (!isNaN(d.getTime())) return d.toISOString();
          return null;
        } catch { return null; }
      })(),
    }));

    // Batch upsert in chunks of 50
    let upserted = 0;
    for (let i = 0; i < rows.length; i += 50) {
      const batch = rows.slice(i, i + 50);
      const { error } = await supabase
        .from("data_cache")
        .upsert(batch, { onConflict: "user_id,source,external_id" });
      if (error) {
        console.error(`[Bridge-Sync] Upsert error: ${error.message}`);
      } else {
        upserted += batch.length;
      }
    }

    // Evict oldest beyond 100 per source
    const sources = [...new Set(rows.map(r => r.source))];
    for (const src of sources) {
      const { data: keep } = await supabase
        .from("data_cache").select("id").eq("user_id", userId).eq("source", src)
        .order("received_at", { ascending: false, nullsFirst: false }).limit(100);
      if (keep && keep.length >= 100) {
        const keepIds = keep.map(r => r.id);
        await mustWrite("could not clear that cached data", supabase.from("data_cache").delete()
          .eq("user_id", userId).eq("source", src)
          .not("id", "in", `(${keepIds.join(",")})`));
      }
    }

    console.log(`[Bridge-Sync] Upserted ${upserted}/${rows.length} items for user ${userId}`);
    res.json({ success: true, upserted });
  } catch (e) {
    console.error(`[Bridge-Sync] Error: ${e.message}`);
    res.status(500).json({ error: "Sync failed" });
  }
});

// Bridge data relay (called by bot process to request data from Bridge app)
app.post("/api/bridge/request", async (req, res) => {
  const _t0 = Date.now();
  try {
    const { userId, action, params, secret } = req.body;
    console.log(`[Bridge] Request received: userId=${userId}, action=${action}, from=${req.ip}`);
    // Simple shared secret auth between bot and webapp
    if (secret !== process.env.BRIDGE_RELAY_SECRET && secret !== process.env.COOKIE_SECRET) {
      console.log("[Bridge] Request rejected: bad secret");
      return res.status(403).json({ error: "Unauthorized" });
    }
    if (!userId || !action) return res.status(400).json({ error: "userId and action required" });

    // Try to find a live WebSocket, with retry for reconnection gaps
    let ws = bridgeConnections.get("user:" + userId);
    if (!ws || ws.readyState !== 1) {
      console.log(`[Bridge] No live WebSocket for user ${userId} (ws=${ws ? "exists,state=" + ws.readyState : "missing"}). Waiting 5s for reconnect...`);
      // Wait for the bridge app to reconnect (it retries every 5s)
      await new Promise(r => setTimeout(r, 5000));
      ws = bridgeConnections.get("user:" + userId);
      if (!ws || ws.readyState !== 1) {
        console.log(`[Bridge] Still no WebSocket after retry. Keys: ${[...bridgeConnections.keys()].join(", ")}`);
        return res.status(404).json({ error: "Bridge not connected" });
      }
      console.log(`[Bridge] WebSocket reconnected after retry for user ${userId}`);
    }
    console.log(`[Bridge] WebSocket found for user ${userId}, readyState=${ws.readyState}`);

    // Helper to send a request and wait for response
    async function sendBridgeRequest(targetWs) {
      const requestId = require("crypto").randomUUID();
      if (!targetWs._pendingCallbacks) targetWs._pendingCallbacks = new Map();

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          targetWs._pendingCallbacks.delete(requestId);
          console.log(`[Bridge] Request TIMED OUT after 25s: userId=${userId}, action=${action}, requestId=${requestId}`);
          reject(new Error("Bridge request timed out"));
        }, 25000);

        targetWs._pendingCallbacks.set(requestId, { resolve, reject, timer });
        targetWs.send(JSON.stringify({ type: "request", id: requestId, action, params: params || {} }));
        console.log(`[Bridge] Request sent: requestId=${requestId}, action=${action}`);
      });
    }

    // Try request, retry once if disconnect mid-request
    let result;
    try {
      result = await sendBridgeRequest(ws);
    } catch (firstError) {
      if (firstError.message.includes("disconnect") || firstError.message.includes("timed out")) {
        console.log(`[Bridge] First attempt failed (${firstError.message}), waiting 5s for reconnect...`);
        await new Promise(r => setTimeout(r, 5000));
        const retryWs = bridgeConnections.get("user:" + userId);
        if (retryWs && retryWs.readyState === 1) {
          console.log(`[Bridge] Retrying after reconnect...`);
          result = await sendBridgeRequest(retryWs);
        } else {
          throw firstError;
        }
      } else {
        throw firstError;
      }
    }

    console.log(`[Bridge] Sending response: ${JSON.stringify(result).length} chars, took ${Date.now() - _t0}ms`);
    res.json({ success: true, data: result });
  } catch (e) {
    console.log(`[Bridge] Request error after ${Date.now() - _t0}ms: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// VNC PROXY (Cloud Computer Desktop)
// ============================================================

// Token endpoint for VNC connections
app.get("/api/sandbox/vnc-token", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });
  const { data: sandbox } = await supabase.from("sandboxes")
    .select("hostname, sandbox_token").eq("user_id", userId).eq("status", "active").single();
  if (!sandbox?.hostname) return res.status(404).json({ error: "No active sandbox" });
  const token = crypto.randomBytes(16).toString("hex");
  if (!global._vncTokens) global._vncTokens = {};
  global._vncTokens[token] = { userId, hostname: sandbox.hostname, sandboxToken: sandbox.sandbox_token, expires: Date.now() + 300000 };
  res.json({ token });
});

// Diagnostic: test VNC connectivity to sandbox
app.get("/api/sandbox/vnc-diag", async (req, res) => {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: "Not logged in" });
  const { data: sandbox } = await supabase.from("sandboxes")
    .select("hostname, sandbox_token").eq("user_id", userId).eq("status", "active").single();
  if (!sandbox?.hostname) return res.json({ error: "No active sandbox in DB" });

  const diag = { hostname: sandbox.hostname, tests: {} };

  // Test 1: DNS resolution
  try {
    const dns = require("dns");
    const addrs = await new Promise((resolve, reject) => {
      dns.resolve(sandbox.hostname, (err, a) => err ? reject(err) : resolve(a));
    }).catch(() => null);
    const addrs6 = await new Promise((resolve, reject) => {
      dns.resolve6(sandbox.hostname, (err, a) => err ? reject(err) : resolve(a));
    }).catch(() => null);
    diag.tests.dns = { ipv4: addrs, ipv6: addrs6 };
  } catch (e) { diag.tests.dns = { error: e.message }; }

  // Test 2: HTTP to agent on port 8080
  try {
    const http = require("http");
    const agentOk = await new Promise((resolve) => {
      const r = http.get(`http://${sandbox.hostname}:8080/health`, { timeout: 5000 }, (resp) => {
        let d = ""; resp.on("data", c => d += c); resp.on("end", () => resolve(d));
      });
      r.on("error", (e) => resolve("error: " + e.message));
      r.on("timeout", () => { r.destroy(); resolve("timeout"); });
    });
    diag.tests.agent_8080 = agentOk;
  } catch (e) { diag.tests.agent_8080 = e.message; }

  // Test 3: WebSocket to websockify on port 6080
  try {
    const WebSocket = require("ws");
    const wsOk = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://${sandbox.hostname}:6080`, { handshakeTimeout: 5000 });
      ws.on("open", () => { ws.close(); resolve("connected"); });
      ws.on("error", (e) => resolve("error: " + e.message));
      setTimeout(() => { ws.terminate(); resolve("timeout after 5s"); }, 5500);
    });
    diag.tests.websockify_6080 = wsOk;
  } catch (e) { diag.tests.websockify_6080 = e.message; }

  // Test 4: Desktop status endpoint
  try {
    const http = require("http");
    const desktopStatus = await new Promise((resolve) => {
      const r = http.get(`http://${sandbox.hostname}:8080/desktop/status`, {
        timeout: 5000,
        headers: { "X-Sandbox-Token": sandbox.sandbox_token },
      }, (resp) => {
        let d = ""; resp.on("data", c => d += c); resp.on("end", () => resolve(d));
      });
      r.on("error", (e) => resolve("error: " + e.message));
      r.on("timeout", () => { r.destroy(); resolve("timeout"); });
    });
    diag.tests.desktop_status = desktopStatus;
  } catch (e) { diag.tests.desktop_status = e.message; }

  // Test 5: Run process check inside sandbox via exec endpoint
  try {
    const http = require("http");
    const execResult = await new Promise((resolve) => {
      const payload = JSON.stringify({ language: "bash", code: "ps aux | grep -E 'Xvfb|x11vnc|websockify|fluxbox' | grep -v grep; echo '---WHICH---'; which Xvfb x11vnc websockify 2>&1; echo '---ENTRY---'; head -5 /entrypoint.sh 2>&1; echo '---DISPLAY---'; echo $DISPLAY" });
      const opts = { hostname: sandbox.hostname, port: 8080, path: "/exec", method: "POST", timeout: 10000,
        headers: { "Content-Type": "application/json", "X-Sandbox-Token": sandbox.sandbox_token, "Content-Length": Buffer.byteLength(payload) } };
      const r = http.request(opts, (resp) => { let d = ""; resp.on("data", c => d += c); resp.on("end", () => resolve(d)); });
      r.on("error", (e) => resolve("error: " + e.message));
      r.on("timeout", () => { r.destroy(); resolve("timeout"); });
      r.write(payload); r.end();
    });
    diag.tests.exec_check = execResult;
  } catch (e) { diag.tests.exec_check = e.message; }

  res.json(diag);
});

// ============================================================
// START SERVER
// ============================================================

const server = app.listen(PORT, async () => {
  await ensureAdmin(); // single-tenant admin ready before we announce readiness
  const configured = Object.entries(SERVICES).filter(([, s]) => s.clientId && s.clientSecret).map(([k]) => k);
  console.log(`\n🚀 ClosedHand web app running on port ${PORT}`);
  console.log(`   ${BASE_URL}`);
  console.log(`   OAuth services configured: ${configured.join(", ") || "none"}\n`);

  // Documents pinned at "processing" are not covered by the source resume
  // below, so clear them first and re-check periodically.
  ragProcessor.recoverStalledDocuments().catch(() => {});
  setInterval(() => ragProcessor.recoverStalledDocuments().catch(() => {}), 15 * 60 * 1000);

  // Resume stuck RAG indexing jobs (process died on previous deploy)
  try {
    const { data: stuck } = await supabase.from("rag_sources").select("id, user_id, origin, path").eq("status", "indexing");
    if (stuck && stuck.length > 0) {
      console.log(`[RAG] Resuming ${stuck.length} stuck indexing job(s)`);
      for (const src of stuck) {
        ragProcessor.processSource(src.id, src.user_id, src.origin, src.path).catch(e => console.error(`[RAG] Resume failed for ${src.id}:`, e.message));
      }
    }
  } catch (e) { console.error("[RAG] Startup resume check failed:", e.message); }
});

// WebSocket server for Bridge app connections
const { WebSocketServer } = require("ws");
const bridgeConnections = new Map(); // "user:<id>" -> ws, or "<CODE>" -> ws

const wss = new WebSocketServer({ noServer: true });

// Ping all bridge connections every 20s to keep them alive
// Uses isAlive flag: if pong wasn't received since last ping, terminate.
setInterval(() => {
  for (const [key, ws] of bridgeConnections) {
    if (ws.readyState !== 1) {
      console.log(`[Bridge] Ping cleanup: removing dead connection key=${key}, readyState=${ws.readyState}`);
      bridgeConnections.delete(key);
      continue;
    }
    if (!ws.isAlive) {
      console.log(`[Bridge] Ping timeout: no pong received for key=${key}, terminating`);
      bridgeConnections.delete(key);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 20000);

wss.on("connection", (ws) => {
  console.log("[Bridge] New WebSocket connection");
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "pair" && msg.code) {
        // Bridge app registering its pairing code
        console.log(`[Bridge] Pairing code registered: ${msg.code.toUpperCase()}`);
        bridgeConnections.set(msg.code.toUpperCase(), ws);
        ws.bridgeCode = msg.code.toUpperCase();
        ws.send(JSON.stringify({ type: "waiting" }));
      }
      if (msg.type === "auth" && msg.token) {
        // Bridge app reconnecting with saved token
        console.log("[Bridge] Auth attempt with token");
        const { data } = await supabase
          .from("user_bridges")
          .select("user_id")
          .eq("token", msg.token)
          .eq("status", "connected")
          .single();
        if (data) {
          // If there's an old connection for this user, clean it up first
          const existingWs = bridgeConnections.get("user:" + data.user_id);
          if (existingWs && existingWs !== ws) {
            console.log(`[Bridge] Replacing stale connection for user ${data.user_id}`);
            // Reject any pending callbacks on the old connection
            if (existingWs._pendingCallbacks && existingWs._pendingCallbacks.size > 0) {
              console.log(`[Bridge] Rejecting ${existingWs._pendingCallbacks.size} pending callbacks on stale connection`);
              for (const [id, pending] of existingWs._pendingCallbacks) {
                clearTimeout(pending.timer);
                pending.reject(new Error("Bridge reconnected, old connection replaced"));
              }
              existingWs._pendingCallbacks.clear();
            }
            existingWs.bridgeUserId = null; // Prevent close handler from removing new entry
            existingWs.terminate();
          }
          ws.bridgeUserId = data.user_id;
          bridgeConnections.set("user:" + data.user_id, ws);
          ws.send(JSON.stringify({ type: "authenticated", userId: data.user_id }));
          console.log(`[Bridge] Authenticated user ${data.user_id}`);
        } else {
          ws.send(JSON.stringify({ type: "error", message: "Invalid token" }));
          console.log("[Bridge] Auth failed: invalid token");
        }
      }
      if (msg.type === "disconnect" && ws.bridgeUserId) {
        // Bridge app explicitly disconnecting (user clicked Disconnect)
        console.log(`[Bridge] Explicit disconnect from user ${ws.bridgeUserId}`);
        await supabase.from("user_bridges").delete().eq("user_id", ws.bridgeUserId);
        bridgeConnections.delete("user:" + ws.bridgeUserId);
        ws.bridgeUserId = null;
        ws.close();
      }
      if (msg.type === "response" && msg.id) {
        // Bridge responding to a data request
        const pending = ws._pendingCallbacks?.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          console.log(`[Bridge] Response received: requestId=${msg.id}, userId=${ws.bridgeUserId}`);
          pending.resolve(msg.data);
          ws._pendingCallbacks.delete(msg.id);
        } else {
          console.log(`[Bridge] Response received for unknown requestId=${msg.id} (may have timed out)`);
        }
      }
    } catch (e) { console.error("[Bridge] WS message error:", e.message); }
  });
  ws.on("close", (code, reason) => {
    console.log(`[Bridge] WebSocket closed: code=${code}, userId=${ws.bridgeUserId || "none"}, pairingCode=${ws.bridgeCode || "none"}`);
    if (ws.bridgeCode) bridgeConnections.delete(ws.bridgeCode);
    // Only remove user entry if this ws is still the current one (prevents race condition on reconnect)
    if (ws.bridgeUserId && bridgeConnections.get("user:" + ws.bridgeUserId) === ws) {
      bridgeConnections.delete("user:" + ws.bridgeUserId);
      console.log(`[Bridge] Removed connection for user ${ws.bridgeUserId}`);
    }
    // Reject any pending callbacks so relay requests fail fast instead of waiting 30s
    if (ws._pendingCallbacks && ws._pendingCallbacks.size > 0) {
      console.log(`[Bridge] Rejecting ${ws._pendingCallbacks.size} pending callbacks due to disconnect`);
      for (const [id, pending] of ws._pendingCallbacks) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Bridge disconnected while request was pending"));
      }
      ws._pendingCallbacks.clear();
    }
  });
  ws.on("error", (err) => {
    console.error(`[Bridge] WebSocket error: ${err.message}`);
  });
});

// Poll for pending pairing requests and match to WebSocket clients
setInterval(async () => {
  try {
    const { data: pending } = await supabase
      .from("user_bridges")
      .select("user_id, token, pairing_code")
      .eq("status", "pending_pair");
    if (!pending || !pending.length) return;
    for (const row of pending) {
      const code = (row.pairing_code || "").toUpperCase();
      const ws = bridgeConnections.get(code);
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "paired", userId: row.user_id, token: row.token }));
        ws.bridgeUserId = row.user_id;
        bridgeConnections.set("user:" + row.user_id, ws);
        bridgeConnections.delete(code);
        await supabase.from("user_bridges").update({ status: "connected", pairing_code: null }).eq("user_id", row.user_id);
        console.log("Bridge paired for user " + row.user_id);
      }
    }
  } catch (e) {}
}, 3000);

// ============================================================
// BRIDGE REQUEST BROKER via Supabase Realtime
// Listens for new pending rows in bridge_requests, forwards to
// the Bridge WebSocket, writes result back to the row.
// ============================================================

supabase.channel("bridge-requests-listener")
  .on("postgres_changes", {
    event: "INSERT",
    schema: "public",
    table: "bridge_requests",
    filter: "status=eq.pending",
  }, async (payload) => {
    const row = payload.new;
    if (!row || row.status !== "pending") return;

    const { id, user_id: userId, action, params } = row;
    console.log(`[Bridge-Broker] Received pending request ${id}: userId=${userId}, action=${action}`);

    try {
      // Find the Bridge WebSocket for this user
      let ws = bridgeConnections.get("user:" + userId);
      if (!ws || ws.readyState !== 1) {
        // Brief wait for reconnection
        await new Promise(r => setTimeout(r, 3000));
        ws = bridgeConnections.get("user:" + userId);
      }
      if (!ws || ws.readyState !== 1) {
        console.log(`[Bridge-Broker] No live WebSocket for user ${userId}`);
        await supabase.from("bridge_requests").update({ status: "error", error: "Bridge not connected" }).eq("id", id);
        return;
      }

      // Send request to Bridge WS and wait for response (reuse callback pattern)
      const requestId = require("crypto").randomUUID();
      if (!ws._pendingCallbacks) ws._pendingCallbacks = new Map();

      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          ws._pendingCallbacks.delete(requestId);
          console.log(`[Bridge-Broker] Request ${id} timed out after 180s`);
          reject(new Error("Bridge request timed out"));
        }, 180000);

        ws._pendingCallbacks.set(requestId, { resolve, reject, timer });
        ws.send(JSON.stringify({ type: "request", id: requestId, action, params: params || {} }));
        console.log(`[Bridge-Broker] Forwarded to WS: requestId=${requestId}, action=${action}`);
      });

      console.log(`[Bridge-Broker] Request ${id} completed, writing result`);
      await supabase.from("bridge_requests").update({ status: "completed", result }).eq("id", id);
    } catch (e) {
      console.log(`[Bridge-Broker] Request ${id} failed: ${e.message}`);
      await supabase.from("bridge_requests").update({ status: "error", error: e.message }).eq("id", id);
    }
  })
  .subscribe((status) => {
    console.log(`[Bridge-Broker] Supabase Realtime subscription status: ${status}`);
  });

// Also poll for pending requests as fallback (in case Realtime misses an insert)
setInterval(async () => {
  try {
    const { data: pending } = await supabase
      .from("bridge_requests")
      .select("*")
      .eq("status", "pending")
      .lt("created_at", new Date(Date.now() - 2000).toISOString()) // Only pick up rows older than 2s (give Realtime a chance first)
      .limit(5);
    if (!pending || !pending.length) return;

    for (const row of pending) {
      const { id, user_id: userId, action, params } = row;
      console.log(`[Bridge-Broker-Poll] Processing stale pending request ${id}`);

      // Mark as in-progress to avoid double processing
      const { error: claimErr } = await supabase
        .from("bridge_requests")
        .update({ status: "processing" })
        .eq("id", id)
        .eq("status", "pending");
      if (claimErr) continue; // Another instance may have claimed it

      try {
        const ws = bridgeConnections.get("user:" + userId);
        if (!ws || ws.readyState !== 1) {
          await supabase.from("bridge_requests").update({ status: "error", error: "Bridge not connected" }).eq("id", id);
          continue;
        }

        const requestId = require("crypto").randomUUID();
        if (!ws._pendingCallbacks) ws._pendingCallbacks = new Map();

        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            ws._pendingCallbacks.delete(requestId);
            reject(new Error("Bridge request timed out"));
          }, 60000);
          ws._pendingCallbacks.set(requestId, { resolve, reject, timer });
          ws.send(JSON.stringify({ type: "request", id: requestId, action, params: params || {} }));
        });

        await supabase.from("bridge_requests").update({ status: "completed", result }).eq("id", id);
      } catch (e) {
        await supabase.from("bridge_requests").update({ status: "error", error: e.message }).eq("id", id);
      }
    }
  } catch (e) {
    // Ignore poll errors
  }
}, 5000);

// Cleanup old bridge_requests rows (older than 5 minutes) every 60s
setInterval(async () => {
  try {
    await supabase
      .from("bridge_requests")
      .delete()
      .lt("created_at", new Date(Date.now() - 300000).toISOString());
  } catch (e) {
    // Ignore cleanup errors
  }
}, 60000);

// VNC WebSocket Proxy (Cloud Computer Desktop)
// Compression disabled, explicit binary frame handling for VNC protocol.
const vncWss = new (require("ws").WebSocketServer)({ noServer: true, perMessageDeflate: false });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/bridge") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
    return;
  }

  if (url.pathname === "/vnc") {
    const token = url.searchParams.get("token");
    if (!token || !global._vncTokens?.[token]) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const { hostname, expires } = global._vncTokens[token];
    if (Date.now() > expires) {
      delete global._vncTokens[token];
      socket.write("HTTP/1.1 401 Token expired\r\n\r\n");
      socket.destroy();
      return;
    }

    vncWss.handleUpgrade(req, socket, head, (clientWs) => {
      console.log(`[VNC] Client connected, proxying to ${hostname}:6080`);
      const WS = require("ws");
      const targetWs = new WS(`ws://${hostname}:6080`, { perMessageDeflate: false });

      targetWs.on("open", () => {
        console.log(`[VNC] Connected to sandbox websockify`);
        // Forward with explicit binary flag preservation (critical for VNC)
        clientWs.on("message", (data, isBinary) => {
          if (targetWs.readyState === WS.OPEN) targetWs.send(data, { binary: isBinary });
        });
        targetWs.on("message", (data, isBinary) => {
          if (clientWs.readyState === WS.OPEN) clientWs.send(data, { binary: isBinary });
        });
      });

      targetWs.on("error", (err) => {
        console.error(`[VNC] Target error: ${err.message}`);
        clientWs.close(1011, "Sandbox connection failed");
      });
      targetWs.on("close", (code, reason) => {
        console.log(`[VNC] Target closed: ${code} ${reason}`);
        clientWs.close();
      });
      clientWs.on("close", () => targetWs.close());
      clientWs.on("error", () => targetWs.close());
    });
    return;
  }

  socket.destroy();
});
