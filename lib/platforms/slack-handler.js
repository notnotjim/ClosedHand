// lib/platforms/slack-handler.js — Slack webhook handler

const ctx = require("../context");
const { queueUserMessage } = ctx;
const { UserStore, getUserByPlatform } = require("../../user-store");
const { saveStore, swapToCloudStore, cleanupUserContext } = require("../storage");
const { getConversation, archiveThread, switchThread, getThreadList, clearAllThreads, formatRelativeTime } = require("../conversation");
const { queuedAsk } = require("../engine");
const { sendSlackMessage, reactToMessage, removeReaction } = require("../messaging");
const { StatusFeed, createEditInPlaceRenderer } = require("../status-feed");
const { handleOnboardingMessage, generatePlatformWelcome } = require("../onboarding");

const https = require("https");
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

// Helper: make a Slack API call and return parsed JSON
function slackApi(method, body) {
  const postData = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "slack.com",
      path: `/api/${method}`,
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
}

// Helper: create StatusFeed opts for Slack DM
function createSlackStatusOpts(slackUserId) {
  const feed = new StatusFeed(createEditInPlaceRenderer(slackUserId, "slack", {
    sendFn: async (cid, text) => {
      const openResult = await slackApi("conversations.open", { users: cid });
      if (!openResult.ok) return null;
      const channel = openResult.channel.id;
      const result = await slackApi("chat.postMessage", { channel, text });
      if (!result.ok) return null;
      return { platform: "slack", channel, ts: result.ts };
    },
    editFn: async (info, text) => {
      await slackApi("chat.update", { channel: info.channel, ts: info.ts, text });
    },
    deleteFn: async (info) => {
      await slackApi("chat.delete", { channel: info.channel, ts: info.ts });
    },
  }));
  return {
    opts: {
      onToolStart(toolNames) {},
      onStatusEvent(event) { feed.emit(event); },
    },
    cleanup() { feed.clear(); },
  };
}

function setup() {
  ctx.expressApp.post("/webhook/slack", async (req, res) => {
    // Handle Slack's URL verification challenge
    if (req.body?.type === "url_verification") {
      return res.json({ challenge: req.body.challenge });
    }

    res.sendStatus(200);

    try {
    // Only handle message.im events (DMs to the bot)
    const event = req.body?.event;
    if (!event || event.type !== "message" || event.subtype || event.bot_id) return;

    const slackUserId = event.user;
    const slackChannel = event.channel;
    const slackTs = event.ts;
    const text = event.text?.trim();
    if (!text) return;

    console.log(`Slack DM from ${slackUserId}: "${text.substring(0, 60)}"`);

    const access = require("../access");
    const verdict = await access.checkSenderAccess("slack", slackUserId);
    if (!verdict.allowed) {
      access.sendRefusal("slack", slackUserId, verdict, (text) => slackApi("chat.postMessage", { channel: slackChannel, text }));
      return;
    }

    const user = await getUserByPlatform("slack", slackUserId);
    const userId = user.id;

    queueUserMessage(userId, async () => {
      const userStore = await UserStore.load(userId);
      swapToCloudStore(userStore, userId, slackUserId);
      ctx.activePlatform = "slack";
      require("../workspace-cache").maybeRefreshOnSessionStart(userStore, userId);

      try {
        // Pending confirmations are intercepted inside queuedAsk (single chokepoint)

        // Number-reply thread switching from /threads list
        if (ctx.pendingThreadSelect?.[userId] && /^\d+$/.test(text.trim())) {
          const idx = parseInt(text.trim()) - 1;
          const threadIds = ctx.pendingThreadSelect[userId];
          if (idx >= 0 && idx < threadIds.length) {
            delete ctx.pendingThreadSelect[userId];
            const result = await switchThread(userId, threadIds[idx]);
            if (result) {
              await sendSlackMessage(slackUserId, `Switched to: ${result.title || "Untitled"} (${result.messageCount} messages)`);
            } else {
              await sendSlackMessage(slackUserId, "Couldn't find that thread.");
            }
            return;
          }
        }

        // /new - archive current thread, start fresh
        if (text === "/new") {
          try {
            await archiveThread(userId);
            saveStore();
            await sendSlackMessage(slackUserId, "Fresh start. Your previous conversation is saved. Use /threads to go back to it anytime.");
          } catch (e) {
            ctx.store.conversations[userId] = [];

            saveStore();
            await sendSlackMessage(slackUserId, "Started a new conversation.");
          }
          return;
        }

        // /threads - show recent threads
        if (text === "/threads") {
          try {
            const threads = await getThreadList(userId, 10);
            if (threads.length === 0) {
              await sendSlackMessage(slackUserId, "No previous conversations. This is your first thread.");
              return;
            }
            const lines = threads.slice(0, 10).map((t, i) =>
              `${i + 1}. ${t.is_active ? "[active] " : ""}${(t.title || "Untitled").substring(0, 30)} - ${t.message_count || 0} messages, ${formatRelativeTime(t.updated_at)}`
            );
            ctx.pendingThreadSelect = ctx.pendingThreadSelect || {};
            ctx.pendingThreadSelect[userId] = threads.slice(0, 10).map(t => t.id);
            await sendSlackMessage(slackUserId, "Your threads:\n" + lines.join("\n") + "\n\nReply with a number to switch, or /new for a fresh thread.");
          } catch (e) {
            await sendSlackMessage(slackUserId, "Couldn't load threads. Try again.");
          }
          return;
        }

        // /clear - clear all threads and conversations
        if (text === "/clear") {
          try {
            await clearAllThreads(userId);
          } catch (e) {}
          ctx.store.conversations[userId] = [];
          saveStore();
          await sendSlackMessage(slackUserId, "Conversation cleared.");
          return;
        }

        if (!ctx.store.facts["_onboarded"]) {
          await handleOnboardingMessage(userId, slackUserId, text);
          return;
        }

        // Reply context: if user is replying in a thread, fetch the parent message
        let replyContext = null;
        if (event.thread_ts && event.thread_ts !== event.ts) {
          try {
            const parentResp = await slackApi("conversations.replies", {
              channel: event.channel,
              ts: event.thread_ts,
              limit: 1,
              inclusive: true,
            });
            if (parentResp.ok && parentResp.messages?.[0]) {
              replyContext = parentResp.messages[0].text || null;
            }
          } catch (e) {}
        }

        // Prepend reply context if user is replying to a specific message
        let userText = text;
        if (replyContext) {
          userText = `[Replying to: "${replyContext.substring(0, 300)}"]\n\n${text}`;
        }

        const slackMsgRef = { channel: slackChannel, ts: slackTs };
        reactToMessage(slackUserId, slackMsgRef, "🤔");

        const { opts, cleanup } = createSlackStatusOpts(slackUserId);

        const response = await queuedAsk(userId, userText, null, slackUserId, opts);

        removeReaction(slackUserId, slackMsgRef, "🤔").catch(() => {});
        cleanup();

        if (response) {
          await sendSlackMessage(slackUserId, response);
        }
      } finally {
        cleanupUserContext();
      }
    });
    } catch (err) {
      console.error("Slack webhook handler error:", err);
    }
  });
}

module.exports = { setup };
