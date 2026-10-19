// lib/key-catch.js: a key pasted into a chat goes no further.
//
// Every message passes engine.queuedAsk, and the web chat's is checked again
// before it is stored (lib/web-chat-ws.js). A key there, one that says whose
// it is or one the person said was a key (lib/api-keys.js), is replaced by a
// placeholder, so the model never sees it and no history, Context Note or
// resume record keeps it. The answer is this file's fixed note, not the
// model's: the model never learns a key was there, so it can't bring it up
// again later. Long strings nobody called a key go through untouched.

const keys = require("./api-keys");

// "Here's my key" now, and the key in the next message.
const SAID_MS = 5 * 60 * 1000;
const _said = new Map(); // userId -> when they said a key was coming
const _advised = new Map(); // userId -> digests of keys already given the "make a new one" advice

const APP_NAMES = { whatsapp: "WhatsApp", "whatsapp-linked": "WhatsApp", telegram: "Telegram", discord: "Discord", slack: "Slack", line: "LINE" };

// Words that only point at the key, so a message of nothing else has no
// "rest" to answer.
const POINTING = /\b(here'?s|here|is|my|our|the|this|that|it|its|api|key|keys|token|secret|for|use|connect|add|please|thanks|thank|you|and|a|an|to|with|of|your|new)\b/gi;

// Synchronous, so queuedAsk keeps its order. Returns null, or { text, found }
// with the keys replaced.
function check(userId, text) {
  const src = String(text || "");
  const saidBefore = (_said.get(userId) || 0) > Date.now() - SAID_MS;
  const { text: kept, keys: found } = keys.withhold(src, { saidBefore });
  if (!found.length) {
    if (keys.saysKey(src)) _said.set(userId, Date.now());
    return null;
  }
  _said.delete(userId);
  return { text: kept, found };
}

// The note that answers it. The "make a new key" advice is for chat apps,
// where the key still sits in the app's copy of the chat, and is given once
// for each key.
async function reply(userId, caught, platform, deps = {}) {
  const found = caught.found;
  const services = [...new Set(found.map((k) => k.service).filter(Boolean))];
  const one = services.length === 1 ? services[0] : null;
  const what = one ? `your ${one} key` : found.length > 1 ? "keys" : "a key";
  const lines = [`That looks like ${what}, so I've left it out of what I read and keep.`];

  const app = APP_NAMES[platform];
  if (app) {
    const advised = _advised.get(userId) || new Set();
    const fresh = found.filter((k) => k.digest && !advised.has(k.digest));
    if (fresh.length) {
      lines.push(`It's still in this chat's history in ${app}, so the safest thing is to make a new key${one ? ` with ${one}` : ""} and paste that one instead.`);
      for (const k of fresh) advised.add(k.digest);
      _advised.set(userId, advised);
    }
  }

  const rest = caught.text.replace(/\[[^\]\n]*key withheld\]/g, " ").replace(POINTING, " ")
    .replace(new RegExp(services.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") || "$^", "gi"), " ")
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (rest.length >= 4) lines.push("I haven't read the rest of your message, so send it again without the key.");

  if (found.some((k) => k.signed)) {
    lines.push(`${one || "That service"} needs more than a key on each request, so it can't be connected with a key alone.`);
    return lines.join(" ");
  }
  const link = await (deps.dashboardUrl || require("./dashboard-links").dashboardUrl)(platform, "connect").catch(() => null);
  const doing = found.every((k) => k.provider) ? "To use it for Closedhand's AI" : one ? `To connect ${one}` : "To connect the service it's for";
  lines.push(!link ? `${doing}, paste it under Connections on your dashboard, on the computer running Closedhand.`
    : platform === "web" ? `${doing}, paste it under [Connections on your dashboard](${link}).`
    : `${doing}, paste it under Connections on your dashboard: ${link}`);
  return lines.join(" ");
}

module.exports = { check, reply };
