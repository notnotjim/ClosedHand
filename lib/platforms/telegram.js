// lib/platforms/telegram.js — Telegram bot message handler

const https = require("https");
const ctx = require("../context");
const { queueUserMessage } = ctx;
const { UserStore, getUserByPlatform } = require("../../user-store");
const { saveStore, swapToCloudStore, cleanupUserContext } = require("../storage");
const { getConversation, archiveThread, switchThread, getThreadList, clearAllThreads, formatRelativeTime } = require("../conversation");
const { queuedAsk, ask, getAllTools } = require("../engine");
const { sendTyping, sendText, reactToMessage, removeReaction, sendStatusMessage, deleteStatusMessage, toolStatusText } = require("../messaging");
const { StatusFeed, createEditInPlaceRenderer } = require("../status-feed");
const { downloadTelegramFile, IMAGE_EXTENSIONS, TEXT_EXTENSIONS, OFFICE_EXTENSIONS } = require("../files");
const { saveAttachment } = require("../attachments");
const { removeKeyboard } = require("../location");
const { transcribeAudio } = require("../voice");
const { httpGet } = require("../http");
const { isGoogleConnected } = require("../services/google");
const { isShopifyConnected } = require("../services/shopify");
const { isMetaAdsConnected } = require("../services/meta");
const { WELCOME_MESSAGE, handleOnboardingMessage, generatePlatformWelcome } = require("../onboarding");

// Telegram sends an album as separate messages that share a media_group_id.
// Buffer them briefly so the set arrives as one question: without this each
// photo becomes its own turn and the model never sees them together.
const _tgAlbumBuffer = {}; // "chatId:groupId" -> { files, caption, timer, msgIds, userId }
const ALBUM_DEBOUNCE_MS = 2500;

// Helper: create StatusFeed opts for Telegram chat
function createTelegramStatusOpts(chatId) {
  const feed = new StatusFeed(createEditInPlaceRenderer(chatId, "telegram", {
    sendFn: async (cid, text) => {
      const sent = await ctx.bot.sendMessage(cid, text);
      return { platform: "telegram", chatId: cid, messageId: sent.message_id };
    },
    editFn: async (info, text) => {
      await ctx.bot.editMessageText(text, { chat_id: info.chatId, message_id: info.messageId });
    },
    deleteFn: async (info) => {
      await ctx.bot.deleteMessage(info.chatId, info.messageId).catch(() => {});
    },
  }));

  // Streaming: send initial message after ~50 tokens, edit every ~1s
  let streamMsgInfo = null;
  let streamBuffer = "";
  let streamLastEdit = 0;
  let streamEditTimer = null;
  const STREAM_INITIAL_THRESHOLD = 50; // tokens before first send
  const STREAM_EDIT_INTERVAL = 1000; // ms between edits

  async function flushStream() {
    if (!streamBuffer) return;
    const text = streamBuffer + " ...";
    try {
      if (!streamMsgInfo) {
        const sent = await ctx.bot.sendMessage(chatId, text);
        streamMsgInfo = { chatId, messageId: sent.message_id };
      } else {
        await ctx.bot.editMessageText(text, { chat_id: streamMsgInfo.chatId, message_id: streamMsgInfo.messageId });
      }
      streamLastEdit = Date.now();
    } catch (e) { /* edit throttled */ }
  }

  return {
    opts: {
      onToolStart(toolNames) {},
      onStatusEvent(event) { feed.emit(event); },
      onStreamToken(token) {
        streamBuffer += token;
        // Send initial message after enough tokens
        if (!streamMsgInfo && streamBuffer.length >= STREAM_INITIAL_THRESHOLD) {
          flushStream();
        }
        // Debounced edit for subsequent tokens
        if (streamMsgInfo && !streamEditTimer) {
          streamEditTimer = setTimeout(() => {
            streamEditTimer = null;
            flushStream();
          }, STREAM_EDIT_INTERVAL);
        }
      },
    },
    cleanup() {
      feed.clear();
      if (streamEditTimer) clearTimeout(streamEditTimer);
    },
    getStreamMsgInfo() { return streamMsgInfo; },
  };
}

const TELEGRAM_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN || require("../config").getConfCached("TELEGRAM_BOT_TOKEN");
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

