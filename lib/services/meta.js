// lib/services/meta.js — Meta Ads token management + API request helper

const https = require("https");
const ctx = require("../context");

// Optional userStore = explicit threading for background/concurrent paths;
// ctx fallback keeps legacy chat paths working.
function getMetaAdsToken(userStore) {
  const store = userStore || ctx.activeUserStore;
  if (store) {
    const conn = store.getConnection("meta_ads");
    if (conn?.tokens?.access_token) return conn.tokens.access_token;
  }
  return null;
}

function getMetaAdAccountId() {
  if (ctx.activeUserStore) {
    const conn = ctx.activeUserStore.getConnection("meta_ads");
    // metadata.adAccounts[].accountId is numeric, API needs "act_" prefix
    const accounts = conn?.metadata?.adAccounts;
    if (accounts?.length > 0) {
      const id = String(accounts[0].accountId);
      return id.startsWith("act_") ? id : `act_${id}`;
    }
  }
  return null;
}

// Fetch all ad accounts from Meta API
async function fetchMetaAdAccounts() {
  const token = getMetaAdsToken();
  if (!token) return [];

  try {
    const data = await metaApiRequest("GET", "/me/adaccounts?fields=account_id,name,account_status,business_name&limit=20");
    console.log("[Meta] Ad accounts raw response:", JSON.stringify(data.data?.map(a => ({ id: a.id, account_id: a.account_id, name: a.name, business_name: a.business_name, status: a.account_status }))));
    return (data.data || []).map(a => ({
      id: a.id || (String(a.account_id).startsWith("act_") ? a.account_id : `act_${a.account_id}`),
      accountId: a.account_id,
      name: a.name || a.business_name || "Unknown",
      status: a.account_status === 1 ? "active" : a.account_status === 2 ? "disabled" : "unknown",
    }));
  } catch (e) {
    console.error("Failed to fetch Meta ad accounts:", e.message);
    return [];
  }
}

// Get the primary ad account ID (from metadata or API)
async function fetchMetaAdAccountId() {
  const cached = getMetaAdAccountId();
  if (cached) return cached;

  const accounts = await fetchMetaAdAccounts();
  const active = accounts.find(a => a.status === "active") || accounts[0];
  return active?.id || null;
}

function isMetaAdsConnected() {
  return !!getMetaAdsToken();
}

function metaApiRequest(method, endpoint, body = null, userStore = null) {
  return new Promise((resolve, reject) => {
    const token = getMetaAdsToken(userStore);
    if (!token) return reject(new Error("Meta Ads not connected"));

    // Append access token to endpoint
    const separator = endpoint.includes("?") ? "&" : "?";
    const url = `https://graph.facebook.com/v21.0${endpoint}${separator}access_token=${token}`;
    const parsedUrl = new URL(url);
    const headers = { "Accept": "application/json" };

    let postData = null;
    if (body) {
      postData = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(postData);
    }

    const req = https.request({
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: method,
      headers: headers,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode >= 400) {
          reject(new Error(`Meta API ${res.statusCode}: ${text.substring(0, 300)}`));
        } else {
          resolve(text ? JSON.parse(text) : {});
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Meta API timeout")); });
    if (postData) req.write(postData);
    req.end();
  });
}

module.exports = {
  getMetaAdsToken, getMetaAdAccountId, fetchMetaAdAccounts, fetchMetaAdAccountId,
  isMetaAdsConnected, metaApiRequest,
};
