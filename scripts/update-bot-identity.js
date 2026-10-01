#!/usr/bin/env node
// scripts/update-bot-identity.js
//
// Pushes ClosedHand's brand identity (display name, short description, long
// description, commands, avatar where possible) to each chat platform's
// official API. Run this whenever the brand copy or avatar changes — or after
// first-time bot setup.
//
//   node scripts/update-bot-identity.js
//
// Env vars (each platform is skipped silently if its token isn't set):
//   TELEGRAM_BOT_TOKEN         — required for Telegram updates
//   DISCORD_BOT_TOKEN          — required for Discord updates
//   WHATSAPP_API_TOKEN         — required for WhatsApp
//   WHATSAPP_PHONE_NUMBER_ID   — required for WhatsApp (the phone-number-id, not WABA id)
//   AVATAR_URL                 — optional, defaults to <WEBAPP_URL>/fist.svg
//
// What's automatable vs manual:
//   Telegram  — name, short desc, long desc, commands: API. Avatar: manual via @BotFather /setuserpic.
//   Discord   — description + avatar: API (Discord bot user endpoints).
//   WhatsApp  — about, description, vertical: API. Avatar needs a resumable upload handle (manual).
//   Slack     — manual (api.slack.com/apps → Basic Information).
//   LINE      — manual (LINE Developers Console → channel settings).
//
// The script prints a per-platform summary so you can verify what landed.

const IDENTITY = {
  displayName: "ClosedHand",
  short: "Your personal AI across every chat app",
  // Kept under 512 chars to satisfy Telegram's long-description cap.
  long: "ClosedHand plugs into your Google or Microsoft account and reaches your real tools — email, calendar, files, Shopify, Meta Ads, and more. Chat with it here or on any of your other chat apps; your conversation history carries across all of them. Your data is yours — never sold, never used to train AI.",
  commands: [
    { command: "start", description: "See what's connected and reintroduce yourself" },
    { command: "new", description: "Archive the current thread and start fresh" },
  ],
};

const AVATAR_URL = process.env.AVATAR_URL || `${process.env.WEBAPP_URL || process.env.BASE_URL || "http://localhost:3000"}/fist.svg`;

function log(platform, msg) { console.log(`[${platform}] ${msg}`); }
function warn(platform, msg) { console.warn(`[${platform}] ${msg}`); }

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

async function patchJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

async function updateTelegram() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return log("telegram", "skipped — TELEGRAM_BOT_TOKEN not set");
  const base = `https://api.telegram.org/bot${token}`;

  const calls = [
    ["setMyName",             { name: IDENTITY.displayName }],
    ["setMyShortDescription", { short_description: IDENTITY.short }],
    ["setMyDescription",      { description: IDENTITY.long }],
    ["setMyCommands",         { commands: IDENTITY.commands }],
  ];

  for (const [method, body] of calls) {
    const r = await postJson(`${base}/${method}`, body);
    if (r.ok && r.data.ok) log("telegram", `${method} ok`);
    else warn("telegram", `${method} FAILED: ${JSON.stringify(r.data).slice(0, 200)}`);
  }
  log("telegram", "avatar must be set manually via @BotFather /setuserpic");
}

async function updateDiscord() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return log("discord", "skipped — DISCORD_BOT_TOKEN not set");
  const headers = { Authorization: `Bot ${token}` };

  // Update the Application description
  const appR = await patchJson(`https://discord.com/api/v10/applications/@me`, {
    description: IDENTITY.long,
  }, headers);
  if (appR.ok) log("discord", "application description ok");
  else warn("discord", `application PATCH FAILED (${appR.status}): ${JSON.stringify(appR.data).slice(0, 200)}`);

  // Update the bot user (username + avatar). Avatar must be a data URL.
  try {
    const imgRes = await fetch(AVATAR_URL);
    if (!imgRes.ok) throw new Error(`avatar fetch ${imgRes.status}`);
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const contentType = imgRes.headers.get("content-type") || "image/svg+xml";
    // Discord accepts data URIs for avatars. SVG is allowed for application icons but NOT for bot-user avatars — user must supply PNG.
    const avatarData = contentType.startsWith("image/svg") ? null : `data:${contentType};base64,${buf.toString("base64")}`;
    const body = { username: IDENTITY.displayName };
    if (avatarData) body.avatar = avatarData;
    const userR = await patchJson(`https://discord.com/api/v10/users/@me`, body, headers);
    if (userR.ok) log("discord", `bot user updated${avatarData ? " with avatar" : " (name only — SVG not accepted for bot-user avatar; upload PNG manually)"}`);
    else warn("discord", `user PATCH FAILED (${userR.status}): ${JSON.stringify(userR.data).slice(0, 200)}`);
  } catch (e) {
    warn("discord", `avatar step failed: ${e.message}`);
  }
}

async function updateWhatsApp() {
  const token = process.env.WHATSAPP_API_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) return log("whatsapp", "skipped — WHATSAPP_API_TOKEN / WHATSAPP_PHONE_NUMBER_ID not set");

  const headers = { Authorization: `Bearer ${token}` };
  const r = await postJson(
    `https://graph.facebook.com/v21.0/${phoneId}/whatsapp_business_profile`,
    {
      messaging_product: "whatsapp",
      about: IDENTITY.short.slice(0, 139),          // 139-char cap
      description: IDENTITY.long.slice(0, 512),     // 512-char cap
      vertical: "PROF_SERVICES",
    },
    headers,
  );
  if (r.ok) log("whatsapp", "business profile ok");
  else warn("whatsapp", `profile update FAILED (${r.status}): ${JSON.stringify(r.data).slice(0, 200)}`);
  log("whatsapp", "avatar requires Meta Business Manager upload (no stable profile-pic API yet)");
}

async function main() {
  console.log(`Updating chat-app identity with avatar: ${AVATAR_URL}`);
  console.log(`Display name: "${IDENTITY.displayName}"`);
  console.log();
  await updateTelegram();
  await updateDiscord();
  await updateWhatsApp();
  console.log();
  log("slack", "manual — update icon + description at api.slack.com/apps");
  log("line",  "manual — update icon + name + description at developers.line.biz");
  console.log();
  console.log("done.");
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
