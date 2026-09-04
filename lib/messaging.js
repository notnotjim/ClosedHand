// lib/messaging.js — All send functions + sendTyping + sendText + sendToPlatform

const https = require("https");
const ctx = require("./context");

const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

function sendWhatsAppMessage(to, text) {
  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    return Promise.reject(new Error("WhatsApp not configured"));
  }

  // WhatsApp has a 4096 char limit per message
  const textChunks = text.length > 4000 ? text.match(/.{1,4000}/gs) : [text];

  function sendSingleMessage(body) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        messaging_product: "whatsapp",
        to: to,
        type: "text",
        text: { body },
      });

      const req = https.request(
        {
          hostname: "graph.facebook.com",
          path: `/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
          method: "POST",
          headers: {
            Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(postData),
          },
        },
        (res) => {
          const dataChunks = [];
          res.on("data", (c) => dataChunks.push(c));
          res.on("end", () => {
            const raw = Buffer.concat(dataChunks).toString();
            try {
              const data = JSON.parse(raw);
              if (data.error) {
                console.error(`WhatsApp send error (${res.statusCode}): ${data.error.message}`);
                reject(new Error(data.error.message));
              } else {
                resolve(data);
              }
            } catch (parseErr) {
              console.error(`WhatsApp API non-JSON response (${res.statusCode}): ${raw.substring(0, 200)}`);
              reject(new Error(`WhatsApp API returned non-JSON (HTTP ${res.statusCode})`));
            }
          });
        }
      );
      req.on("error", (err) => {
        console.error("WhatsApp request error:", err.message);
        reject(err);
      });
      req.write(postData);
      req.end();
    });
  }

  // Send chunks sequentially
  return textChunks.reduce((chain, chunk) => chain.then(() => sendSingleMessage(chunk)), Promise.resolve());
}

function sendWhatsAppInteractive(to, { header, body, footer, buttonText, buttonUrl }) {
  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    return Promise.reject(new Error("WhatsApp not configured"));
  }

  return new Promise((resolve, reject) => {
    const interactive = {
      type: "cta_url",
      body: { text: body },
      action: {
        name: "cta_url",
        parameters: {
          display_text: buttonText,
          url: buttonUrl,
        },
      },
    };
    if (header) interactive.header = { type: "text", text: header };
    if (footer) interactive.footer = { text: footer };

    const postData = JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive,
    });

    const req = https.request(
      {
        hostname: "graph.facebook.com",
        path: `/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (res) => {
        const dataChunks = [];
        res.on("data", (c) => dataChunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(dataChunks).toString();
          try {
            const data = JSON.parse(raw);
            if (data.error) {
              console.error(`WhatsApp interactive send error (${res.statusCode}): ${data.error.message}`);
              reject(new Error(data.error.message));
            } else {
              resolve(data);
            }
          } catch (parseErr) {
            console.error(`WhatsApp interactive API non-JSON response (${res.statusCode}): ${raw.substring(0, 200)}`);
            reject(new Error(`WhatsApp API returned non-JSON (HTTP ${res.statusCode})`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

function markWhatsAppRead(messageId) {
  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) return;
  const postData = JSON.stringify({
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
  });
  const req = https.request({
    hostname: "graph.facebook.com",
    path: `/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(postData),
    },
  });
  req.on("error", () => {});
  req.write(postData);
  req.end();
}

function sendSlackMessage(slackUserId, text) {
  if (!SLACK_BOT_TOKEN) {
    return Promise.reject(new Error("Slack bot not configured"));
  }

  // Slack has a 4000 char limit per message in blocks; use 3900 to be safe
  const textChunks = text.length > 3900 ? text.match(/.{1,3900}/gs) : [text];

  function sendSingle(body) {
    return new Promise((resolve, reject) => {
      // First open a DM channel with the user
      const openData = JSON.stringify({ users: slackUserId });
      const openReq = https.request(
        {
          hostname: "slack.com",
          path: "/api/conversations.open",
          method: "POST",
          headers: {
            Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(openData),
          },
        },
        (openRes) => {
          const chunks = [];
          openRes.on("data", (c) => chunks.push(c));
          openRes.on("end", () => {
            const openResult = JSON.parse(Buffer.concat(chunks).toString());
            if (!openResult.ok) {
              return reject(new Error(`Slack conversations.open failed: ${openResult.error}`));
            }

            const channelId = openResult.channel.id;
            const postData = JSON.stringify({ channel: channelId, text: body });

            const postReq = https.request(
              {
                hostname: "slack.com",
                path: "/api/chat.postMessage",
                method: "POST",
                headers: {
                  Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
                  "Content-Type": "application/json",
                  "Content-Length": Buffer.byteLength(postData),
                },
              },
              (postRes) => {
                const postChunks = [];
                postRes.on("data", (c) => postChunks.push(c));
                postRes.on("end", () => {
                  const result = JSON.parse(Buffer.concat(postChunks).toString());
                  if (!result.ok) {
                    console.error("Slack send error:", result.error);
                    reject(new Error(result.error));
                  } else {
                    resolve(result);
                  }
                });
              }
            );
            postReq.on("error", (err) => {
              console.error("Slack post request error:", err.message);
              reject(err);
            });
            postReq.write(postData);
            postReq.end();
          });
        }
      );
      openReq.on("error", (err) => {
        console.error("Slack open request error:", err.message);
        reject(err);
      });
      openReq.write(openData);
      openReq.end();
    });
  }

  // Send chunks sequentially
  return textChunks.reduce((chain, chunk) => chain.then(() => sendSingle(chunk)), Promise.resolve());
}

async function sendDiscordMessage(discordUserId, text) {
  if (!ctx.discordClient) return Promise.reject(new Error("Discord not configured"));
  const user = await ctx.discordClient.users.fetch(discordUserId);
  const dm = await user.createDM();
  const chunks = text.length > 1900 ? text.match(/.{1,1900}/gs) : [text];
  for (const chunk of chunks) {
    await dm.send(chunk);
  }
}

// --- Cross-platform file sending ---

async function sendTelegramDocument(chatId, buffer, filename) {
  await ctx.bot.sendDocument(chatId, buffer, {}, { filename });
}

async function sendWhatsAppDocument(chatId, buffer, filename, mimeType) {
  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error("WhatsApp not configured");
  }

  // Step 1: Upload media
  const boundary = `----FormBoundary${Date.now()}`;
  const disposition = `form-data; name="file"; filename="${filename}"`;
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="messaging_product"\r\n\r\nwhatsapp\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\n${mimeType || "application/octet-stream"}\r\n`,
    `--${boundary}\r\nContent-Disposition: ${disposition}\r\nContent-Type: ${mimeType || "application/octet-stream"}\r\n\r\n`,
  ];
  const head = Buffer.from(parts.join(""));
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, buffer, tail]);

  const mediaResult = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "graph.facebook.com",
      path: `/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/media`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          if (data.error) reject(new Error(data.error.message));
          else resolve(data);
        } catch (e) { reject(new Error("WhatsApp media upload returned non-JSON")); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });

  if (!mediaResult.id) throw new Error("WhatsApp media upload returned no ID");

  // Step 2: Send document message
  const postData = JSON.stringify({
    messaging_product: "whatsapp",
    to: chatId,
    type: "document",
    document: { id: mediaResult.id, filename },
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "graph.facebook.com",
      path: `/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          if (data.error) reject(new Error(data.error.message));
          else resolve(data);
        } catch (e) { reject(new Error("WhatsApp send returned non-JSON")); }
      });
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

async function sendDiscordDocument(chatId, buffer, filename) {
  if (!ctx.discordClient) throw new Error("Discord not configured");
  const user = await ctx.discordClient.users.fetch(chatId);
  const dm = await user.createDM();
  await dm.send({ files: [{ attachment: buffer, name: filename }] });
}

async function sendSlackDocument(chatId, buffer, filename, mimeType) {
  if (!SLACK_BOT_TOKEN) throw new Error("Slack not configured");

  // First open a DM channel
  const openData = JSON.stringify({ users: chatId });
  const channelId = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "slack.com",
      path: "/api/conversations.open",
      method: "POST",
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(openData),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const data = JSON.parse(Buffer.concat(chunks).toString());
        if (!data.ok) reject(new Error(`Slack conversations.open: ${data.error}`));
        else resolve(data.channel.id);
      });
    });
    req.on("error", reject);
    req.write(openData);
    req.end();
  });

  // Upload file via files.uploadV2
  const boundary = `----FormBoundary${Date.now()}`;
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="channel_id"\r\n\r\n${channelId}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="filename"\r\n\r\n${filename}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType || "application/octet-stream"}\r\n\r\n`,
  ];
  const head = Buffer.from(parts.join(""));
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, buffer, tail]);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "slack.com",
      path: "/api/files.uploadV2",
      method: "POST",
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const data = JSON.parse(Buffer.concat(chunks).toString());
        if (!data.ok) reject(new Error(`Slack file upload: ${data.error}`));
        else resolve(data);
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Deliver a file into web chat over the WebSocket. Web had no case at all in
// sendDocument, so it fell through to the telegram default and tried to send a
// web user's UUID to the Telegram API. That failure is what the user saw as
// "Drive send hit a chat glitch" while asking for a file on the site the
// product actually lives on.
function sendWebDocument(chatId, buffer, filename, mimeType) {
  try {
    const { sendToUser } = require("./web-chat-ws");
    const MAX_WS_BYTES = 8 * 1024 * 1024;
    if (buffer.length > MAX_WS_BYTES) {
      const { sendWebMessage } = require("./platforms/web");
      return sendWebMessage(chatId, `${filename} is ${Math.round(buffer.length / 1048576)}MB, too large to send in chat. It is saved on your dashboard.`);
    }
    sendToUser(chatId, {
      type: "file",
      filename,
      mediaType: mimeType || "application/octet-stream",
      size: buffer.length,
      base64: buffer.toString("base64"),
    });
    return Promise.resolve();
  } catch (e) {
    const { sendWebMessage } = require("./platforms/web");
    return sendWebMessage(chatId, `Couldn't attach ${filename} here: ${e.message}`);
  }
}

// Keep a copy of a file sent to the user. Fire and forget, because a failure
// to file something away must never stop it being delivered.
// Where a file came from decides what the Files list may claim about it: a
// report ClosedHand wrote and a PDF it merely pulled out of the user's email
// are different things, and calling both "made for you" was a lie the
// dashboard told within a day of the list existing.
const FILE_ORIGIN_LABELS = {
  email: "Pulled from your email",
  drive: "From your Drive",
  workspace: "Made by ClosedHand",
};

function recordOutgoingFile(buffer, filename, mimeType, origin) {
  const userId = ctx.activeUserId;
  if (!userId || !buffer || !buffer.length) return;
  (async () => {
    try {
      const { uploadFile, UserStore } = require("../user-store");
      const id = `att_out_${Date.now()}_${Math.floor(buffer.length % 1000)}`;
      const storagePath = await uploadFile(userId, id, buffer, mimeType || "application/octet-stream");
      const store = await UserStore.load(userId);
      await store.saveAttachment({
        id,
        fileName: filename,
        description: FILE_ORIGIN_LABELS[origin] || "Sent to you in chat",
        mediaType: mimeType || "application/octet-stream",
        storagePath,
        sizeBytes: buffer.length,
        direction: "out",
      });
    } catch (e) {
      console.error(`[attachments] Could not record outgoing ${filename}: ${e.message}`);
    }
  })();
}

async function sendDocument(chatId, buffer, filename, mimeType, origin) {
  // Every file ClosedHand hands over goes through here, whichever tool made
  // it, so this is the one place that can record it. Without it a report it
  // built is findable only by scrolling back through the chat it was sent in.
  recordOutgoingFile(buffer, filename, mimeType, origin);
  switch (ctx.activePlatform) {
    case "web":
      return sendWebDocument(chatId, buffer, filename, mimeType);
    case "whatsapp":
      return sendWhatsAppDocument(chatId, buffer, filename, mimeType);
    case "whatsapp_linked": {
      const { sendLinkedDocument } = require("./platforms/whatsapp-linked");
      return sendLinkedDocument(chatId, buffer, filename, mimeType);
    }
    case "discord":
      return sendDiscordDocument(chatId, buffer, filename);
    case "slack":
      return sendSlackDocument(chatId, buffer, filename, mimeType);
    case "line": {
      // LINE doesn't support file sending via push API — send a text fallback
      const { sendLinePush } = require("./platforms/line");
      return sendLinePush(chatId, `[File: ${filename}] — LINE doesn't support file attachments in bot messages. Please check your dashboard to download.`);
    }
    default: // telegram
      return sendTelegramDocument(chatId, buffer, filename);
  }
}

function sendTyping(chatId) {
  if (ctx.activePlatform === "whatsapp") return Promise.resolve();
  if (ctx.activePlatform === "whatsapp_linked") return Promise.resolve();
  if (ctx.activePlatform === "slack") return Promise.resolve();
  if (ctx.activePlatform === "web") return Promise.resolve(); // Web typing handled via SSE
  if (ctx.activePlatform === "line") return Promise.resolve();
  if (ctx.activePlatform === "discord") {
    return ctx.discordClient.users.fetch(chatId)
      .then(u => u.createDM()).then(dm => dm.sendTyping()).catch(() => {});
  }
  return ctx.bot.sendChatAction(chatId, "typing").catch(() => {});
}

// --- Status feedback functions ---

const SLACK_EMOJI_MAP = { "🤔": "thinking_face" };

function reactToMessage(chatId, messageId, emoji) {
  try {
    if (ctx.activePlatform === "telegram") {
      ctx.bot.setMessageReaction(chatId, messageId, {
        reaction: [{ type: "emoji", emoji }],
      }).catch(() => {});
    } else if (ctx.activePlatform === "whatsapp") {
      const postData = JSON.stringify({
        messaging_product: "whatsapp",
        to: chatId,
        type: "reaction",
        reaction: { message_id: messageId, emoji },
      });
      const req = https.request({
        hostname: "graph.facebook.com",
        path: `/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
      });
      req.on("error", () => {});
      req.write(postData);
      req.end();
    } else if (ctx.activePlatform === "slack") {
      // messageId is { channel, ts } for Slack
      const name = SLACK_EMOJI_MAP[emoji] || "eyes";
      const postData = JSON.stringify({ channel: messageId.channel, timestamp: messageId.ts, name });
      const req = https.request({
        hostname: "slack.com",
        path: "/api/reactions.add",
        method: "POST",
        headers: {
          Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
      });
      req.on("error", () => {});
      req.write(postData);
      req.end();
    }
    // Discord: not used here — platform handler uses native msg.react()
  } catch (e) {}
}

function removeReaction(chatId, messageId, emoji) {
  try {
    if (ctx.activePlatform === "telegram") {
      return ctx.bot.setMessageReaction(chatId, messageId, { reaction: [] }).catch(() => {});
    } else if (ctx.activePlatform === "whatsapp") {
      const postData = JSON.stringify({
        messaging_product: "whatsapp",
        to: chatId,
        type: "reaction",
        reaction: { message_id: messageId, emoji: "" },
      });
      const req = https.request({
        hostname: "graph.facebook.com",
        path: `/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
      });
      req.on("error", () => {});
      req.write(postData);
      req.end();
    } else if (ctx.activePlatform === "slack") {
      const name = SLACK_EMOJI_MAP[emoji] || "eyes";
      const postData = JSON.stringify({ channel: messageId.channel, timestamp: messageId.ts, name });
      const req = https.request({
        hostname: "slack.com",
        path: "/api/reactions.remove",
        method: "POST",
        headers: {
          Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
      });
      req.on("error", () => {});
      req.write(postData);
      req.end();
    }
  } catch (e) {}
  return Promise.resolve();
}

async function sendStatusMessage(chatId, text) {
  try {
    if (ctx.activePlatform === "whatsapp") return null;
    if (ctx.activePlatform === "whatsapp_linked") return null;
    if (ctx.activePlatform === "line") return null;

    if (ctx.activePlatform === "web") {
      // Prefer direct WebSocket for instant status
      try {
        const { hasWebChatConnection, sendToUser } = require("./web-chat-ws");
        if (hasWebChatConnection(chatId)) {
          sendToUser(chatId, { type: "status", content: text });
          return { platform: "web", chatId };
        }
      } catch (e) {}
      const { sendWebMessage } = require("./platforms/web");
      await sendWebMessage(chatId, text);
      return { platform: "web", chatId };
    }

    if (ctx.activePlatform === "telegram") {
      const sent = await ctx.bot.sendMessage(chatId, text);
      return { platform: "telegram", chatId, messageId: sent.message_id };
    }

    if (ctx.activePlatform === "discord") {
      const user = await ctx.discordClient.users.fetch(chatId);
      const dm = await user.createDM();
      const sent = await dm.send(text);
      return { platform: "discord", chatId, messageId: sent.id, channelId: dm.id };
    }

    if (ctx.activePlatform === "slack") {
      // Open DM then post
      const openData = JSON.stringify({ users: chatId });
      const channel = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: "slack.com",
          path: "/api/conversations.open",
          method: "POST",
          headers: {
            Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(openData),
          },
        }, (res) => {
          const chunks = [];
          res.on("data", c => chunks.push(c));
          res.on("end", () => {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            if (!data.ok) reject(new Error(data.error));
            else resolve(data.channel.id);
          });
        });
        req.on("error", reject);
        req.write(openData);
        req.end();
      });

      const postData = JSON.stringify({ channel, text });
      const result = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: "slack.com",
          path: "/api/chat.postMessage",
          method: "POST",
          headers: {
            Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(postData),
          },
        }, (res) => {
          const chunks = [];
          res.on("data", c => chunks.push(c));
          res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
        });
        req.on("error", reject);
        req.write(postData);
        req.end();
      });

      if (result.ok) return { platform: "slack", channel, ts: result.ts };
    }
  } catch (e) {}
  return null;
}

