// lib/gateway.js — Gateway proxy for sandbox containers
// Sandboxes call back to the bot to make authenticated API calls.
// Credentials never enter the sandbox — they're injected server-side.

const express = require("express");
const { supabase, UserStore } = require("../user-store");
const { makeRawRequest } = require("./http");
const { getGoogleToken, googleApiRequest, resolveGoogleAccount } = require("./services/google");
const { shopifyApiRequest } = require("./services/shopify");
const { slackApiRequest } = require("./services/slack-api");
const { metaApiRequest } = require("./services/meta");
const ctx = require("./context");

const router = express.Router();

const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

// --- Rate limiting (in-memory, per user) ---
const rateLimits = {}; // userId -> { api: [{ts}], fetch: [{ts}] }
const API_LIMIT = 50;
const API_WINDOW = 10 * 60 * 1000; // 10 min
const FETCH_LIMIT = 100;
const FETCH_WINDOW = 10 * 60 * 1000;
const FETCH_MAX_SIZE = 5 * 1024 * 1024; // 5MB

function checkRate(userId, bucket, limit, windowMs) {
  if (!rateLimits[userId]) rateLimits[userId] = { api: [], fetch: [] };
  const now = Date.now();
  const entries = rateLimits[userId][bucket];
  // Prune old entries
  while (entries.length && entries[0] < now - windowMs) entries.shift();
  if (entries.length >= limit) return false;
  entries.push(now);
  return true;
}

// --- SSRF protection ---
function isBlockedUrl(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "[::1]" ||
      hostname.endsWith(".local") ||
      hostname.startsWith("10.") ||
      hostname.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
      hostname === "169.254.169.254" ||
      hostname.endsWith(".internal")
    );
  } catch {
    return true;
  }
}

// --- Auth middleware: verify sandbox token ---
// Static provider (self-host compose): one fixed container, one shared token
// from env, and every request belongs to the one admin. No sandboxes row.
const STATIC_SANDBOX_TOKEN = process.env.SANDBOX_URL ? (process.env.SANDBOX_TOKEN || "") : "";

async function verifySandboxToken(req, res, next) {
  const token = req.headers["x-sandbox-token"];

  if (STATIC_SANDBOX_TOKEN) {
    if (!token || token !== STATIC_SANDBOX_TOKEN) {
      return res.status(403).json({ error: "Invalid sandbox token" });
    }
    req.sandboxUserId = require("./admin").getAdminUserId();
    return next();
  }

  const userId = req.headers["x-user-id"];

  if (!token || !userId) {
    return res.status(401).json({ error: "Missing X-Sandbox-Token or X-User-Id" });
  }

  // Verify against Supabase sandboxes table
  const { data } = await supabase
    .from("sandboxes")
    .select("sandbox_token")
    .eq("user_id", userId)
    .eq("status", "active")
    .single();

  if (!data || data.sandbox_token !== token) {
    return res.status(403).json({ error: "Invalid sandbox token" });
  }

  req.sandboxUserId = userId;
  next();
}

// --- POST /gateway/api — Authenticated service calls ---
router.post("/api", verifySandboxToken, async (req, res) => {
  const userId = req.sandboxUserId;
  const { service, method = "GET", url, body, headers: extraHeaders, account } = req.body;

  if (!url) return res.status(400).json({ error: "Missing url" });
  if (!service) return res.status(400).json({ error: "Missing service" });

  if (isBlockedUrl(url)) {
    return res.status(403).json({ error: "Blocked: cannot make requests to private/internal addresses" });
  }

  if (!checkRate(userId, "api", API_LIMIT, API_WINDOW)) {
    return res.status(429).json({ error: "Rate limit exceeded (50 requests / 10 min)" });
  }

  console.log(`[gateway/api] ${method} ${url} (${service}${account ? `:${account}` : ""}) for user ${userId.substring(0, 8)}`);

  try {
    // Load the user's store and pass it explicitly to every helper: no global
    // ctx swap (the old save/restore pattern corrupted other users' context
    // whenever concurrent work interleaved across the awaits).
    const store = await UserStore.load(userId);

    let result;
    switch (service) {
      case "google": {
        // Multi-account: honour an account hint instead of silently using the
        // primary token, which put a nostringspadel reply draft into gmail.com.
        let gKey;
        try { gKey = resolveGoogleAccount(store, account); }
        catch (e) { return res.status(400).json({ error: e.message }); }
        result = await googleApiRequest(method.toUpperCase(), url, body || null, store, gKey);
        break;
      }
      case "shopify": {
        const shopifyPath = new URL(url).pathname.replace(/^\/admin\/api\/[^/]+/, "") || url;
        result = await shopifyApiRequest(method.toUpperCase(), shopifyPath, body || null, store);
        break;
      }
      case "meta": {
        const metaUrl = new URL(url);
        const metaPath = metaUrl.pathname.replace(/^\/v[\d.]+/, "") + metaUrl.search;
        result = await metaApiRequest(method.toUpperCase(), metaPath, body || null, store);
        break;
      }
      case "whatsapp":
        result = await makeRawRequest(method.toUpperCase(), url, body || null, {
          ...(extraHeaders || {}),
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        });
        break;
      case "slack":
        result = await slackApiRequest(method.toUpperCase(), url, body || null, store);
        break;
      default:
        result = await makeRawRequest(method.toUpperCase(), url, body || null, extraHeaders || {});
    }

    // Truncate large responses
    const resultStr = JSON.stringify(result);
    if (resultStr.length > 50000) {
      return res.json({ result_preview: resultStr.substring(0, 50000), _truncated: true });
    }
    res.json(result);
  } catch (e) {
    console.error(`[gateway/api] Error: ${e.message}`);
    res.status(502).json({ error: e.message });
  }
});

// --- POST /gateway/fetch — Public internet proxy ---
router.post("/fetch", verifySandboxToken, async (req, res) => {
  const userId = req.sandboxUserId;
  const { url, method = "GET", headers, body } = req.body;

  if (!url) return res.status(400).json({ error: "Missing url" });

  if (isBlockedUrl(url)) {
    return res.status(403).json({ error: "Blocked: cannot make requests to private/internal addresses" });
  }

  if (!checkRate(userId, "fetch", FETCH_LIMIT, FETCH_WINDOW)) {
    return res.status(429).json({ error: "Rate limit exceeded (100 requests / 10 min)" });
  }

  console.log(`[gateway/fetch] ${method} ${url} for user ${userId.substring(0, 8)}`);

  try {
    const result = await makeRawRequest(method.toUpperCase(), url, body || null, headers || {});

    // Size check
    const resultStr = JSON.stringify(result);
    if (resultStr.length > FETCH_MAX_SIZE) {
      return res.json({ result_preview: resultStr.substring(0, FETCH_MAX_SIZE), _truncated: true });
    }
    res.json(result);
  } catch (e) {
    console.error(`[gateway/fetch] Error: ${e.message}`);
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
