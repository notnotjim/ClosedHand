// lib/platforms/line.js — LINE webhook handler

const crypto = require("crypto");
const ctx = require("../context");
const { queueUserMessage } = ctx;
const { getUserByPlatform } = require("../../user-store");
const { UserStore } = require("../../user-store");
const { saveStore, swapToCloudStore, cleanupUserContext } = require("../storage");
const { clearAllThreads } = require("../conversation");
const { queuedAsk } = require("../engine");
const { handleOnboardingMessage, generatePlatformWelcome } = require("../onboarding");
const { transcribeAudio } = require("../voice");
const { isGoogleConnected } = require("../services/google");
const { isShopifyConnected } = require("../services/shopify");
const { isMetaAdsConnected } = require("../services/meta");

// Env at boot, or the keys pasted in the dashboard (runtime config), read at
// call time so LINE switches on the moment they are saved, no restart.
const _conf = (k) => process.env[k] || require("../config").getConfCached(k);
const { peek } = require("../log-text");
const LINE_CHANNEL_SECRET = () => _conf("LINE_CHANNEL_SECRET");
const LINE_CHANNEL_ACCESS_TOKEN = () => _conf("LINE_CHANNEL_ACCESS_TOKEN");
const LINE_LIFF_ID = () => _conf("LINE_LIFF_ID");
const WEBAPP_BASE = process.env.WEBAPP_URL || process.env.BASE_URL || "http://localhost:3000";

const WELCOME_MESSAGE = "Closedhand here. Send a message to get started.";

function setup() {
  if (!LINE_CHANNEL_SECRET() || !LINE_CHANNEL_ACCESS_TOKEN()) {
    console.log("[LINE] No keys yet. The webhook is registered and answers once the keys are saved in the dashboard.");
  }

  ctx.expressApp.post("/webhook/line", async (req, res) => {
    const secret = require("../webhook-secret").usableSecret("LINE_CHANNEL_SECRET", LINE_CHANNEL_SECRET());
    if (!secret || !LINE_CHANNEL_ACCESS_TOKEN()) return res.status(503).send("LINE is not set up");
    // Validate signature
    const signature = req.headers["x-line-signature"];
    if (!signature || !req.rawBody) {
      return res.status(400).send("Missing signature");
    }
    const hash = crypto.createHmac("SHA256", secret)
      .update(req.rawBody)
      .digest("base64");
    if (!crypto.timingSafeEqual(crypto.createHash("sha256").update(hash).digest(), crypto.createHash("sha256").update(String(signature)).digest())) {
      console.warn("[LINE] Webhook signature mismatch — rejecting request");
      return res.status(403).send("Invalid signature");
    }

    res.status(200).send("OK"); // Respond immediately

    const body = req.body;
    if (!body.events) return;

    for (const event of body.events) {
      try {
        await handleLineEvent(event);
      } catch (e) {
        console.error("[LINE] Event error:", e.message);
      }
    }
  });

  console.log("[LINE] Webhook registered at /webhook/line");
}