function deleteStatusMessage(statusInfo) {
  if (!statusInfo) return Promise.resolve();
  try {
    if (statusInfo.platform === "telegram") {
      return ctx.bot.deleteMessage(statusInfo.chatId, statusInfo.messageId).catch(() => {});
    }

    if (statusInfo.platform === "discord") {
      return ctx.discordClient.channels.fetch(statusInfo.channelId)
        .then(ch => ch.messages.fetch(statusInfo.messageId))
        .then(m => m.delete())
        .catch(() => {});
    }

    if (statusInfo.platform === "slack") {
      const postData = JSON.stringify({ channel: statusInfo.channel, ts: statusInfo.ts });
      const req = https.request({
        hostname: "slack.com",
        path: "/api/chat.delete",
        method: "POST",
        headers: {
          Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
      });
      req.on("error", () => {});
      req.write(postData);
      req.end();
    }
  } catch (e) {}
  return Promise.resolve();
}

const TOOL_STATUS_MAP = [
  [/^search_cache/, "Searching your email"],
  [/^search_calendar/, "Checking your calendar"],
  [/^fetch_attachment/, "Downloading an attachment"],
  [/^gmail_send/, "Drafting an email"],
  [/^gmail_reply/, "Drafting a reply"],
  [/^gcal_create/, "Creating calendar event"],
  [/^gcal_delete/, "Removing calendar event"],
  [/^gcal_/, "Checking calendar"],
  [/^web_search/, "Searching the web"],
  [/^web_fetch/, "Reading a webpage"],
  [/^weather_lookup/, "Checking weather"],
  [/^air_quality/, "Checking air quality"],
  [/^maps_/, "Looking up location"],
  [/^send_location/, "Sending location"],
  [/^tfl_/, "Checking transport"],
  [/^drive_/, "Searching your Drive"],
  [/^shopify_/, "Checking Shopify"],
  [/^meta_ads_/, "Checking Meta Ads"],
  [/^slack_/, "Checking Slack"],
  [/^pin_fact/, "Pinning a fact"],
  [/^get_facts/, "Checking pinned facts"],
  [/^bridge_calendar/, "Checking Mac Calendar"],
  [/^bridge_files/, "Accessing local files"],
  [/^bridge_shell/, "Running a command"],
  [/^bridge_browser/, "Checking browser"],
  [/^bridge_screenshot/, "Taking a screenshot"],
  [/^bridge_ax_/, "Reading app UI"],
  [/^bridge_input_/, "Interacting with screen"],
  [/^bridge_session_/, "Using terminal"],
  [/^list_connections/, "Checking connections"],
  [/^connect_service/, "Connecting a service"],
  [/^sandbox_/, "Using cloud computer"],
  [/^flight_/, "Checking flights"],
  [/^api_request/, "Querying a service"],
  [/^pulse_/, "Running pulse check"],
];

const _statusCounts = {};
function toolStatusText(toolNames) {
  for (const name of toolNames) {
    for (const [pattern, text] of TOOL_STATUS_MAP) {
      if (pattern.test(name)) {
        _statusCounts[text] = (_statusCounts[text] || 0) + 1;
        // Don't repeat the same status text
        if (_statusCounts[text] > 1) return null;
        return text;
      }
    }
  }
  return null; // Don't show generic "Working on it" - it's not helpful
}
function resetToolStatus() { Object.keys(_statusCounts).forEach(k => delete _statusCounts[k]); }

// --- Cross-platform location pin sending ---

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

async function sendLocation(chatId, lat, lng, name, address) {
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;

  switch (ctx.activePlatform) {
    case "telegram": {
      await ctx.bot.sendLocation(chatId, lat, lng);
      break;
    }
    case "whatsapp": {
      if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
        throw new Error("WhatsApp not configured");
      }
      const postData = JSON.stringify({
        messaging_product: "whatsapp",
        to: chatId,
        type: "location",
        location: { latitude: lat, longitude: lng, name: name || "", address: address || "" },
      });
      await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: "graph.facebook.com",
          path: `/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
          method: "POST",
          headers: {
            Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(postData),
          },
        }, (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            try {
              const data = JSON.parse(Buffer.concat(chunks).toString());
              if (data.error) reject(new Error(data.error.message));
              else resolve(data);
            } catch (e) { reject(new Error("WhatsApp location send returned non-JSON")); }
          });
        });
        req.on("error", reject);
        req.write(postData);
        req.end();
      });
      break;
    }
    case "discord": {
      if (!ctx.discordClient) throw new Error("Discord not configured");
      const user = await ctx.discordClient.users.fetch(chatId);
      const dm = await user.createDM();
      const embed = {
        title: name || "Location",
        description: address || "",
        url: mapsUrl,
        color: 0x4285f4,
      };
      if (GOOGLE_MAPS_API_KEY) {
        embed.image = { url: `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=15&size=600x300&markers=color:red|${lat},${lng}&key=${GOOGLE_MAPS_API_KEY}` };
      }
      await dm.send({ embeds: [embed] });
      break;
    }
    case "slack": {
      if (!SLACK_BOT_TOKEN) throw new Error("Slack not configured");
      const openData = JSON.stringify({ users: chatId });
      const channelId = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: "slack.com",
          path: "/api/conversations.open",
          method: "POST",
          headers: {
            Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(openData),
          },
        }, (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            if (!data.ok) reject(new Error(`Slack conversations.open: ${data.error}`));
            else resolve(data.channel.id);
          });
        });
        req.on("error", reject);
        req.write(openData);
        req.end();
      });

      const blocks = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${name || "Location"}*\n${address || ""}\n<${mapsUrl}|Open in Google Maps>`,
          },
        },
      ];
      if (GOOGLE_MAPS_API_KEY) {
        blocks.push({
          type: "image",
          image_url: `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=15&size=600x300&markers=color:red|${lat},${lng}&key=${GOOGLE_MAPS_API_KEY}`,
          alt_text: name || "Map",
        });
      }
      const postData = JSON.stringify({
        channel: channelId,
        blocks,
        text: `${name || "Location"} - ${mapsUrl}`,
      });
      await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: "slack.com",
          path: "/api/chat.postMessage",
          method: "POST",
          headers: {
            Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(postData),
          },
        }, (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            if (!data.ok) reject(new Error(`Slack postMessage: ${data.error}`));
            else resolve(data);
          });
        });
        req.on("error", reject);
        req.write(postData);
        req.end();
      });
      break;
    }
    case "whatsapp_linked": {
      const { sendLinkedLocation } = require("./platforms/whatsapp-linked");
      await sendLinkedLocation(chatId, lat, lng, name, address);
      break;
    }
    case "line": {
      // LINE supports location messages via push API
      const { sendLinePush } = require("./platforms/line");
      const lineText = `${name || "Location"}\n${address || ""}\n${mapsUrl}`;
      await sendLinePush(chatId, lineText.trim());
      break;
    }
    default: {
      // Fallback: Telegram (already handled above), or unknown platform — send text link
      throw new Error(`Unsupported platform for location: ${ctx.activePlatform}`);
    }
  }
}

