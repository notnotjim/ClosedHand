// lib/services/google.js — Google token management + API request helper
//
// Multi-account: the primary (login) account lives under service key "google".
// Extra accounts live under "google_extra_<slug>" keys. Every function takes an
// optional serviceKey defaulting to "google", so existing call sites are
// untouched and extras opt in explicitly.

const https = require("https");
const ctx = require("../context");

// Via runtime config so wizard-saved credentials work without a restart.
const GOOGLE_CLIENT_ID = () => require("../config").getConfCached("GOOGLE_CLIENT_ID");
const GOOGLE_CLIENT_SECRET = () => require("../config").getConfCached("GOOGLE_CLIENT_SECRET");

const EXTRA_PREFIX = "google_extra_";

function loadGoogleTokens(userStore, serviceKey = "google") {
  const store = userStore || ctx.activeUserStore;
  if (!store) return null;
  const conn = store.getConnection(serviceKey);
  // A connection with a dead refresh token is skipped until the user reconnects,
  // so sync stops attempting a refresh that can only ever fail again.
  if (conn?.metadata?.reconnect_required) return null;
  return conn?.tokens || null;
}

function saveGoogleTokens(tokens, userStore, serviceKey = "google") {
  const store = userStore || ctx.activeUserStore;
  if (!store) return;
  store.saveConnectionTokens(serviceKey, tokens);
}

function refreshGoogleToken(tokens, userStore, serviceKey = "google") {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID(),
      client_secret: GOOGLE_CLIENT_SECRET(),
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token",
    }).toString();

    const req = https.request(
      {
        hostname: "oauth2.googleapis.com",
        path: "/token",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          if (data.error) {
            console.error(`[Google] Token refresh failed (${serviceKey}): ${data.error} (${data.error_description || ""})`);
            reject(new Error(`Token refresh failed: ${data.error}`));
          } else {
            tokens.access_token = data.access_token;
            tokens.expiry = Date.now() + data.expires_in * 1000;
            saveGoogleTokens(tokens, userStore, serviceKey);
            resolve(tokens);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

async function getGoogleToken(userStore, serviceKey = "google") {
  let tokens = loadGoogleTokens(userStore, serviceKey);
  if (!tokens) return null;
  // Refresh if expiring within 5 minutes
  if (Date.now() > tokens.expiry - 300000) {
    try {
      tokens = await refreshGoogleToken(tokens, userStore, serviceKey);
    } catch (e) {
      // A dead refresh token (invalid_grant) never recovers on its own, and
      // retrying it every sync cycle spammed the logs. Flag the connection so
      // loadGoogleTokens skips it from now on; a dashboard reconnect clears it.
      if (/invalid_grant/.test(e?.message || "")) {
        const store = userStore || ctx.activeUserStore;
        try { await store?.markConnectionReconnectRequired?.(serviceKey); } catch (_) {}
      }
      throw e;
    }
  }
  return tokens.access_token;
}

function isGoogleConnected(userStore) {
  return !!loadGoogleTokens(userStore);
}

// All Google accounts on this store: primary first, then extras.
function listGoogleAccounts(userStore) {
  const store = userStore || ctx.activeUserStore;
  if (!store) return [];
  const conns = store.connections || {};
  const accounts = [];
  if (conns.google) {
    accounts.push({
      serviceKey: "google",
      email: conns.google.metadata?.email || store.profile?.email || "",
      slug: "",
      primary: true,
    });
  }
  for (const key of Object.keys(conns)) {
    if (!key.startsWith(EXTRA_PREFIX)) continue;
    accounts.push({
      serviceKey: key,
      email: conns[key]?.metadata?.email || "",
      slug: key.slice(EXTRA_PREFIX.length),
      primary: false,
    });
  }
  return accounts;
}

// Map a user-supplied account hint (email or fragment) to a service key.
// null/empty -> primary. No match -> throws with the available accounts.
function resolveGoogleAccount(userStore, accountInput) {
  if (!accountInput || !String(accountInput).trim()) return "google";
  const hint = String(accountInput).trim().toLowerCase();
  const accounts = listGoogleAccounts(userStore);
  const matches = accounts.filter(a => (a.email || "").toLowerCase().includes(hint) || a.slug.toLowerCase().includes(hint));
  if (matches.length === 1) return matches[0].serviceKey;
  const list = accounts.map(a => a.email + (a.primary ? " (primary)" : "")).join(", ") || "none";
  if (matches.length === 0) throw new Error(`No Google account matches "${accountInput}". Connected accounts: ${list}`);
  throw new Error(`"${accountInput}" matches more than one Google account. Connected accounts: ${list}`);
}

// Map a data_cache source tag like "gmail_worka" or "gcal_worka" back to its
// service key. Plain "gmail"/"gcal" -> primary.
function serviceKeyForSourceTag(sourceTag) {
  const m = String(sourceTag || "").match(/^(?:gmail|gcal)_(.+)$/);
  return m ? EXTRA_PREFIX + m[1] : "google";
}

function googleApiRequest(method, url, body = null, userStore = null, serviceKey = "google") {
  return new Promise(async (resolve, reject) => {
    const token = await getGoogleToken(userStore, serviceKey);
    if (!token) return reject(new Error("Google not connected — connect it from your dashboard"));

    const parsedUrl = new URL(url);
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };

    let postData = null;
    if (body) {
      postData = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(postData);
    }

    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: method,
      headers: headers,
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode >= 400) {
          reject(new Error(`Google API ${res.statusCode}: ${text.substring(0, 200)}`));
        } else {
          // Binary responses (alt=media) aren't JSON - return as raw
          if (!text) resolve({});
          else {
            try { resolve(JSON.parse(text)); }
            catch (e) { resolve({ raw: text.substring(0, 10000), _binary: true }); }
          }
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Google API timeout")); });
    if (postData) req.write(postData);
    req.end();
  });
}

module.exports = {
  loadGoogleTokens, saveGoogleTokens, getGoogleToken, isGoogleConnected, googleApiRequest,
  listGoogleAccounts, resolveGoogleAccount, serviceKeyForSourceTag, EXTRA_PREFIX,
};