async function handleLineEvent(event) {
  if (event.type !== "message" && event.type !== "follow") return;
  // 1:1 only, as on Telegram and Discord. A group or room event still names
  // its sender, so without this a linked user in a group would have their
  // private context answered into the room.
  if (event.source?.type !== "user") return;

  const lineUserId = event.source?.userId;
  if (!lineUserId) return;

  // Follow event (user added the bot)
  if (event.type === "follow") {
    await sendWelcomeFlex(event.replyToken, lineUserId);
    return;
  }

  // Message event
  const replyToken = event.replyToken;
  const message = event.message;

  const access = require("../access");
  const verdict = await access.checkSenderAccess("line", lineUserId);
  if (!verdict.allowed) {
    access.sendRefusal("line", lineUserId, verdict, (text) => sendLinePush(lineUserId, text));
    return;
  }

  // Look up user
  const user = await getUserByPlatform("line", lineUserId);
  const userId = user.id;

  queueUserMessage(userId, async () => {
    console.log(`[LINE] Queue handler started for ${lineUserId} (${userId})`);
    let storeLoaded = false;
    try {
      const userStore = await UserStore.load(userId);
      swapToCloudStore(userStore, userId, lineUserId);
      ctx.activePlatform = "line";
      require("../workspace-cache").maybeRefreshOnSessionStart(userStore, userId);
      storeLoaded = true;

      let userText = "";

      if (message.type === "text") {
        userText = message.text;
      } else if (message.type === "audio") {
        // Download and transcribe
        try {
          const audioBuffer = await downloadLineContent(message.id);
          userText = await transcribeAudio(audioBuffer, "voice.m4a");
          console.log(`[LINE] Transcribed: ${peek(userText)}`);
        } catch (e) {
          console.error(`[LINE] Voice transcription error for ${lineUserId}:`, e.message);
          await sendLinePush(lineUserId, "Couldn't process that voice message. Try sending text instead.");
          return;
        }
      } else if (message.type === "location") {
        userText = `My location: ${message.title || ""} (${message.latitude}, ${message.longitude})`;
      } else if (message.type === "image") {
        userText = "[User sent an image]";
      } else {
        // Unsupported message type
        await sendLinePush(lineUserId, "I can handle text, voice messages, and location pins.");
        return;
      }

      if (!userText.trim()) return;

      const text = userText.trim();

      // Pending confirmations are intercepted inside queuedAsk (single chokepoint)

      if (text === "/start" || text.toLowerCase() === "start") {
        const services = [];
        if (isGoogleConnected()) services.push("Gmail, Calendar, Drive");
        if (isShopifyConnected()) services.push("Shopify");
        if (isMetaAdsConnected()) services.push("Meta Ads");
        let status = `Connected: ${services.length > 0 ? services.join(", ") : "None yet"}`;
        status += `\nManage settings from your dashboard`;
        await sendLinePush(lineUserId, status);
        return;
      }

      if (text === "/clear") {
        try {
          await clearAllThreads(userId);
        } catch (e) {}
        ctx.store.conversations[userId] = [];
        saveStore();
        await sendLinePush(lineUserId, "Conversation cleared.");
        return;
      }

      if (!ctx.store.facts["_onboarded"]) {
        const ps = ctx.activeUserStore?.profile?.settings || {};
        if (ps.onboarding_step === "done") {
          ctx.store.facts["_onboarded"] = new Date().toISOString();
        } else {
          console.log(`[LINE] Triggering onboarding for ${lineUserId}`);
          await handleOnboardingMessage(userId, lineUserId, text);
          return;
        }
      }

      console.log(`[LINE] Passing to LLM for ${lineUserId}`);
      // Show typing indicator while LLM thinks
      sendLineTyping(lineUserId);
      const response = await queuedAsk(userId, text, null, lineUserId);
      console.log(`[LINE] LLM response for ${lineUserId}: ${response ? `${response.length} chars` : "EMPTY/NULL"}`);
      if (response) {
        await sendLinePush(lineUserId, response);
      }
    } catch (err) {
      console.error(`[LINE] Handler error for ${lineUserId}:`, err);
      sendLinePush(lineUserId, "Something went wrong processing that. Try again?").catch(() => {});
    } finally {
      if (storeLoaded) cleanupUserContext();
    }
  }, message.type === "text" ? { text: message.text, platform: "line", chatId: lineUserId } : {});
}