function sendText(chatId, text) {
  if (ctx.activePlatform === "whatsapp") return sendWhatsAppMessage(chatId, text);
  if (ctx.activePlatform === "whatsapp_linked") {
    const { sendLinkedMessage } = require("./platforms/whatsapp-linked");
    return sendLinkedMessage(chatId, text);
  }
  if (ctx.activePlatform === "slack") return sendSlackMessage(chatId, text);
  if (ctx.activePlatform === "discord") return sendDiscordMessage(chatId, text);
  if (ctx.activePlatform === "line") {
    const { sendLinePush } = require("./platforms/line");
    return sendLinePush(chatId, text);
  }
  if (ctx.activePlatform === "web") {
    // Prefer direct WebSocket if connected, fall back to Supabase
    try {
      const { hasWebChatConnection, sendWebChatMessage } = require("./web-chat-ws");
      if (hasWebChatConnection(chatId)) {
        sendWebChatMessage(chatId, text);
        return Promise.resolve();
      }
    } catch (e) {}
    const { sendWebMessage } = require("./platforms/web");
    return sendWebMessage(chatId, text);
  }
  return ctx.bot.sendMessage(chatId, text);
}

async function sendDocumentToPlatform(platform, chatId, buffer, filename, mimeType) {
  if (platform === "dashboard") return null; // Dashboard polls for results
  switch (platform) {
    case "telegram":
      return sendTelegramDocument(chatId, buffer, filename);
    case "whatsapp":
      return sendWhatsAppDocument(chatId, buffer, filename, mimeType);
    case "whatsapp_linked": {
      const { sendLinkedDocument } = require("./platforms/whatsapp-linked");
      return sendLinkedDocument(chatId, buffer, filename, mimeType);
    }
    case "discord":
      return sendDiscordDocument(chatId, buffer, filename);
    case "slack":
      return sendSlackDocument(chatId, buffer, filename, mimeType);
    case "line": {
      const { sendLinePush } = require("./platforms/line");
      return sendLinePush(chatId, `[File: ${filename}] - LINE doesn't support file attachments in bot messages. Please check your dashboard to download.`);
    }
    case "web":
      return sendWebDocument(chatId, buffer, filename, mimeType);
    default:
      console.warn(`sendDocumentToPlatform: unknown platform "${platform}"`);
  }
}

