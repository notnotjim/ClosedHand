// lib/access.js — Inbound sender access control (single-tenant hardening).
//
// Every inbound message resolves to the one admin, so a platform bot token
// effectively grants admin access to anyone who can message the bot. The default
// is first-sender-claims: an unclaimed platform binds to the first sender who
// messages it (recorded as the chat_links delivery target by getUserByPlatform),
// and every other sender is politely refused. ALLOWED_<PLATFORM>_IDS
// (comma-separated sender ids) extends the bound sender, and on a still-unclaimed
// platform it restricts who may claim.
//
// e.g. ALLOWED_TELEGRAM_IDS=12345,67890  /  ALLOWED_WHATSAPP_IDS=447700900123
//
// Claim races (two strangers hitting an unclaimed platform simultaneously) are
// tolerated: both pass once, the upsert settles on one, the loser is refused from
// the next message. Acceptable for a fresh single-tenant install.

const REFUSAL_MESSAGE =
  "Sorry, this ClosedHand instance is private and already linked to its owner, so I can't chat here.";

function envList(platform) {
  const raw = process.env[`ALLOWED_${String(platform).toUpperCase()}_IDS`];
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

// Returns { allowed, refuse }. refuse=true means a polite refusal is appropriate
// (the sender is a stranger); refuse=false on a DB error means drop silently so a
// transient outage never tells the real owner the instance belongs to someone else.
async function checkSenderAccess(platform, senderId) {
  const sender = String(senderId);
  const list = envList(platform);
  if (list.includes(sender)) return { allowed: true };

  const { supabase } = require("./db");
  const { data, error } = await supabase
    .from("chat_links")
    .select("platform_user_id")
    .eq("platform", platform)
    .limit(1);
  if (error) {
    console.error(`[access] chat_links lookup failed on ${platform}, dropping message from ${sender}:`, error.message || error.code || error);
    return { allowed: false, refuse: false };
  }

  const bound = data && data[0] && data[0].platform_user_id;
  if (!bound) {
    // Unclaimed. Open only when no allowlist restricts who may claim; the
    // sender's getUserByPlatform upsert records them as the claim.
    if (list.length === 0) return { allowed: true };
    console.log(`[access] refusing ${sender} on unclaimed ${platform} (not on ALLOWED_${String(platform).toUpperCase()}_IDS)`);
    return { allowed: false, refuse: true };
  }
  if (bound === sender) return { allowed: true };
  console.log(`[access] refusing ${sender} on ${platform} (bound to another sender)`);
  return { allowed: false, refuse: true };
}

// One polite refusal per sender per boot, fire-and-forget. `send` is a thunk
// receiving the message text and using the platform's own send primitive.
const _refused = new Set();
function sendRefusal(platform, senderId, verdict, send) {
  if (!verdict || !verdict.refuse) return;
  const key = `${platform}:${senderId}`;
  if (_refused.has(key)) return;
  _refused.add(key);
  Promise.resolve().then(() => send(REFUSAL_MESSAGE)).catch(() => {});
}

module.exports = { checkSenderAccess, sendRefusal, REFUSAL_MESSAGE };
