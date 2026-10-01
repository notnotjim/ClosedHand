// lib/services/shopify.js — Shopify token management + API request helper

const https = require("https");
const ctx = require("../context");

// All helpers accept an optional userStore (explicit threading for background/
// concurrent paths); fall back to the ctx singleton for legacy chat paths.
function isShopifyConnected(userStore) {
  const store = userStore || ctx.activeUserStore;
  if (!store) return false;
  const conn = store.getConnection("shopify");
  if (!conn?.tokens?.access_token) return false;
  return !!getShopifyStoreDomain(store);
}

function getShopifyToken(userStore) {
  const store = userStore || ctx.activeUserStore;
  if (!store) return null;
  const conn = store.getConnection("shopify");
  return conn?.tokens?.access_token || null;
}

function getShopifyStoreDomain(userStore) {
  const store = userStore || ctx.activeUserStore;
  if (!store) return null;
  return store.connections.shopify?.config?.shopDomain
    || store.connections.shopify?.metadata?.shopDomain
    || null;
}

async function shopifyApiRequest(method, endpoint, body = null, userStore = null) {
  const store = userStore || ctx.activeUserStore;
  const token = await freshShopifyToken(store);
  return new Promise((resolve, reject) => {
    if (!token) return reject(new Error("Shopify not connected — connect it from your dashboard"));
    const storeDomain = require("../shopify-auth").storeDomain(getShopifyStoreDomain(store));
    if (!storeDomain) return reject(new Error("Shopify store domain not found — reconnect Shopify from your dashboard"));

    const url = `https://${storeDomain}/admin/api/2026-01${endpoint}`;
    const parsedUrl = new URL(url);
    const headers = {
      "X-Shopify-Access-Token": token,
      "Accept": "application/json",
    };

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
          reject(new Error(`Shopify API ${res.statusCode}: ${text.substring(0, 200)}`));
        } else {
          resolve(text ? JSON.parse(text) : {});
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Shopify API timeout")); });
    if (postData) req.write(postData);
    req.end();
  });
}

// Coalesce requests per loaded connection; never share credentials across users.
const refreshing = new WeakMap();
async function freshShopifyToken(store) {
  const conn = store?.getConnection("shopify");
  if (!conn?.tokens?.access_token) return null;
  const tokens = conn.tokens;
  if (!tokens.client_secret || tokens.expires_at > Date.now() + 60000) return tokens.access_token;
  if (!refreshing.has(conn)) {
    refreshing.set(conn, (async () => {
      const next = await require("../shopify-auth").exchangeCredentials(getShopifyStoreDomain(store), tokens.client_id, tokens.client_secret);
      const { error } = await require("../db").supabase.from("connections")
        .update({ tokens: require("../../crypto-tokens").encryptTokens(next), updated_at: new Date().toISOString() })
        .eq("user_id", store.userId).eq("service", "shopify");
      if (error) throw new Error("Could not save the renewed Shopify connection");
      conn.tokens = next;
      return next.access_token;
    })().finally(() => refreshing.delete(conn)));
  }
  return refreshing.get(conn);
}

module.exports = { freshShopifyToken, isShopifyConnected, getShopifyToken, getShopifyStoreDomain, shopifyApiRequest };