async function sendToPlatform(platform, chatId, message) {
  if (platform === "dashboard") return null; // Dashboard polls for results
  switch (platform) {
    case "telegram": {
      if (message.length > 4000) {
        const chunks = message.match(/.{1,4000}/gs);
        let lastResult;
        for (const chunk of chunks) lastResult = await ctx.bot.sendMessage(chatId, chunk);
        return lastResult?.message_id || null;
      }
      const tgResult = await ctx.bot.sendMessage(chatId, message);
      return tgResult?.message_id || null;
    }
    case "whatsapp": {
      const waResult = await sendWhatsAppMessage(chatId, message);
      return waResult?.messages?.[0]?.id || null;
    }
    case "whatsapp_linked": {
      const { sendLinkedMessage } = require("./platforms/whatsapp-linked");
      return await sendLinkedMessage(chatId, message);
    }
    case "slack": {
      const slResult = await sendSlackMessage(chatId, message);
      return slResult?.ts || null;
    }
    case "discord": {
      const dcResult = await sendDiscordMessage(chatId, message);
      return dcResult?.id || null;
    }
    case "line": {
      const { sendLinePush } = require("./platforms/line");
      await sendLinePush(chatId, message);
      return null;
    }
    case "web": {
      try {
        const { hasWebChatConnection, sendWebChatMessage } = require("./web-chat-ws");
        if (hasWebChatConnection(chatId)) {
          sendWebChatMessage(chatId, message);
          return null;
        }
      } catch (e) {}
      const { sendWebMessage } = require("./platforms/web");
      await sendWebMessage(chatId, message);
      return null;
    }
    default:
      console.warn(`Pulse: unknown platform "${platform}"`);
      return null;
  }
}

