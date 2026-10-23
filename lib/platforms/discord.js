// lib/platforms/discord.js — Discord DM handler

const ctx = require("../context");
const { queueUserMessage } = ctx;
const { UserStore, getUserByPlatform } = require("../../user-store");
const { saveStore, swapToCloudStore, cleanupUserContext } = require("../storage");
const { clearAllThreads } = require("../conversation");
const { queuedAsk } = require("../engine");
const { sendDiscordMessage } = require("../messaging");
const { StatusFeed, createEditInPlaceRenderer } = require("../status-feed");
const { handleOnboardingMessage, generatePlatformWelcome } = require("../onboarding");
const { peek } = require("../log-text");

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

    console.log(`Discord DM from ${discordUserId}: ${peek(text)}`);

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
    }, { text, platform: "discord", chatId: discordUserId });
    } catch (err) {
      console.error("Discord message handler error:", err);
    }
  });
}

module.exports = { setup };
