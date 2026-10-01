// lib/platforms/whatsapp.js — WhatsApp webhook handler

const crypto = require("crypto");
const https = require("https");
const ctx = require("../context");
const { queueUserMessage } = ctx;
const { supabase, UserStore, getUserByPlatform } = require("../../user-store");
const { saveStore, swapToCloudStore, cleanupUserContext } = require("../storage");
const { getConversation, archiveThread, switchThread, getThreadList, clearAllThreads, formatRelativeTime } = require("../conversation");
const { queuedAsk } = require("../engine");
const { fileBugReport } = require("../bug-reports");

// Dedup: WhatsApp can deliver the same webhook multiple times
const _processedMsgIds = new Set();
const DEDUP_MAX = 500;
function isDuplicate(msgId) {
  if (_processedMsgIds.has(msgId)) return true;
  _processedMsgIds.add(msgId);
  if (_processedMsgIds.size > DEDUP_MAX) {
    const first = _processedMsgIds.values().next().value;
    _processedMsgIds.delete(first);
  }
  return false;
}
const { sendWhatsAppMessage, sendWhatsAppInteractive, markWhatsAppRead, sendTyping, reactToMessage, removeReaction } = require("../messaging");
const { StatusFeed, createEditInPlaceRenderer, getActivityDescription } = require("../status-feed");
const { isGoogleConnected } = require("../services/google");
const { isShopifyConnected } = require("../services/shopify");
const { isMetaAdsConnected } = require("../services/meta");

// Track recent outgoing messages per user for reply context
// In-memory ring buffer (fast lookup) + Supabase persistence (survives restarts)
const _waOutgoing = {};
const _waIncoming = {}; // Track user's own messages for reply-to-self context

// Image debounce: buffer images for 3s to batch multi-image sends
const _waImageBuffer = {}; // waId -> { images: [{buffer, mimeType, caption}], timer, msgIds: [], userId }
const IMAGE_DEBOUNCE_MS = 3000;

// Sending an album delivers the photos plus an extra message the Cloud API
// marks "unsupported". Answering that one with a capability list talks over the
// album the user actually sent, so an unsupported message waits to see whether
// a real one lands beside it before saying anything.
const _waLastRealMsgAt = {}; // waId -> timestamp of last text/image/audio/document
const UNSUPPORTED_GRACE_MS = 4000;

function trackIncoming(waId, msgId, text, mediaId, mediaType) {
  if (!_waIncoming[waId]) _waIncoming[waId] = [];
  _waIncoming[waId].push({ id: msgId, text: (text || "").substring(0, 500), mediaId: mediaId || null, mediaType: mediaType || null, ts: Date.now() });
  if (_waIncoming[waId].length > 20) _waIncoming[waId].shift();
}

function trackOutgoing(waId, userId, msgId, text) {
  if (!_waOutgoing[waId]) _waOutgoing[waId] = [];
  _waOutgoing[waId].push({ id: msgId, text: (text || "").substring(0, 500), ts: Date.now() });
  if (_waOutgoing[waId].length > 30) _waOutgoing[waId].shift();
  // Persist to Supabase (fire and forget, don't block)
  supabase.from("facts").upsert({
    user_id: userId, key: "_wa_outgoing",
    value: JSON.stringify(_waOutgoing[waId].slice(-20)),
  }, { onConflict: "user_id,key" }).then(() => {}).catch(() => {});
}

async function loadOutgoing(waId, userId) {
  if (_waOutgoing[waId] && _waOutgoing[waId].length > 0) return;
  try {
    const { data } = await supabase.from("facts").select("value").eq("user_id", userId).eq("key", "_wa_outgoing").single();
    if (data?.value) {
      const parsed = JSON.parse(data.value);
      _waOutgoing[waId] = Array.isArray(parsed) ? parsed : [];
    }
  } catch (e) { /* no stored messages yet */ }
}
const { handleOnboardingMessage, generatePlatformWelcome } = require("../onboarding");
const { transcribeAudio } = require("../voice");
const { buildFileData, IMAGE_EXTENSIONS, TEXT_EXTENSIONS, OFFICE_EXTENSIONS } = require("../files");

const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "closedhand_whatsapp_verify";
const WHATSAPP_WABA_ID = process.env.WHATSAPP_WABA_ID;