async function pinMessage(platform, chatId, messageId) {
  try {
    switch (platform) {
      case "telegram":
        await ctx.bot.pinChatMessage(chatId, messageId, { disable_notification: true });
        return { pinned: true };
      case "discord": {
        if (!ctx.discordClient) return { pinned: false };
        const user = await ctx.discordClient.users.fetch(chatId);
        const dm = await user.createDM();
        const msg = await dm.messages.fetch(messageId);
        await msg.pin();
        return { pinned: true };
      }
      default:
        return { pinned: false };
    }
  } catch (e) {
    console.error(`pinMessage (${platform}):`, e.message);
    return { pinned: false, error: e.message };
  }
}

async function unpinMessage(platform, chatId, messageId) {
  try {
    switch (platform) {
      case "telegram":
        await ctx.bot.unpinChatMessage(chatId, { message_id: messageId });
        return { unpinned: true };
      case "discord": {
        if (!ctx.discordClient) return { unpinned: false };
        const user = await ctx.discordClient.users.fetch(chatId);
        const dm = await user.createDM();
        const msg = await dm.messages.fetch(messageId);
        await msg.unpin();
        return { unpinned: true };
      }
      default:
        return { unpinned: false };
    }
  } catch (e) {
    console.error(`unpinMessage (${platform}):`, e.message);
    return { unpinned: false, error: e.message };
  }
}

