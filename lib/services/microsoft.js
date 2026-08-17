// lib/services/microsoft.js -- Microsoft Graph API helpers
// Token refresh + authenticated requests to graph.microsoft.com

const https = require("https");
const ctx = require("../context");

const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;

const EXTRA_PREFIX = "microsoft_extra_";

function loadMicrosoftTokens(userStore, serviceKey = "microsoft") {
  const store = userStore || ctx.activeUserStore;
  if (!store) return null;
  const conn = store.getConnection(serviceKey);
  return conn?.tokens || null;
}

function saveMicrosoftTokens(tokens, userStore, serviceKey = "microsoft") {
  const store = userStore || ctx.activeUserStore;
  if (!store) return;
  store.saveConnectionTokens(serviceKey, tokens);
}

// Same shape as the Google helpers: extra accounts are additive rows keyed
// microsoft_extra_<slug>, the primary is untouched, and every call site that
// says nothing gets the primary, so single-account behaviour is unchanged.
function listMicrosoftAccounts(userStore) {
  const store = userStore || ctx.activeUserStore;
  if (!store) return [];
  const conns = store.connections || {};
  const accounts = [];
  if (conns.microsoft) {
    accounts.push({
      serviceKey: "microsoft",
      email: conns.microsoft.metadata?.email || "",
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

function resolveMicrosoftAccount(userStore, accountInput) {
  if (!accountInput || !String(accountInput).trim()) return "microsoft";
  const hint = String(accountInput).trim().toLowerCase();
  const accounts = listMicrosoftAccounts(userStore);
  const matches = accounts.filter(a => (a.email || "").toLowerCase().includes(hint) || a.slug.toLowerCase().includes(hint));
  if (matches.length === 1) return matches[0].serviceKey;
  const list = accounts.map(a => a.email + (a.primary ? " (primary)" : "")).join(", ") || "none";
  if (matches.length === 0) throw new Error(`No Microsoft account matches "${accountInput}". Connected accounts: ${list}`);
  throw new Error(`"${accountInput}" matches more than one Microsoft account. Connected accounts: ${list}`);
}

// "outlook_worka" / "mscal_worka" -> microsoft_extra_worka; plain -> primary.
function msServiceKeyForSourceTag(sourceTag) {
  const m = String(sourceTag || "").match(/^(?:outlook|mscal)_(.+)$/);
  return m ? EXTRA_PREFIX + m[1] : "microsoft";
}

function isMicrosoftConnected(userStore, serviceKey = "microsoft") {
  const tokens = loadMicrosoftTokens(userStore, serviceKey);
  if (!tokens) return false;
  // Check if we have the minimum required fields
  if (!tokens.access_token && !tokens.refresh_token) {
    console.log("[microsoft] Connection exists but has no access_token or refresh_token, treating as disconnected");
    return false;
  }
  // If token is expired and there is no refresh_token, it is effectively disconnected
  if (tokens.expiry && Date.now() > tokens.expiry && !tokens.refresh_token) {
    console.log("[microsoft] Connection exists but token is expired with no refresh_token, treating as disconnected");
    return false;
  }
  return true;
}

function refreshMicrosoftToken(tokens, _userStore, serviceKey = "microsoft") {
  return new Promise((resolve, reject) => {
    if (!MICROSOFT_CLIENT_ID || !MICROSOFT_CLIENT_SECRET) {
      return reject(new Error("Microsoft OAuth not configured (missing client ID/secret)"));
    }

    const postData = new URLSearchParams({
      client_id: MICROSOFT_CLIENT_ID,
      client_secret: MICROSOFT_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token",
      scope: "openid profile email offline_access Mail.ReadWrite Mail.Send Calendars.ReadWrite Files.Read.All",
    }).toString();

    const req = https.request(
      {
        hostname: "login.microsoftonline.com",
        path: "/common/oauth2/v2.0/token",
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
            reject(new Error(`Microsoft token refresh failed: ${data.error_description || data.error}`));
          } else {
            tokens.access_token = data.access_token;
            tokens.expiry = Date.now() + data.expires_in * 1000;
            // Microsoft may rotate the refresh token
            if (data.refresh_token) {
              tokens.refresh_token = data.refresh_token;
            }
            saveMicrosoftTokens(tokens, _userStore, serviceKey);
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

async function getMicrosoftToken(userStore, serviceKey = "microsoft") {
  let tokens = loadMicrosoftTokens(userStore, serviceKey);
  if (!tokens) return null;
  // Refresh if expiring within 5 minutes
  if (Date.now() > tokens.expiry - 300000) {
    console.log(`[microsoft] Token expired or expiring soon (expiry=${new Date(tokens.expiry).toISOString()}), refreshing...`);
    try {
      tokens = await refreshMicrosoftToken(tokens, userStore, serviceKey);
      console.log("[microsoft] Token refreshed successfully");
    } catch (e) {
      console.error(`[microsoft] Token refresh failed: ${e.message}`);
      throw e;
    }
  }
  return tokens.access_token;
}

function microsoftApiRequest(method, url, body = null, userStore = null, serviceKey = "microsoft") {
  return new Promise(async (resolve, reject) => {
    const token = await getMicrosoftToken(userStore, serviceKey);
    if (!token) return reject(new Error("Microsoft not connected"));

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
          reject(new Error(`Microsoft API ${res.statusCode}: ${text.substring(0, 200)}`));
        } else {
          if (!text) resolve({});
          else {
            try { resolve(JSON.parse(text)); }
            catch (e) { resolve({ raw: text.substring(0, 10000), _binary: true }); }
          }
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Microsoft API timeout")); });
    if (postData) req.write(postData);
    req.end();
  });
}

module.exports = {
  isMicrosoftConnected, getMicrosoftToken, microsoftApiRequest,
  listMicrosoftAccounts, resolveMicrosoftAccount, msServiceKeyForSourceTag, EXTRA_PREFIX,
};