function extFromMime(mime) {
  const map = {
    "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
    "audio/ogg": "ogg", "audio/ogg; codecs=opus": "ogg", "audio/mpeg": "mp3",
    "audio/mp4": "m4a", "audio/amr": "amr",
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "text/plain": "txt", "text/csv": "csv",
  };
  const base = (mime || "").split(";")[0].trim();
  return map[mime] || map[base] || base.split("/")[1] || "bin";
}

async function downloadWhatsAppMedia(mediaId) {
  // Step 1: Get the media URL from Graph API
  const mediaInfo = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "graph.facebook.com",
      path: `/v21.0/${mediaId}`,
      method: "GET",
      headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` },
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(new Error("Failed to parse media info")); }
      });
    });
    req.on("error", reject);
    req.end();
  });

  if (!mediaInfo.url) throw new Error("No media URL returned from WhatsApp");

  // Step 2: Download the actual binary (Meta CDN, needs auth header)
  const url = new URL(mediaInfo.url);
  const buffer = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "GET",
      headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` },
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("Media download timeout")); });
    req.end();
  });

  return { buffer, mimeType: mediaInfo.mime_type, fileSize: mediaInfo.file_size };
}

async function subscribeWhatsAppWebhook() {
  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_WABA_ID) {
    console.log("[WhatsApp] Skipping WABA subscription — missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_WABA_ID");
    return;
  }

  try {
    const postData = JSON.stringify({ override_callback_uri: "", verify_token: "" });
    const response = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: "graph.facebook.com",
          path: `/v21.0/${WHATSAPP_WABA_ID}/subscribed_apps`,
          method: "POST",
          headers: {
            Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
            "Content-Type": "application/json",
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString()));
            } catch (e) {
              resolve({ error: { message: Buffer.concat(chunks).toString() } });
            }
          });
        }
      );
      req.on("error", reject);
      req.write(postData);
      req.end();
    });

    if (response.success) {
      console.log("[WhatsApp] Successfully subscribed app to WABA — real messages should now arrive");
    } else {
      console.error("[WhatsApp] WABA subscription failed:", response.error?.message || JSON.stringify(response));
      console.error("[WhatsApp] → You may need a System User access token with whatsapp_business_management permission");
      console.error("[WhatsApp] → Also check that your Meta App is set to LIVE mode (not Development)");
    }
  } catch (err) {
    console.error("[WhatsApp] WABA subscription request failed:", err.message);
  }
}

// Buffer an inbound image and answer the whole burst as one turn.
//
// An album arrives as one webhook per photo, and WhatsApp types those webhooks
// as `image` or `document` depending on how the photos were sent, with only the
// first carrying the caption. Batching used to live inside the image branch, so
// a set sent as files became one turn per photo: the second photo reached the
// engine with no caption, fell back to the generic "What's in this <ext> file?"
// prompt, and had nothing to say it belonged with the first. The buffer is
// keyed on the file being an image, not on which webhook type carried it.
function bufferImageForBatch({ waId, userId, buffer, mimeType, caption, msgId }) {
  if (!_waImageBuffer[waId]) {
    _waImageBuffer[waId] = { images: [], timer: null, msgIds: [], userId, caption: null };
  }
  _waImageBuffer[waId].images.push({ buffer, mimeType });
  _waImageBuffer[waId].msgIds.push(msgId);
  if (caption) _waImageBuffer[waId].caption = caption; // last caption wins

  // Reset debounce timer
  if (_waImageBuffer[waId].timer) clearTimeout(_waImageBuffer[waId].timer);
  _waImageBuffer[waId].timer = setTimeout(() => {
    const batch = _waImageBuffer[waId];
    delete _waImageBuffer[waId];
    if (!batch || batch.images.length === 0) return;

    // Take a fresh turn on the queue, which is what gives this work a live
    // context bubble of its own. The bubble this timer was scheduled inside
    // belongs to the webhook that queued the last image, and that handler's
    // finally has already run cleanupUserContext() on it. AsyncLocalStorage
    // hands the timer the same object, so by the time it fires the platform,
    // user, chat and store are all nulled: everything downstream then read a
    // null platform and defaulted it to "web", and an agent spawned from an
    // image turn reported to a web session that does not exist instead of
    // back to WhatsApp.
    queueUserMessage(batch.userId, async () => {
      let batchStoreLoaded = false;
      try {
        const batchStore = await UserStore.load(batch.userId);
        swapToCloudStore(batchStore, batch.userId, waId);
        ctx.activePlatform = "whatsapp";
        batchStoreLoaded = true;

        let fileData;
        if (batch.images.length === 1) {
          const img = batch.images[0];
          const ext = extFromMime(img.mimeType);
          fileData = await buildFileData(img.buffer, `image.${ext}`, img.mimeType);
        } else {
          // Multi-image: pass as multiImage array. The extension follows the
          // actual media type, since saved attachments are named with it and
          // a webp album written out as .jpg will not open later.
          const ext = extFromMime(batch.images[0].mimeType);
          fileData = {
            isMultiImage: true,
            images: batch.images.map(img => ({
              base64: img.buffer.toString("base64"),
              mediaType: img.mimeType || "image/jpeg",
            })),
            ext, isImage: true, fileName: `images_${batch.images.length}.${ext}`,
          };
        }
        const response = await queuedAsk(batch.userId, batch.caption, fileData, waId);
        for (const mid of batch.msgIds) removeReaction(waId, mid).catch(() => {});
        if (response) await sendWhatsAppMessage(waId, response);
      } catch (e) {
        for (const mid of batch.msgIds) removeReaction(waId, mid).catch(() => {});
        console.error(`[WhatsApp] Image batch error for ${waId}:`, e.message);
        await sendWhatsAppMessage(waId, "Couldn't process those images. Try again?").catch(() => {});
      } finally {
        if (batchStoreLoaded) cleanupUserContext();
      }
    }).catch(() => {});
  }, IMAGE_DEBOUNCE_MS);
}

