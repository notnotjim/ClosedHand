// lib/platforms/discord.js — Discord DM handler

const ctx = require("../context");
const { queueUserMessage } = ctx;
const { UserStore, getUserByPlatform } = require("../../user-store");
const { saveStore, swapToCloudStore, cleanupUserContext } = require("../storage");
const { getConversation, archiveThread, switchThread, getThreadList, clearAllThreads, formatRelativeTime } = require("../conversation");
const { queuedAsk } = require("../engine");
const { sendDiscordMessage } = require("../messaging");
const { StatusFeed, createEditInPlaceRenderer } = require("../status-feed");
const { handleOnboardingMessage, generatePlatformWelcome } = require("../onboarding");

// Helper: create StatusFeed opts for Discord DM
function createDiscordStatusOpts(discordUserId) {
  const feed = new StatusFeed(createEditInPlaceRenderer(discordUserId, "discord", {
    sendFn: async (cid, text) => {
      const user = await ctx.discordClient.users.fetch(cid);
      const dm = await user.createDM();
      const sent = await dm.send(text);
      return { platform: "discord", chatId: cid, messageId: sent.id, channelId: dm.id };
    },
    editFn: async (info, text) => {
      const ch = await ctx.discordClient.channels.fetch(info.channelId);
      const msg = await ch.messages.fetch(info.messageId);
      await msg.edit(text);
    },
    deleteFn: async (info) => {
      const ch = await ctx.discordClient.channels.fetch(info.channelId);
      const msg = await ch.messages.fetch(info.messageId);
      await msg.delete();
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
  if (!ctx.discordClient) return;

  ctx.discordClient.on("messageCreate", async (msg) => {
    try {
    if (msg.author.bot) return;
    if (!msg.channel.isDMBased()) return;

    const discordUserId = msg.author.id;
    const text = msg.content?.trim();
    if (!text) return;

    console.log(`Discord DM from ${discordUserId}: "${text.substring(0, 60)}"`);

    const access = require("../access");
    const verdict = await access.checkSenderAccess("discord", discordUserId);
    if (!verdict.allowed) {
      access.sendRefusal("discord", discordUserId, verdict, (text) => msg.reply(text));
      return;
    }

    const user = await getUserByPlatform("discord", discordUserId);
    const userId = user.id;

    queueUserMessage(userId, async () => {
      const userStore = await UserStore.load(userId);
      swapToCloudStore(userStore, userId, discordUserId);
      ctx.activePlatform = "discord";
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
              await sendDiscordMessage(discordUserId, `Switched to: ${result.title || "Untitled"} (${result.messageCount} messages)`);
            } else {
              await sendDiscordMessage(discordUserId, "Couldn't find that thread.");
            }
            return;
          }
        }

        // /new - archive current thread, start fresh
        if (text === "/new") {
          try {
            await archiveThread(userId);
            saveStore();
            await sendDiscordMessage(discordUserId, "Fresh start. Your previous conversation is saved. Use /threads to go back to it anytime.");
          } catch (e) {
            ctx.store.conversations[userId] = [];

            saveStore();
            await sendDiscordMessage(discordUserId, "Started a new conversation.");
          }
          return;
        }

        // /threads - show recent threads
        if (text === "/threads") {
          try {
            const threads = await getThreadList(userId, 10);
            if (threads.length === 0) {
              await sendDiscordMessage(discordUserId, "No previous conversations. This is your first thread.");
              return;
            }
            const lines = threads.slice(0, 10).map((t, i) =>
              `${i + 1}. ${t.is_active ? "[active] " : ""}${(t.title || "Untitled").substring(0, 30)} - ${t.message_count || 0} messages, ${formatRelativeTime(t.updated_at)}`
            );
            ctx.pendingThreadSelect = ctx.pendingThreadSelect || {};
            ctx.pendingThreadSelect[userId] = threads.slice(0, 10).map(t => t.id);
            await sendDiscordMessage(discordUserId, "Your threads:\n" + lines.join("\n") + "\n\nReply with a number to switch, or /new for a fresh thread.");
          } catch (e) {
            await sendDiscordMessage(discordUserId, "Couldn't load threads. Try again.");
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
          await sendDiscordMessage(discordUserId, "Conversation cleared.");
          return;
        }

        if (!ctx.store.facts["_onboarded"]) {
          await handleOnboardingMessage(userId, discordUserId, text);
          return;
        }

        // Reply context: fetch the message being replied to
        let replyContext = null;
        let replyFileData = null;
        if (msg.reference?.messageId) {
          try {
            const replied = await msg.channel.messages.fetch(msg.reference.messageId);
            replyContext = replied.content || null;
            // If the replied message has image attachments, download the first one
            if (replied.attachments.size > 0) {
              const img = replied.attachments.find(a => a.contentType?.startsWith("image/"));
              if (img) {
                const resp = await fetch(img.url);
                const buffer = Buffer.from(await resp.arrayBuffer());
                replyFileData = {
                  base64: buffer.toString("base64"),
                  mediaType: img.contentType,
                  ext: img.name?.split(".").pop() || "png",
                  isImage: true,
                  fileName: img.name || "reply_image.png",
                };
              }
            }
          } catch (e) {}
        }

        // Prepend reply context if user is replying to a specific message
        let userText = text;
        if (replyContext) {
          userText = `[Replying to: "${replyContext.substring(0, 300)}"]\n\n${text}`;
        }

        msg.react("🤔").catch(() => {});

        const { opts, cleanup } = createDiscordStatusOpts(discordUserId);

        const response = await queuedAsk(userId, userText, replyFileData, discordUserId, opts);

        msg.reactions.removeAll().catch(() => {});
        cleanup();

        if (response) {
          await sendDiscordMessage(discordUserId, response);
        }
      } finally {
        cleanupUserContext();
      }
    });
    } catch (err) {
      console.error("Discord message handler error:", err);
    }
  });
}

module.exports = { setup };