// Send canvas as mini app / inline button where supported
async function sendCanvasToChat(platform, chatId, canvasUrl, filename, buffer, mimeType) {
  const isImage = mimeType && mimeType.startsWith("image/");

  switch (platform) {
    case "telegram": {
      // Send file first (image inline, others as document)
      if (isImage) {
        try {
          await ctx.bot.sendPhoto(chatId, buffer, {
            caption: filename,
            reply_markup: {
              inline_keyboard: [[{ text: "Open in ClosedHand", web_app: { url: canvasUrl } }]],
            },
          });
          return;
        } catch (e) {
          console.error("[Telegram] sendPhoto with webapp failed:", e.message);
        }
      }
      // Non-image or fallback: send document + webapp button
      try {
        await ctx.bot.sendMessage(chatId, `Generated: ${filename}`, {
          reply_markup: {
            inline_keyboard: [[{ text: "Open Canvas", web_app: { url: canvasUrl } }]],
          },
        });
      } catch (e) {
        console.error("[Telegram] sendMessage with webapp failed:", e.message);
        // Fallback to plain text
        await ctx.bot.sendMessage(chatId, `${filename}: ${canvasUrl}`);
      }
      // Also send the file
      if (buffer) await sendDocumentToPlatform("telegram", chatId, buffer, filename, mimeType);
      return;
    }

    case "line": {
      // LINE: use LIFF URI action to open canvas in-app
      const liffId = process.env.LINE_LIFF_ID;
      const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
      if (liffId && lineToken) {
        const liffUrl = `https://liff.line.me/${liffId}?view=canvas&url=${encodeURIComponent(canvasUrl)}`;
        try {
          await fetch("https://api.line.me/v2/bot/message/push", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${lineToken}` },
            body: JSON.stringify({
              to: chatId,
              messages: [{
                type: "template",
                altText: `Canvas: ${filename}`,
                template: {
                  type: "buttons",
                  title: "ClosedHand Canvas",
                  text: filename,
                  actions: [{ type: "uri", label: "Open Canvas", uri: liffUrl }],
                },
              }],
            }),
          });
          return;
        } catch (e) {
          console.error("[LINE] Canvas template failed:", e.message);
        }
      }
      // Fallback
      const { sendLinePush } = require("./platforms/line");
      await sendLinePush(chatId, `${filename}: ${canvasUrl}`);
      return;
    }

    default: {
      // WhatsApp, Discord, Slack: send file + URL in text
      if (buffer) await sendDocumentToPlatform(platform, chatId, buffer, filename, mimeType);
      // The bot will mention the canvas_url in its response text
      return;
    }
  }
}

// Voice message sending
async function sendWhatsAppVoice(chatId, audioBuffer) {
  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error("WhatsApp not configured");
  }
  // Step 1: Upload audio as media
  const boundary = `----FormBoundary${Date.now()}`;
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="messaging_product"\r\n\r\nwhatsapp\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\naudio/ogg\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.ogg"\r\nContent-Type: audio/ogg\r\n\r\n`,
  ];
  const head = Buffer.from(parts.join(""));
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, audioBuffer, tail]);
  const mediaResult = await new Promise((resolve, reject) => {
    const req = https.request({ hostname: "graph.facebook.com", path: `/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/media`, method: "POST",
      headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length },
    }, (res) => { const c = []; res.on("data", d => c.push(d)); res.on("end", () => { try { const d = JSON.parse(Buffer.concat(c).toString()); d.error ? reject(new Error(d.error.message)) : resolve(d); } catch(e) { reject(e); } }); });
    req.on("error", reject); req.write(body); req.end();
  });
  if (!mediaResult.id) throw new Error("WhatsApp voice upload returned no ID");
  // Step 2: Send audio message
  const postData = JSON.stringify({ messaging_product: "whatsapp", to: chatId, type: "audio", audio: { id: mediaResult.id } });
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: "graph.facebook.com", path: `/v21.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, method: "POST",
      headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) },
    }, (res) => { const c = []; res.on("data", d => c.push(d)); res.on("end", () => { try { const d = JSON.parse(Buffer.concat(c).toString()); d.error ? reject(new Error(d.error.message)) : resolve(d); } catch(e) { reject(e); } }); });
    req.on("error", reject); req.write(postData); req.end();
  });
}

async function sendVoice(chatId, audioBuffer, platform) {
  platform = platform || ctx.activePlatform;
  if (platform === "whatsapp") {
    return sendWhatsAppVoice(chatId, audioBuffer);
  } else if (platform === "whatsapp_linked") {
    const { sendLinkedVoice } = require("./platforms/whatsapp-linked");
    return sendLinkedVoice(chatId, audioBuffer);
  } else if (platform === "telegram") {
    if (ctx.telegramBot) {
      return ctx.telegramBot.sendVoice(chatId, audioBuffer, { caption: "" });
    }
  }
  // Other platforms: fall back to sending as document
  return sendDocument(chatId, audioBuffer, "voice.ogg", "audio/ogg");
}

module.exports = {
  sendWhatsAppMessage, sendWhatsAppInteractive, markWhatsAppRead,
  sendSlackMessage, sendDiscordMessage,
  sendTyping, sendText, sendToPlatform,
  sendDocument, sendDocumentToPlatform, sendLocation,
  sendVoice, sendWhatsAppVoice,
  reactToMessage, removeReaction, sendStatusMessage, deleteStatusMessage, toolStatusText, resetToolStatus,
  pinMessage, unpinMessage, sendCanvasToChat,
};