function setup() {
  // Verification endpoint — Meta sends a GET to verify the webhook
  ctx.expressApp.get("/webhook/whatsapp", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
      console.log("WhatsApp webhook verified");
      return res.status(200).send(challenge);
    }
    res.status(403).send("Forbidden");
  });

  // Incoming messages endpoint
  ctx.expressApp.post("/webhook/whatsapp", async (req, res) => {
    // Verify webhook signature from Meta
    const appSecret = process.env.WHATSAPP_APP_SECRET || process.env.META_APP_SECRET;
    if (appSecret && req.rawBody) {
      const sigHeader = req.headers["x-hub-signature-256"] || "";
      const expectedSig = "sha256=" + crypto.createHmac("sha256", appSecret).update(req.rawBody).digest("hex");
      if (sigHeader.length !== expectedSig.length || !crypto.timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expectedSig))) {
        console.warn("[WhatsApp] Webhook signature mismatch — rejecting request");
        return res.sendStatus(403);
      }
    }

    // Always respond 200 quickly — Meta will retry if we don't
    res.sendStatus(200);

    try {
      const entry = req.body?.entry?.[0];
      const changes = entry?.changes?.[0];

      // Log every webhook hit so we can diagnose dropped messages
      console.log(`[WhatsApp] Webhook POST — field: ${changes?.field || "none"}, has_messages: ${!!changes?.value?.messages?.length}, has_statuses: ${!!changes?.value?.statuses?.length}`);

      if (!changes || changes.field !== "messages") return;

      const value = changes.value;
      const messages = value?.messages;
      if (!messages || messages.length === 0) return;

      for (const msg of messages) {
        const waId = msg.from;
        const waMessageId = msg.id;
        if (isDuplicate(waMessageId)) {
          console.log(`[WhatsApp] Skipping duplicate message ${waMessageId} from ${waId}`);
          continue;
        }
        // Caption is logged too: on an album it carries the user's actual
        // question, and it is the first thing to check when a photo reply
        // answers the wrong thing.
        console.log(`[WhatsApp] Message from ${waId}: type=${msg.type}, text=${msg.text?.body?.substring(0, 50) || "(none)"}, caption=${(msg.image?.caption || msg.document?.caption || "").substring(0, 50) || "(none)"}`);


        // Extract reply context if user is replying to a specific message
        // Also collects images from nearby messages (burst sends: multi-image within 10s)
        let replyContext = null;
        let replyMediaIds = []; // may be multiple images from a burst
        if (msg.context?.id) {
          const outMatch = _waOutgoing[waId]?.find(m => m.id === msg.context.id);
          const inMatch = _waIncoming[waId]?.find(m => m.id === msg.context.id);
          replyContext = outMatch?.text || inMatch?.text || null;

          if (inMatch) {
            // Collect all media from messages in the same burst (within 10s of the replied-to message)
            const BURST_WINDOW_MS = 10000;
            const incoming = _waIncoming[waId] || [];
            for (const m of incoming) {
              if (m.mediaId && Math.abs(m.ts - inMatch.ts) <= BURST_WINDOW_MS) {
                replyMediaIds.push(m.mediaId);
              }
            }
            // Combine text from all burst messages for better context
            if (!replyContext) {
              const burstTexts = incoming
                .filter(m => m.text && Math.abs(m.ts - inMatch.ts) <= BURST_WINDOW_MS)
                .map(m => m.text);
              if (burstTexts.length > 0) replyContext = burstTexts.join(" ");
            }
          }
        }

        markWhatsAppRead(waMessageId);

        // A reaction is not an unhandled message type, it is something the user
        // does deliberately, so it never earns a capability list. Thumbs down is
        // the shortest bug report there is: no typing, no command to remember.
        if (msg.type === "reaction") {
          const emoji = msg.reaction?.emoji || "";
          if (emoji.startsWith("\u{1F44E}")) {
            const reactUser = await getUserByPlatform("whatsapp", waId);
            if (reactUser) {
              const reply = await fileBugReport({
                userId: reactUser.id,
                text: "/bug thumbs down on a reply",
                fileData: null,
                platform: "whatsapp",
                chatId: waId,
              });
              await sendWhatsAppMessage(waId, reply).catch(() => {});
            }
          }
          continue;
        }

        // Determine message content type
        const isText = msg.type === "text" && msg.text?.body;
        const isImage = msg.type === "image" && msg.image?.id;
        const isAudio = msg.type === "audio" && msg.audio?.id;
        const isDocument = msg.type === "document" && msg.document?.id;

        if (!isText && !isImage && !isAudio && !isDocument) {
          console.log(`[WhatsApp] Unhandled type=${msg.type} from ${waId}: ${JSON.stringify(msg.errors || {}).substring(0, 200)}`);
          // Hold the reply briefly: if a real message arrives either side of
          // this one it was part of the same send (an album, typically) and
          // has already been answered on its own terms.
          const seenAt = Date.now();
          setTimeout(() => {
            const lastReal = _waLastRealMsgAt[waId] || 0;
            if (Math.abs(lastReal - seenAt) <= UNSUPPORTED_GRACE_MS) return;
            sendWhatsAppMessage(waId, "I can handle text, images, voice messages, and documents.");
          }, UNSUPPORTED_GRACE_MS);
          continue;
        }

        _waLastRealMsgAt[waId] = Date.now();

        // Track user's incoming messages for reply-to-self context
        trackIncoming(waId, waMessageId, isText ? msg.text.body : (msg.image?.caption || msg.document?.filename || ""),
          isImage ? msg.image.id : (isDocument ? msg.document.id : null),
          isImage ? "image" : (isDocument ? "document" : null));

        const text = isText ? msg.text.body.trim() : null;

        const access = require("../access");
        const verdict = await access.checkSenderAccess("whatsapp", waId);
        if (!verdict.allowed) {
          access.sendRefusal("whatsapp", waId, verdict, (text) => sendWhatsAppMessage(waId, text));
          return;
        }
        const user = await getUserByPlatform("whatsapp", waId);
        // Track inbound time: proactive delivery may use WhatsApp only within
        // Meta's 24h customer-service window from the user's last message
        require("../proactive").markWhatsAppInbound(user.id).catch(() => {});

        const userId = user.id;

        queueUserMessage(userId, async () => {
          console.log(`[WhatsApp] Queue handler started for ${waId} (${userId})`);
          let storeLoaded = false;
          try {
            const userStore = await UserStore.load(userId);
            console.log(`[WhatsApp] UserStore loaded for ${waId} — notes: ${Object.keys(userStore.notes).length}, convos: ${userStore.conversations.length}`);
            // Load outgoing message history for reply context (from Supabase if not in memory)
            await loadOutgoing(waId, userId);
            if (msg.context?.id && !replyContext) {
              replyContext = _waOutgoing[waId]?.find(m => m.id === msg.context.id)?.text || null;
            }
            swapToCloudStore(userStore, userId, waId);
            ctx.activePlatform = "whatsapp";
            require("../workspace-cache").maybeRefreshOnSessionStart(userStore, userId);
            storeLoaded = true;

            // Handle voice reply preference toggle (intercept before Claude)
            if (isText && /^voice\s+replies?\s+(on|off)$/i.test(text)) {
              const pref = /on$/i.test(text) ? "on" : "off";
              ctx.store.facts["_voice_reply_pref"] = pref;
              const { saveStore } = require("../storage");
              saveStore();
              await sendWhatsAppMessage(waId, pref === "on" ? "Voice replies turned on. I'll respond to your voice messages with voice notes." : "Voice replies turned off. I'll respond with text.");
              return;
            }

            // Handle image messages (debounced to batch multi-image sends)
            if (isImage) {
              reactToMessage(waId, waMessageId, "🤔");
              try {
                const { buffer, mimeType } = await downloadWhatsAppMedia(msg.image.id);
                bufferImageForBatch({
                  waId, userId, buffer,
                  mimeType: mimeType || msg.image.mime_type,
                  caption: msg.image.caption || null,
                  msgId: waMessageId,
                });
              } catch (e) {
                removeReaction(waId, waMessageId).catch(() => {});
                console.error(`[WhatsApp] Image download error for ${waId}:`, e.message);
                await sendWhatsAppMessage(waId, "Couldn't download that image. Try again?").catch(() => {});
              }
              return;
            }

            // Handle voice/audio messages
            if (isAudio) {
              reactToMessage(waId, waMessageId, "🤔");
              try {
                const { buffer, mimeType } = await downloadWhatsAppMedia(msg.audio.id);
                const ext = extFromMime(mimeType || msg.audio.mime_type);
                console.log(`[WhatsApp] Voice message from ${waId} (${(buffer.length / 1024).toFixed(1)}KB, ${ext})`);
                const transcript = await transcribeAudio(buffer, `voice.${ext}`);
                console.log(`[WhatsApp] Transcribed: "${transcript.substring(0, 60)}..."`);
                const response = await queuedAsk(userId, transcript, null, waId);
                removeReaction(waId, waMessageId).catch(() => {});
                if (response) {
                  const voicePref = ctx.store.facts["_voice_reply_pref"];
                  const { synthesize, isTtsAvailable } = require("../services/tts");
                  const ttsReady = isTtsAvailable() && response.length < 4000;

                  if (voicePref === "on" && ttsReady) {
                    // User opted in: reply with voice
                    try {
                      const audioBuffer = await synthesize(response);
                      const { sendWhatsAppVoice } = require("../messaging");
                      await sendWhatsAppVoice(waId, audioBuffer);
                    } catch (ttsErr) {
                      console.error("[WhatsApp] TTS failed, sending text:", ttsErr.message);
                      await sendWhatsAppMessage(waId, response);
                    }
                  } else {
                    // Default: text reply
                    await sendWhatsAppMessage(waId, response);
                    // First time voice user and TTS available: ask about preference
                    if (!voicePref && ttsReady) {
                      ctx.store.facts["_voice_reply_pref"] = "asked";
                      const { saveStore } = require("../storage");
                      saveStore();
                      await sendWhatsAppMessage(waId, "Tip: I can reply to voice messages with voice messages too. Say \"voice replies on\" to try it, or \"voice replies off\" to keep text only.");
                    }
                  }
                }
              } catch (e) {
                removeReaction(waId, waMessageId).catch(() => {});
                console.error(`[WhatsApp] Voice transcription error for ${waId}:`, e.message);
                await sendWhatsAppMessage(waId, `Couldn't transcribe that voice message: ${e.message}`).catch(() => {});
              }
              return;
            }

            // Handle document messages
            if (isDocument) {
              reactToMessage(waId, waMessageId, "🤔");
              try {
                const { buffer, mimeType } = await downloadWhatsAppMedia(msg.document.id);
                const filename = msg.document.filename || "document";
                const fileData = await buildFileData(buffer, filename, mimeType || msg.document.mime_type);

                const supportedTypes = [...IMAGE_EXTENSIONS, ...TEXT_EXTENSIONS, ...OFFICE_EXTENSIONS, "pdf"];
                if (!supportedTypes.includes(fileData.ext)) {
                  removeReaction(waId, waMessageId).catch(() => {});
                  await sendWhatsAppMessage(waId,
                    `I can't read .${fileData.ext} files yet. Supported: images, PDFs, text files, and Office docs (docx, xlsx, pptx).`
                  );
                  return;
                }

                // Photos sent as files arrive typed as documents, not images,
                // and an album still arrives one webhook per photo. Send them
                // through the same buffer so the set stays one turn.
                if (fileData.isImage) {
                  bufferImageForBatch({
                    waId, userId, buffer,
                    mimeType: fileData.mediaType,
                    caption: msg.document.caption || null,
                    msgId: waMessageId,
                  });
                  return;
                }

                const caption = msg.document.caption || null;
                const response = await queuedAsk(userId, caption, fileData, waId);
                removeReaction(waId, waMessageId).catch(() => {});
                if (response) await sendWhatsAppMessage(waId, response);
              } catch (e) {
                removeReaction(waId, waMessageId).catch(() => {});
                console.error(`[WhatsApp] Document processing error for ${waId}:`, e.message);
                await sendWhatsAppMessage(waId, "Couldn't process that document. Try again?").catch(() => {});
              }
              return;
            }

            // Pending confirmations are intercepted inside queuedAsk (single chokepoint)

            if (text === "/start" || text.toLowerCase() === "start") {
              const services = [];
              if (isGoogleConnected()) services.push("Gmail, Calendar, Drive");
              if (isShopifyConnected()) services.push("Shopify");
              if (isMetaAdsConnected()) services.push("Meta Ads");
              let status = `Connected: ${services.length > 0 ? services.join(", ") : "None yet"}`;
              status += `\nManage settings from your dashboard`;
              await sendWhatsAppMessage(waId, status);
              return;
            }

            // /new - archive current thread, start fresh
            if (text === "/new") {
              try {
                await archiveThread(userId);
                saveStore();
                await sendWhatsAppMessage(waId, "Fresh start. Your previous conversation is saved. Use /threads to go back to it anytime.");
              } catch (e) {
                ctx.store.conversations[userId] = [];

                saveStore();
                await sendWhatsAppMessage(waId, "Started a new conversation.");
              }
              return;
            }

            // /threads - show recent threads
            if (text === "/threads") {
              try {
                const threads = await getThreadList(userId, 10);
                if (threads.length === 0) {
                  await sendWhatsAppMessage(waId, "No previous conversations. This is your first thread.");
                  return;
                }
                const rows = threads.slice(0, 8).map((t) => ({
                  id: "thread_" + t.id,
                  title: (t.is_active ? "[active] " : "") + (t.title || "Untitled").substring(0, 24),
                  description: (t.message_count || 0) + " messages, " + formatRelativeTime(t.updated_at),
                }));
                await sendWhatsAppInteractive(waId, {
                  type: "list",
                  body: { text: "Your threads:" },
                  action: {
                    button: "View threads",
                    sections: [{ title: "Threads", rows }],
                  },
                });
              } catch (e) {
                await sendWhatsAppMessage(waId, "Couldn't load threads. Try again.");
              }
              return;
            }

            if (text === "/clear") {
              try {
                await clearAllThreads(userId);
              } catch (e) {}
              ctx.store.conversations[userId] = [];
              saveStore();
              await sendWhatsAppMessage(waId, "Conversation cleared.");
              return;
            }

            if (!ctx.store.facts["_onboarded"]) {
              // Double-check profile settings in case note was lost to a race condition
              const ps = ctx.activeUserStore?.profile?.settings || {};
              if (ps.onboarding_step === "done") {
                // Re-persist the lost flag
                ctx.store.facts["_onboarded"] = new Date().toISOString();
              } else {
                console.log(`[WhatsApp] Triggering onboarding for ${waId}`);
                await handleOnboardingMessage(userId, waId, text);
                return;
              }
            }
            console.log(`[WhatsApp] Passing to LLM for ${waId} - onboarded: ${!!ctx.store.facts["_onboarded"]}`);

            reactToMessage(waId, waMessageId, "🤔");
            sendTyping(waId);
            // Prepend reply context if user is replying to a specific message
            let userText = text;
            if (replyContext) {
              userText = `[Replying to your message: "${replyContext.substring(0, 300)}"]\n\n${text}`;
            }

            // WhatsApp status: progressive feedback so user never feels abandoned
            let waToolCount = 0;
            let waStatusSent = false;
            let waLatestDesc = "";
            // If no tool events arrive within 4s, send "Thinking..." so user knows bot is alive
            let waThinkingTimer = setTimeout(() => {
              if (!waStatusSent) {
                waStatusSent = true;
                sendWhatsAppMessage(waId, "Thinking...").catch(() => {});
              }
            }, 4000);
            const opts = {
              onStatusEvent(event) {
                if (event.type === "tool_start") {
                  waToolCount++;
                  waLatestDesc = event.description || getActivityDescription(event.toolName, event.input) || "Working on it";
                  // Clear the thinking timer since we have real activity now
                  if (waThinkingTimer) { clearTimeout(waThinkingTimer); waThinkingTimer = null; }
                  // First tool: send status immediately with context
                  if (waToolCount === 1 && !waStatusSent) {
                    waStatusSent = true;
                    sendWhatsAppMessage(waId, waLatestDesc + "...").catch(() => {});
                  }
                  // 3+ tools: send an update so user knows it's a big operation
                  if (waToolCount === 3) {
                    sendWhatsAppMessage(waId, "Still working on it...").catch(() => {});
                  }
                }
              },
            };

            // If replying to image message(s), download and include them
            let replyFileData = null;
            if (replyMediaIds.length > 0) {
              try {
                // Download all images from the burst, combine into one for the LLM
                const downloaded = [];
                for (const mid of replyMediaIds.slice(0, 4)) { // cap at 4 images
                  try {
                    const { buffer, mimeType } = await downloadWhatsAppMedia(mid);
                    downloaded.push({ buffer, mimeType });
                  } catch (e) {
                    console.error(`[WhatsApp] Failed to download reply media ${mid}: ${e.message}`);
                  }
                }
                if (downloaded.length === 1) {
                  const { buffer, mimeType } = downloaded[0];
                  const ext = (mimeType || "").split("/")[1] || "jpg";
                  replyFileData = {
                    base64: buffer.toString("base64"),
                    mediaType: mimeType || "image/jpeg",
                    ext, isImage: true, fileName: `reply_image.${ext}`,
                  };
                } else if (downloaded.length > 1) {
                  // Multiple images: pass as multiImage array for the LLM to see all
                  replyFileData = {
                    isMultiImage: true,
                    images: downloaded.map((d, i) => ({
                      base64: d.buffer.toString("base64"),
                      mediaType: d.mimeType || "image/jpeg",
                    })),
                    ext: "jpg", isImage: true, fileName: `reply_images_${downloaded.length}.jpg`,
                  };
                }
              } catch (e) {
                console.error(`[WhatsApp] Failed to download reply media: ${e.message}`);
              }
            }

            const response = await queuedAsk(userId, userText, replyFileData, waId, opts);
            if (waThinkingTimer) clearTimeout(waThinkingTimer);
            try { reactToMessage(waId, waMessageId, "✅"); } catch (e) {}
            console.log(`[WhatsApp] LLM response for ${waId}: ${response ? `${response.length} chars` : "EMPTY/NULL"}`);
            if (response) {
              const sendResult = await sendWhatsAppMessage(waId, response);
              // Track outgoing message ID for reply context
              const outId = sendResult?.messages?.[0]?.id;
              if (outId) trackOutgoing(waId, userId, outId, response);
              console.log(`[WhatsApp] Message sent to ${waId}`);
            } else {
              console.log(`[WhatsApp] No response to send to ${waId}`);
            }
          } catch (err) {
            console.error(`WhatsApp handler error for ${waId}:`, err);
            sendWhatsAppMessage(waId, "Something went wrong processing that. Try again?").catch(() => {});
          } finally {
            if (storeLoaded) cleanupUserContext();
          }
        });
      }
    } catch (err) {
      console.error("WhatsApp webhook error:", err.message);
    }
  });
}

module.exports = { setup, subscribeWhatsAppWebhook };