function setup() {
  ctx.bot.on("message", async (msg) => {
    ctx.pollingErrors = 0;
    const chatId = msg.chat.id;
    const telegramUserId = msg.from.id.toString();

    // 1:1 only, same as the Discord handler's DM gate. Without this, a group
    // containing a linked user would load their full private context (recall,
    // facts, conversation) and answer into the room, with nothing but model
    // discretion between their 1:1 history and everyone present. If groups
    // ever become a real feature, they need structural context separation
    // first, not an open door here.
    if (msg.chat.type && msg.chat.type !== "private") return;

    // First-sender-claims: the first sender binds the platform; strangers get one polite refusal.
    const access = require("../access");
    const verdict = await access.checkSenderAccess("telegram", telegramUserId);
    if (!verdict.allowed) {
      access.sendRefusal("telegram", telegramUserId, verdict, (text) => ctx.bot.sendMessage(chatId, text));
      return;
    }

    // === USER IDENTIFICATION (Supabase lookup) ===
    const user = await getUserByPlatform("telegram", telegramUserId);
    const userId = user.id;

    // Reply context: Telegram gives us the full replied-to message
    let replyContext = null;
    let replyFileData = null;
    if (msg.reply_to_message) {
      const replied = msg.reply_to_message;
      replyContext = replied.text || replied.caption || null;
      // If replying to a photo, download it
      if (replied.photo && replied.photo.length > 0) {
        try {
          const photoId = replied.photo[replied.photo.length - 1].file_id;
          const fd = await downloadTelegramFile(photoId);
          if (fd) replyFileData = fd;
        } catch (e) {}
      }
    }

    // Queue entire message processing per-user to prevent race conditions
    queueUserMessage(userId, async () => {
    const userStore = await UserStore.load(userId);
    swapToCloudStore(userStore, userId, chatId);
    ctx.activePlatform = "telegram";
    require("../workspace-cache").maybeRefreshOnSessionStart(userStore, userId);

    try {

    // Conversational onboarding for new users
    if (!ctx.store.facts["_onboarded"] && msg.text && !msg.text.startsWith("/")) {
      await handleOnboardingMessage(userId, chatId, msg.text);
      return;
    }

    // Handle photos
    if (msg.photo) {
      reactToMessage(chatId, msg.message_id, "🤔");
      ctx.bot.sendChatAction(chatId, "typing");
      const photoId = msg.photo[msg.photo.length - 1].file_id;
      const fileData = await downloadTelegramFile(photoId);

      if (!fileData) {
        removeReaction(chatId, msg.message_id).catch(() => {});
        ctx.bot.sendMessage(chatId, "Couldn't download that image. Try again?");
        return;
      }

      // Part of an album: collect the whole set before answering
      if (msg.media_group_id) {
        const key = `${chatId}:${msg.media_group_id}`;
        if (!_tgAlbumBuffer[key]) {
          _tgAlbumBuffer[key] = { files: [], caption: null, timer: null, msgIds: [], userId };
        }
        const batch = _tgAlbumBuffer[key];
        batch.files.push(fileData);
        batch.msgIds.push(msg.message_id);
        if (msg.caption) batch.caption = msg.caption; // Telegram puts it on one photo only

        if (batch.timer) clearTimeout(batch.timer);
        batch.timer = setTimeout(async () => {
          delete _tgAlbumBuffer[key];
          const { opts: albumOpts, cleanup: albumCleanup } = createTelegramStatusOpts(chatId);
          try {
            const combined = batch.files.length === 1 ? batch.files[0] : {
              isMultiImage: true,
              isImage: true,
              images: batch.files.map(f => ({ base64: f.base64, mediaType: f.mediaType })),
              ext: batch.files[0].ext,
              fileName: `images_${batch.files.length}.${batch.files[0].ext}`,
            };
            const albumResponse = await queuedAsk(batch.userId, batch.caption, combined, chatId, albumOpts);
            for (const mid of batch.msgIds) removeReaction(chatId, mid).catch(() => {});
            albumCleanup();
            if (!albumResponse) return;
            if (albumResponse.length > 4000) {
              for (const chunk of albumResponse.match(/.{1,4000}/gs)) await ctx.bot.sendMessage(chatId, chunk);
            } else {
              await ctx.bot.sendMessage(chatId, albumResponse);
            }
          } catch (e) {
            for (const mid of batch.msgIds) removeReaction(chatId, mid).catch(() => {});
            albumCleanup();
            console.error(`[Telegram] Album error for ${chatId}:`, e.message);
            await ctx.bot.sendMessage(chatId, "Couldn't read those images. Try sending them again?").catch(() => {});
          }
        }, ALBUM_DEBOUNCE_MS);
        return;
      }

      const { opts, cleanup } = createTelegramStatusOpts(chatId);

      const caption = msg.caption || null;
      const response = await queuedAsk(userId, caption, fileData, chatId, opts);

      removeReaction(chatId, msg.message_id).catch(() => {});
      cleanup();

      if (!response) return; // Waiting for location
      if (response.length > 4000) {
        const chunks = response.match(/.{1,4000}/gs);
        for (const chunk of chunks) await ctx.bot.sendMessage(chatId, chunk);
      } else {
        ctx.bot.sendMessage(chatId, response);
      }
      return;
    }

    // Handle documents (PDFs, text files, spreadsheets, etc.)
    if (msg.document) {
      reactToMessage(chatId, msg.message_id, "🤔");
      ctx.bot.sendChatAction(chatId, "typing");
      const fileData = await downloadTelegramFile(msg.document.file_id);

      if (!fileData) {
        removeReaction(chatId, msg.message_id).catch(() => {});
        ctx.bot.sendMessage(chatId, "Couldn't download that file. Try again?");
        return;
      }

      // Check if it's a type Claude can work with
      const supportedTypes = [...IMAGE_EXTENSIONS, ...TEXT_EXTENSIONS, ...OFFICE_EXTENSIONS, "pdf"];
      if (!supportedTypes.includes(fileData.ext)) {
        removeReaction(chatId, msg.message_id).catch(() => {});
        // Save it anyway — future tools might handle it
        const desc = `${fileData.fileName} — ${fileData.ext} file (unsupported for direct viewing)`;
        const attachmentId = saveAttachment(userId, fileData, desc);
        ctx.bot.sendMessage(
          chatId,
          `Saved as ${attachmentId}, but I can't read ${fileData.ext} files directly yet. ` +
            `Supported formats: images, PDFs, text files, and Office documents (docx, xlsx, pptx).`
        );
        return;
      }

      const { opts, cleanup } = createTelegramStatusOpts(chatId);

      const caption = msg.caption || null;
      const response = await queuedAsk(userId, caption, fileData, chatId, opts);

      removeReaction(chatId, msg.message_id).catch(() => {});
      cleanup();

      if (!response) return; // Waiting for location
      if (response.length > 4000) {
        const chunks = response.match(/.{1,4000}/gs);
        for (const chunk of chunks) await ctx.bot.sendMessage(chatId, chunk);
      } else {
        ctx.bot.sendMessage(chatId, response);
      }
      return;
    }

    // Handle location sharing (Telegram location pin)
    if (msg.location) {
      ctx.bot.sendChatAction(chatId, "typing");
      const lat = msg.location.latitude;
      const lng = msg.location.longitude;
      // Reverse geocode to get a human-readable name
      let locationName = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
      if (GOOGLE_MAPS_API_KEY) {
        try {
          const { body } = await httpGet(
            `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${GOOGLE_MAPS_API_KEY}`
          );
          const data = JSON.parse(body);
          if (data.results?.[0]) locationName = data.results[0].formatted_address;
        } catch (e) {}
      }
      ctx.store.location = { name: locationName, latitude: lat, longitude: lng, updated: new Date().toISOString() };
      saveStore();
      console.log(`Location saved: ${locationName} (${lat}, ${lng})`);

      // Check if there's a pending request waiting for location
      const pending = ctx.pendingLocationRequests[userId];
      if (pending) {
        delete ctx.pendingLocationRequests[userId];
        // Remove the keyboard and replay the original message
        await removeKeyboard(chatId, `📍 Got it — ${locationName}`);
        ctx.bot.sendChatAction(chatId, "typing");
        // Pop the stale conversation entry from the failed attempt
        const conversation = getConversation(userId);
        if (conversation.length > 0 && conversation[conversation.length - 1].role === "user") {
          conversation.pop();
        }
        saveStore();
        const response = await ask(userId, pending.originalMessage, null, chatId);
        if (response && response.length > 4000) {
          const chunks = response.match(/.{1,4000}/gs);
          for (const chunk of chunks) await ctx.bot.sendMessage(chatId, chunk);
        } else if (response) {
          ctx.bot.sendMessage(chatId, response);
        }
      } else {
        // Location share without pending request
        await removeKeyboard(chatId, `📍 Location saved: ${locationName}`);
        const response = await ask(userId, `[User just shared their GPS location: ${locationName} (${lat}, ${lng}). This has been saved. If the user was previously asking about nearby places, weather, directions, or anything location-dependent, complete that request now using the saved location.]`, null, chatId);
        if (response && response.length > 4000) {
          const chunks = response.match(/.{1,4000}/gs);
          for (const chunk of chunks) await ctx.bot.sendMessage(chatId, chunk);
        } else if (response) {
          ctx.bot.sendMessage(chatId, response);
        }
      }
      return;
    }

    // Handle voice reply preference toggle (intercept before Claude)
    if (msg.text && /^voice\s+replies?\s+(on|off)$/i.test(msg.text.trim())) {
      const pref = /on$/i.test(msg.text.trim()) ? "on" : "off";
      ctx.store.facts["_voice_reply_pref"] = pref;
      const { saveStore } = require("../storage");
      saveStore();
      await ctx.bot.sendMessage(chatId, pref === "on" ? "Voice replies turned on. I'll respond to your voice messages with voice notes." : "Voice replies turned off. I'll respond with text.");
      return;
    }

    if (!msg.text) {
      // Handle voice messages and audio
      if (msg.voice || msg.audio) {
        reactToMessage(chatId, msg.message_id, "🤔");
        ctx.bot.sendChatAction(chatId, "typing");
        const fileId = msg.voice?.file_id || msg.audio?.file_id;
        try {
          const file = await ctx.bot.getFile(fileId);
          const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN()}/${file.file_path}`;
          const ext = file.file_path.split(".").pop().toLowerCase();

          // Download the audio
          const audioBuffer = await new Promise((resolve, reject) => {
            https.get(fileUrl, (res) => {
              const chunks = [];
              res.on("data", (c) => chunks.push(c));
              res.on("end", () => resolve(Buffer.concat(chunks)));
              res.on("error", reject);
            });
          });

          console.log(`Voice message received (${(audioBuffer.length / 1024).toFixed(1)}KB, ${ext})`);
          const transcript = await transcribeAudio(audioBuffer, "voice.ogg");
          console.log(`Transcribed: "${transcript.substring(0, 60)}..."`);

          const { opts, cleanup } = createTelegramStatusOpts(chatId);

          // Process transcription as if user typed it
          const response = await queuedAsk(userId, transcript, null, chatId, opts);

          removeReaction(chatId, msg.message_id).catch(() => {});
          cleanup();

          if (!response) return; // Waiting for location

          const voicePref = ctx.store.facts["_voice_reply_pref"];
          const { synthesize, isTtsAvailable } = require("../services/tts");
          const ttsReady = isTtsAvailable() && response.length < 4000;

          async function sendTextReply(r) {
            if (r.length > 4000) { const chunks = r.match(/.{1,4000}/gs); for (const chunk of chunks) await ctx.bot.sendMessage(chatId, chunk); }
            else ctx.bot.sendMessage(chatId, r);
          }

          if (voicePref === "on" && ttsReady) {
            try {
              const audioBuffer = await synthesize(response);
              await ctx.bot.sendVoice(chatId, audioBuffer);
            } catch (ttsErr) {
              console.error("[Telegram] TTS failed, sending text:", ttsErr.message);
              await sendTextReply(response);
            }
          } else {
            await sendTextReply(response);
            if (!voicePref && ttsReady) {
              ctx.store.facts["_voice_reply_pref"] = "asked";
              const { saveStore } = require("../storage");
              saveStore();
              await ctx.bot.sendMessage(chatId, "Tip: I can reply to voice messages with voice messages too. Say \"voice replies on\" to try it, or \"voice replies off\" to keep text only.");
            }
          }
        } catch (e) {
          removeReaction(chatId, msg.message_id).catch(() => {});
          console.error("Voice transcription error:", e.message);
          ctx.bot.sendMessage(chatId, `Couldn't transcribe that voice message: ${e.message}`);
        }
        return;
      }

      ctx.bot.sendMessage(chatId, "I can handle text, photos, documents, and voice messages.");
      return;
    }

    if (msg.text === "/start") {
      // Kick off onboarding if not done yet
      if (!ctx.store.facts["_onboarded"]) {
        await handleOnboardingMessage(userId, chatId, "/start");
        return;
      }

      const scheduleCount = ctx.store.schedules.length;
      const noteCount = Object.keys(ctx.store.facts).filter(k => !k.startsWith("_")).length;

      // Build connected services list
      const services = [];
      if (isGoogleConnected()) services.push("Gmail, Calendar, Drive");
      if (isShopifyConnected()) services.push("Shopify");
      if (isMetaAdsConnected()) services.push("Meta Ads");
      const otherServices = ["slack", "notion", "atlassian", "spotify", "stripe", "microsoft", "linkedin"];
      for (const svc of otherServices) {
        if (ctx.activeUserStore?.getConnection(svc)) services.push(svc.charAt(0).toUpperCase() + svc.slice(1));
      }

      let status = `Connected: ${services.length > 0 ? services.join(", ") : "None yet"}`;
      if (scheduleCount > 0) status += `\nSchedules: ${scheduleCount} active`;
      if (noteCount > 0) status += `\nNotes: ${noteCount} saved`;
      status += `\nPulse: ${ctx.store.pulse.enabled ? "ON (every " + ctx.store.pulse.intervalMinutes + " mins)" : "OFF"}`;

      const WEBAPP_URL = process.env.WEBAPP_URL || process.env.BASE_URL || "http://localhost:3000";
      ctx.bot.sendMessage(chatId, status, {
        reply_markup: {
          inline_keyboard: [[
            { text: "Settings", web_app: { url: `${WEBAPP_URL}/dashboard` } }
          ]]
        }
      });
      return;
    }

    if (msg.text && msg.text.startsWith("/proactive")) {
      const level = msg.text.replace(/^\/proactive\s*/, "").trim().toLowerCase();
      const levels = {
        "off": { enabled: false, minutes: 20, level: "off" },
        "low": { enabled: true, minutes: 60, level: "low" },
        "medium": { enabled: true, minutes: 30, level: "medium" },
        "high": { enabled: true, minutes: 15, level: "high" },
      };

      if (!level || !levels[level]) {
        const current = !ctx.store.pulse.enabled ? "off" : (ctx.store.pulse.proactiveLevel || "medium");
        ctx.bot.sendMessage(chatId, `Proactive level: ${current}\n\nSet with /proactive off, /proactive low, /proactive medium, or /proactive high.\n\nOff: I only respond when you message me.\nLow: I check every hour. Only tells you about urgent, time-sensitive things or connections between multiple signals you'd otherwise miss.\nMedium: Every 30 minutes. Tells you anything reasonably useful - upcoming events, key emails, disruptions, patterns.\nHigh: Every 15 minutes. Tells you anything that might interest you - trends, suggestions, things you might have forgotten, ideas based on what I know about you.`);
        return;
      }

      const setting = levels[level];
      ctx.store.pulse.enabled = setting.enabled;
      ctx.store.pulse.intervalMinutes = setting.minutes;
      ctx.store.pulse.proactiveLevel = setting.level;
      if (!ctx.store.pulse.deliveryPlatforms || ctx.store.pulse.deliveryPlatforms.length === 0) {
        ctx.store.pulse.deliveryPlatforms = [ctx.activePlatform];
      }
      saveStore();

      // Also sync to profile settings so dashboard stays in sync
      try {
        const { data: prof } = await ctx.supabase.from("profiles").select("settings").eq("id", userId).single();
        const curSettings = prof?.settings || {};
        curSettings.pulse_settings = curSettings.pulse_settings || {};
        curSettings.pulse_settings.proactiveLevel = setting.level;
        curSettings.pulse_settings.deliveryPlatforms = ctx.store.pulse.deliveryPlatforms;
        await ctx.supabase.from("profiles").update({ settings: curSettings, updated_at: new Date().toISOString() }).eq("id", userId);
      } catch (e) {
        console.error("Failed to sync pulse to profile:", e.message);
      }

      if (level === "off") {
        ctx.bot.sendMessage(chatId, "Pulse is off. I'll only respond when you message me.");
      } else {
        const descriptions = {
          low: "I'll check every hour and only reach out about urgent things or when I spot connections between your email, calendar, and other signals that you'd want to know about.",
          medium: "I'll check every 30 minutes and let you know about anything reasonably useful - upcoming events, key emails, disruptions, and patterns I notice across your connected services.",
          high: "I'll check every 15 minutes and tell you about anything that might interest you - trends, suggestions, things you might have forgotten, and ideas based on everything I know about you.",
        };
        ctx.bot.sendMessage(chatId, `Pulse set to ${level}. ${descriptions[level]}`);
      }
      return;
    }

    // /new - archive current thread, start fresh
    if (msg.text === "/new") {
      try {
        await archiveThread(userId);
        saveStore();
        ctx.bot.sendMessage(chatId, "Fresh start. Your previous conversation is saved. Use /threads to go back to it anytime.");
      } catch (e) {
        // Fallback if threads table doesn't exist
        ctx.store.conversations[userId] = [];

        saveStore();
        ctx.bot.sendMessage(chatId, "Started a new conversation.");
      }
      return;
    }

    // /threads - show recent threads
    if (msg.text === "/threads") {
      try {
        const threads = await getThreadList(userId, 10);
        if (threads.length === 0) {
          ctx.bot.sendMessage(chatId, "No previous conversations. This is your first thread.");
          return;
        }
        ctx.bot.sendMessage(chatId, "Your threads:", {
          reply_markup: {
            inline_keyboard: threads.slice(0, 8).map(t => [{
              text: (t.is_active ? "[active] " : "") + (t.title || "Untitled").substring(0, 25) + " - " + (t.message_count || 0) + " msgs, " + formatRelativeTime(t.updated_at),
              callback_data: "thread:" + t.id
            }])
          }
        });
      } catch (e) {
        ctx.bot.sendMessage(chatId, "Couldn't load threads. Try again.");
      }
      return;
    }

    if (msg.text === "/clear") {
      try {
        await clearAllThreads(userId);
      } catch (e) {
        // Fallback if threads table doesn't exist
      }
      ctx.store.conversations[userId] = [];
      delete ctx.pendingConfirmations[userId];
      saveStore();
      ctx.bot.sendMessage(chatId, "Conversation cleared.");
      return;
    }

    if (msg.text === "/id") {
      ctx.bot.sendMessage(chatId, `Your ClosedHand account ID: ${userId}\nUseful to quote if you ever report a problem.`);
      return;
    }

    // Admin only: the same tool names the system prompt tells the model never
    // to reveal should not be handed out by a command that bypasses the model
    // entirely. For anyone else the text falls through and reads as chat.
    if (msg.text === "/tools" && userId === process.env.ADMIN_USER_ID) {
      const allTools = getAllTools();
      if (allTools.length === 0) {
        ctx.bot.sendMessage(chatId, "No tools connected.");
      } else {
        const list = allTools.map((t) => `- ${t.name}`).join("\n");
        ctx.bot.sendMessage(chatId, `Available tools (${allTools.length}):\n\n${list}`);
      }
      return;
    }

    if (msg.text === "/schedules") {
      if (ctx.store.schedules.length === 0) {
        ctx.bot.sendMessage(chatId, "No schedules set up. Just tell me to do something regularly and I'll set it up.");
      } else {
        const list = ctx.store.schedules
          .map((s) => `- ${s.name}: ${s.cron}\n  "${s.prompt}"`)
          .join("\n\n");
        ctx.bot.sendMessage(chatId, `Active schedules:\n\n${list}`);
      }
      return;
    }

    if (msg.text === "/pulse") {
      const hb = ctx.store.pulse;
      if (hb.enabled) {
        let status = `Pulse: ON\nInterval: every ${hb.intervalMinutes} minutes\nQuiet hours: ${hb.quietStart}:00–${hb.quietEnd}:00`;
        if (hb.lastRun) status += `\nLast check: ${new Date(hb.lastRun).toLocaleTimeString("en-GB")}`;
        if (hb.lastNotified) status += `\nLast notification: ${new Date(hb.lastNotified).toLocaleTimeString("en-GB")}`;
        status += `\n\nSay "turn off pulse" to disable.`;
        ctx.bot.sendMessage(chatId, status);
      } else {
        ctx.bot.sendMessage(chatId, `Pulse: OFF\n\nSay "turn on pulse" to enable proactive notifications.`);
      }
      return;
    }

    // Pending confirmations are intercepted inside queuedAsk (single chokepoint)

    reactToMessage(chatId, msg.message_id, "🤔");
    ctx.bot.sendChatAction(chatId, "typing");

    // Prepend reply context if user is replying to a specific message
    let userText = msg.text;
    if (replyContext) {
      userText = `[Replying to: "${replyContext.substring(0, 300)}"]\n\n${msg.text}`;
    }

    const statusOpts = createTelegramStatusOpts(chatId);

    const response = await queuedAsk(userId, userText, replyFileData, chatId, statusOpts.opts);

    removeReaction(chatId, msg.message_id).catch(() => {});
    const streamInfo = statusOpts.getStreamMsgInfo();
    statusOpts.cleanup();

    if (!response) return; // Waiting for location
    if (streamInfo && response.length <= 4000) {
      // Streamed response: edit the existing message with final text
      try {
        await ctx.bot.editMessageText(response, { chat_id: streamInfo.chatId, message_id: streamInfo.messageId });
      } catch (e) {
        // Edit failed (message might be too different), send new
        ctx.bot.sendMessage(chatId, response);
      }
    } else if (response.length > 4000) {
      if (streamInfo) {
        // Delete the partial stream message, send chunked
        ctx.bot.deleteMessage(streamInfo.chatId, streamInfo.messageId).catch(() => {});
      }
      const chunks = response.match(/.{1,4000}/gs);
      for (const chunk of chunks) await ctx.bot.sendMessage(chatId, chunk);
    } else {
      ctx.bot.sendMessage(chatId, response);
    }

    } finally {
      cleanupUserContext();
    }
    }); // end queueUserMessage
  });

  // Polling error handler
  // Thread switching via inline keyboard
  ctx.bot.on("callback_query", async (query) => {
    if (!query.data || !query.data.startsWith("thread:")) return;
    const threadId = query.data.split(":")[1];
    const tgUserId = String(query.from.id);
    const tgChatId = query.message?.chat?.id;
    if (!tgChatId) return;

    try {
      ctx.bot.answerCallbackQuery(query.id, { text: "Switching..." });
      const user = await getUserByPlatform("telegram", tgUserId);
      if (!user) return;

      await queueUserMessage(user.id, async () => {
        const userStore = await UserStore.load(user.id);
        swapToCloudStore(userStore, user.id, tgChatId);
        ctx.activePlatform = "telegram";

        const result = await switchThread(user.id, threadId);
        saveStore();
        cleanupUserContext();

        if (result) {
          ctx.bot.sendMessage(tgChatId, `Picked up: ${result.title || "previous conversation"}. What were we saying?`);
        } else {
          ctx.bot.sendMessage(tgChatId, "Couldn't find that conversation.");
        }
      });
    } catch (e) {
      console.error("[Telegram] Thread switch error:", e.message);
      ctx.bot.sendMessage(tgChatId, "Couldn't switch thread. Try again.");
    }
  });

  let _telegramBouncing = false;
  ctx.bot.on("polling_error", async (error) => {
    // 409 Conflict = another instance is polling (normal during Railway deploys).
    // Ignore it — the old instance will die shortly and polling will recover.
    if (error.message?.includes("409")) return;

    ctx.pollingErrors++;
    console.error(`Telegram polling error (${ctx.pollingErrors}): ${error.message}`);

    // Telegram's own API returns 502/500 during its outages, and the polling
    // library keeps retrying through them on its own. Exiting the process here
    // (it also runs WhatsApp, Discord and Web) turned a transient Telegram blip
    // into a crash loop that took every platform down: no message arrives during
    // the outage to reset the counter, so every restart hit the limit and exited
    // again. Never exit. After a run of errors, bounce ONLY the Telegram poller,
    // with backoff, and leave the rest of the bot serving.
    if (ctx.pollingErrors >= 5 && ctx.pollingErrors % 5 === 0 && !_telegramBouncing) {
      _telegramBouncing = true;
      console.log(`Telegram: ${ctx.pollingErrors} polling errors, bouncing the poller (process stays up)...`);
      try {
        await ctx.bot.stopPolling({ cancel: true });
        await new Promise((r) => setTimeout(r, 10000));
        await ctx.bot.startPolling();
        console.log("Telegram poller restarted.");
      } catch (e) {
        console.error(`Telegram poller restart failed (library will keep retrying): ${e.message}`);
      } finally {
        _telegramBouncing = false;
      }
    }
  });
}

module.exports = { setup };
