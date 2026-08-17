// lib/services/slack-api.js — Slack token management + API request helper

const https = require("https");
const ctx = require("../context");

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

function isSlackConnected() {
  return !!SLACK_BOT_TOKEN;
}

// Optional userStore = explicit threading for background/concurrent paths;
// ctx fallback keeps legacy chat paths working.
function getSlackToken(userStore) {
  const store = userStore || ctx.activeUserStore;
  if (!store) return null;
  const conn = store.getConnection("slack");
  return conn ? conn.access_token : null;
}

function slackApiRequest(method, url, body = null, userStore = null) {
  return new Promise((resolve, reject) => {
    // Prefer user's OAuth token (full workspace access) over bot token (only joined channels)
    const token = getSlackToken(userStore) || SLACK_BOT_TOKEN;
    if (!token) return reject(new Error("Slack not configured"));

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
          reject(new Error(`Slack API ${res.statusCode}: ${text.substring(0, 200)}`));
        } else {
          resolve(text ? JSON.parse(text) : {});
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Slack API timeout")); });
    if (postData) req.write(postData);
    req.end();
  });
}

module.exports = { isSlackConnected, getSlackToken, slackApiRequest };
