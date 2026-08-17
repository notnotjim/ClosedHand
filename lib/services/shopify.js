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

function shopifyApiRequest(method, endpoint, body = null, userStore = null) {
  return new Promise((resolve, reject) => {
    const token = getShopifyToken(userStore);
    if (!token) return reject(new Error("Shopify not connected — connect it from your dashboard"));
    const storeDomain = getShopifyStoreDomain(userStore);
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

module.exports = { isShopifyConnected, getShopifyToken, getShopifyStoreDomain, shopifyApiRequest };