// Send welcome Flex Message with LIFF setup button
async function sendWelcomeFlex(replyToken, lineUserId) {
  const liffUrl = LINE_LIFF_ID() ? `https://liff.line.me/${LINE_LIFF_ID()}` : WEBAPP_BASE;
  const flexMessage = {
    type: "flex",
    altText: "Closedhand here. Tap to set up.",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "image", url: `${WEBAPP_BASE}/logo.png`, size: "xxs", align: "center", aspectRatio: "1:1", aspectMode: "fit" },
          { type: "text", text: "Closedhand", weight: "bold", size: "xl", align: "center", margin: "sm" },
          { type: "text", text: `It helps with your email, calendar and plans from your own ${process.env.RAILWAY_ENVIRONMENT_ID ? "Railway account" : "computer"}.`, size: "sm", color: "#999999", align: "center", margin: "sm", wrap: true },
          { type: "separator", margin: "lg" },
          {
            type: "box", layout: "horizontal", margin: "lg", spacing: "sm",
            contents: [
              { type: "text", text: "🔗", size: "lg", flex: 0 },
              { type: "box", layout: "vertical", contents: [
                { type: "text", text: "Connects your tools", weight: "bold", size: "sm" },
                { type: "text", text: "Email, calendar, Shopify, Slack and more, all handled from here.", size: "xs", color: "#999999", wrap: true },
              ]},
            ],
          },
          {
            type: "box", layout: "horizontal", margin: "md", spacing: "sm",
            contents: [
              { type: "text", text: "⚡", size: "lg", flex: 0 },
              { type: "box", layout: "vertical", contents: [
                { type: "text", text: "Stays ahead of you", weight: "bold", size: "sm" },
                { type: "text", text: "Briefings, flight changes and deadline nudges arrive before you think to check.", size: "xs", color: "#999999", wrap: true },
              ]},
            ],
          },
          {
            type: "box", layout: "horizontal", margin: "md", spacing: "sm",
            contents: [
              { type: "text", text: "🧠", size: "lg", flex: 0 },
              { type: "box", layout: "vertical", contents: [
                { type: "text", text: "Knows what you mean", weight: "bold", size: "sm" },
                { type: "text", text: "It remembers your preferences and past conversations, so you don't repeat yourself.", size: "xs", color: "#999999", wrap: true },
              ]},
            ],
          },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "button",
            action: { type: "uri", label: "Set up Closedhand", uri: liffUrl },
            style: "primary",
            color: "#06C755",
            height: "md",
          },
          { type: "text", text: `It runs ${process.env.RAILWAY_ENVIRONMENT_ID ? "in your own Railway account" : "on your own computer"} and you can see and delete everything it keeps.`, size: "xxs", color: "#999999", align: "center", margin: "md" },
        ],
      },
    },
  };

  try {
    const resp = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${LINE_CHANNEL_ACCESS_TOKEN()}`,
      },
      body: JSON.stringify({ replyToken, messages: [flexMessage] }),
    });
    if (resp.ok) return;
  } catch (e) {
    console.error("[LINE] Flex reply error:", e.message);
  }

  // Fallback: push as plain text with link
  await sendLinePush(lineUserId, `Closedhand here. Set up at ${liffUrl}`);
}

// Try reply first, fall back to push if reply token expired
async function sendLineMessage(replyToken, lineUserId, text) {
  const replied = await sendLineReply(replyToken, text);
  if (!replied) {
    console.log("[LINE] Reply token failed/expired, falling back to push");
    await sendLinePush(lineUserId, text);
  }
}

// Show typing/loading indicator (lasts up to 60 seconds or until next message)
function sendLineTyping(lineUserId) {
  fetch("https://api.line.me/v2/bot/chat/loading/start", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LINE_CHANNEL_ACCESS_TOKEN()}`,
    },
    body: JSON.stringify({ chatId: lineUserId, loadingSeconds: 60 }),
  }).catch(() => {});
}

// Send via reply token (only works within a few seconds of receiving)
async function sendLineReply(replyToken, text) {
  if (!replyToken) return false;
  try {
    const resp = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${LINE_CHANNEL_ACCESS_TOKEN()}`,
      },
      body: JSON.stringify({
        replyToken,
        messages: [{ type: "text", text: truncate(text) }],
      }),
    });
    return resp.ok;
  } catch (e) {
    console.error("[LINE] Reply error:", e.message);
    return false;
  }
}

// Send via push (works anytime, for proactive messages)
async function sendLinePush(lineUserId, text) {
  if (require("../follow-on").parts(text).length > 1) {
    return require("../follow-on").sendParts(text, (part) => sendLinePush(lineUserId, part));
  }
  // LINE has a 5000 character limit per message
  const chunks = text.length > 4900 ? text.match(/.{1,4900}/gs) : [text];
  for (const chunk of chunks) {
    try {
      const resp = await fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${LINE_CHANNEL_ACCESS_TOKEN()}`,
        },
        body: JSON.stringify({
          to: lineUserId,
          messages: [{ type: "text", text: truncate(chunk) }],
        }),
      });
      if (!resp.ok) {
        const err = await resp.text();
        console.error(`[LINE] Push failed (${resp.status}):`, err);
      }
    } catch (e) {
      console.error("[LINE] Push error:", e.message);
    }
  }
}

// Download content (images, audio, video)
async function downloadLineContent(messageId) {
  const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
  const resp = await fetch(url, {
    headers: { "Authorization": `Bearer ${LINE_CHANNEL_ACCESS_TOKEN()}` },
  });
  if (!resp.ok) throw new Error("Failed to download LINE content");
  return Buffer.from(await resp.arrayBuffer());
}

function truncate(text, max = 5000) {
  // LINE has a 5000 character limit per message
  if (text.length <= max) return text;
  return text.substring(0, max - 20) + "\n\n(truncated)";
}

module.exports = { setup, sendLinePush, sendLineReply };
