// webapp/bot-call.js: asking the bot for what only it can do (the speech to
// text, for one), signed the way the web chat's own connection is, so the bot
// knows the request came from this dashboard and for whom.
const crypto = require("crypto");

// A host may hand over the address alone ("10.0.0.5:3000", as Nodion does).
const botAddress = process.env.BOT_INTERNAL_URL || "http://bot:3000";
const BOT_INTERNAL_URL = (botAddress.includes("://") ? botAddress : `http://${botAddress}`).replace(/\/$/, "");

// Good for a minute: long enough for the request to arrive, too short to reuse.
function botToken(userId) {
  const exp = Date.now() + 60000;
  const payload = `${userId}.${exp}`;
  const sig = crypto.createHmac("sha256", process.env.WS_AUTH_SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

module.exports = { BOT_INTERNAL_URL, botToken };
