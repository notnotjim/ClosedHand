// lib/platforms/whatsapp-linked.js — WhatsApp as a linked device (self-host only).
//
// Speaks the multi-device web protocol via Baileys, appearing as another
// device on the USER'S OWN WhatsApp. No Business API, so none of its
// restrictions, and none of its sanction: this violates WhatsApp's terms and
// any ban lands on the user's personal number. The setup card says so before
// the QR is ever shown, and the cloud edition never loads this file.
//
// SAFETY DEFAULT, hard-coded: ClosedHand SPEAKS only in the user's own
// self-chat ("Message Yourself"). Every other conversation is read-only
// ingestion for recall; replying anywhere else would be the assistant talking
// to the user's contacts as the user.
//
// Enable flow: the webapp writes a connections row (service
// "whatsapp_linked"); this module watches for it, starts a socket, and posts
// the pairing QR back onto the row's metadata for the setup page to render.
// Session credentials live under STORAGE_DIR (a compose volume), so pairing
// survives restarts.

const path = require("path");
const fs = require("fs");
const ctx = require("../context");
const { queueUserMessage } = ctx;
const { UserStore, supabase } = require("../../user-store");
const { saveStore, swapToCloudStore, cleanupUserContext } = require("../storage");
const { queuedAsk } = require("../engine");
const { getActivityDescription } = require("../status-feed");
const { archiveThread, switchThread, getThreadList, clearAllThreads, formatRelativeTime } = require("../conversation");
const { handleOnboardingMessage } = require("../onboarding");
const { transcribeAudio } = require("../voice");
const { buildFileData, IMAGE_EXTENSIONS, TEXT_EXTENSIONS, OFFICE_EXTENSIONS } = require("../files");
const { fileBugReport } = require("../bug-reports");
const { isGoogleConnected } = require("../services/google");
const { isShopifyConnected } = require("../services/shopify");
const { isMetaAdsConnected } = require("../services/meta");

const SESSION_DIR = path.join(process.env.STORAGE_DIR || path.resolve(__dirname, "../../storage"), "wa-linked-session");
const WATCH_INTERVAL_MS = 5000;
const HISTORY_CAP = 2000;
const INGEST_TEXT_CAP = 2000;
// Photos sent as an album arrive one message each; hold them briefly so the
// set is one turn, the same as the Business API handler does.
const IMAGE_DEBOUNCE_MS = 3000;
// Something WhatsApp sends alongside an album that is not itself a message we
// can read waits this long before earning a "here is what I can handle".
const UNSUPPORTED_GRACE_MS = 4000;

let _sock = null;
let _ownerUserId = null;
let _selfJid = null;
// WhatsApp also addresses the user's own chat by a "linked id" (…@lid) that
// says nothing about the phone number. A self-chat message can arrive under
// either id, so both count as self; sends always go to the phone-number id.
let _selfLid = null;
let _starting = false;
let _watchTimer = null;
const _sentIds = new Set(); // our own sends, so self-chat echoes are not re-processed
let _historyIngested = 0;
let _imageBatch = null;    // { images: [{buffer, mimeType}], keys: [], caption, timer }
let _lastRealMsgAt = 0;

function bareJid(jid) {
  return String(jid || "").replace(/:\d+(?=@)/, "");
}

function isSelfJid(jid) {
  return !!jid && !!_selfJid && (jid === _selfJid || (!!_selfLid && jid === _selfLid));
}

// The self-chat under one name, whichever id it arrived with, so recall does
// not file the same conversation under two chats.
function selfNorm(jid) {
  return isSelfJid(jid) ? _selfJid : jid;
}

async function updateConnMeta(patch) {
  if (!_ownerUserId) return;
  try {
    const { data } = await supabase.from("connections").select("metadata")
      .eq("user_id", _ownerUserId).eq("service", "whatsapp_linked").single();
    if (!data) return;
    await supabase.from("connections")
      .update({ metadata: { ...(data.metadata || {}), ...patch }, updated_at: new Date().toISOString() })
      .eq("user_id", _ownerUserId).eq("service", "whatsapp_linked");
  } catch (_) { /* metadata is display state; the socket is the truth */ }
}

function extractText(msg) {
  const m = msg.message || {};
  return m.conversation
    || m.extendedTextMessage?.text
    || m.imageMessage?.caption
    || m.videoMessage?.caption
    || m.documentMessage?.caption
    || "";
}

// A WhatsApp "reply" carries the quoted message along with the new text. The
// new text alone is enough when someone replies to the latest message, since
// conversation flow covers it, but a reply to something older ("actually
// cancel this" on yesterday's message) is meaningless without its referent.
// Returns the quoted text, or null when the message is not a reply.
function extractQuoted(msg) {
  const ci = msg.message?.extendedTextMessage?.contextInfo;
  const q = ci?.quotedMessage;
  if (!q) return null;
  const text = q.conversation
    || q.extendedTextMessage?.text
    || q.imageMessage?.caption
    || q.videoMessage?.caption
    || q.documentMessage?.caption
    || "";
  if (!text) return null;
  // Best-effort attribution: if the quoted id is one of our own recent sends
  // it was ClosedHand speaking. The set is pruned and cleared on restart, so
  // absence proves nothing and gets no label.
  const who = ci?.stanzaId && _sentIds.has(ci.stanzaId) ? "ClosedHand" : null;
  return { text: text.substring(0, 300), who };
}

// Every readable message, any chat, is cached raw and keyword-searchable the
// moment it lands. Meaning search is NOT done here and not done per message:
// wa-digest.js writes one summary and one embedding per chat per day, once
// the day is complete. Per-message embedding was removed deliberately; a
// ten-word message has no standalone meaning and each one cost a model call.
// Reading is not speaking; the speak gate below stays self-chat only.
async function ingestMessages(userId, entries, chatNames = {}) {
  const items = [];
  for (const msg of entries) {
    const text = extractText(msg);
    if (!text || !msg.key?.id) continue;
    const jid = selfNorm(bareJid(msg.key.remoteJid));
    if (!jid || jid.endsWith("@status") || jid === "status@broadcast") continue;
    const ts = Number(msg.messageTimestamp || 0) * 1000 || Date.now();
    const sender = msg.key.fromMe ? "me" : (msg.pushName || bareJid(msg.key.participant || jid).split("@")[0]);
    items.push({
      external_id: `wa-${msg.key.id}`,
      id: `wa-${msg.key.id}`,
      chat: jid,
      chat_name: chatNames[jid] || jid.split("@")[0],
      sender,
      text: text.substring(0, INGEST_TEXT_CAP),
      date: new Date(ts).toISOString(),
    });
  }
  if (!items.length) return 0;

  const { upsertCacheItems } = require("../services/data-sync");
  await upsertCacheItems(userId, "whatsapp", "message", items);
  return items.length;
}

// --- The conversation, in the self-chat --------------------------------------
// The same shape as the Business API handler in whatsapp.js, so talking to
// ClosedHand feels the same whichever way WhatsApp is connected: a read
// receipt, a thinking reaction while it works, typing, a note when a tool
// takes a while, a tick on the message it answered, and the same commands.

function chatJid(key) {
  return bareJid(key?.remoteJid) || _selfJid;
}

function react(key, emoji) {
  if (!_sock || !key) return Promise.resolve();
  return _sock.sendMessage(chatJid(key), { react: { text: emoji, key } })
    .then((out) => { if (out?.key?.id) _sentIds.add(out.key.id); })
    .catch(() => {});
}

function markRead(key) {
  if (!_sock || !key) return Promise.resolve();
  return _sock.readMessages([key]).catch(() => {});
}

function presence(state) {
  if (!_sock || !_selfJid) return Promise.resolve();
  return _sock.sendPresenceUpdate(state, _selfJid).catch(() => {});
}

async function downloadMedia(msg) {
  const { downloadMediaMessage } = require("@whiskeysockets/baileys");
  const quiet = { info() {}, debug() {}, warn() {}, error() {}, trace() {} };
  return downloadMediaMessage(msg, "buffer", {}, {
    logger: _sock?.logger || quiet,
    reuploadRequest: _sock?.updateMediaMessage,
  });
}

function extFromMime(mime) {
  const m = String(mime || "").split(";")[0].trim();
  const map = {
    "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
    "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac",
    "application/pdf": "pdf",
  };
  return map[m] || (m.split("/")[1] || "bin");
}

// Runs a turn inside a fresh context bubble on the user's queue; every path
// below that talks to the model goes through here.
function inSelfChatTurn(fn) {
  const userId = _ownerUserId;
  return queueUserMessage(userId, async () => {
    let loaded = false;
    try {
      const userStore = await UserStore.load(userId);
      swapToCloudStore(userStore, userId, _selfJid);
      ctx.activePlatform = "whatsapp_linked";
      try { require("../workspace-cache").maybeRefreshOnSessionStart(userStore, userId); } catch (_) {}
      loaded = true;
      await fn(userId);
    } finally {
      if (loaded) cleanupUserContext();
    }
  });
}

function sayInSelfChat(text) {
  return sendLinkedMessage(_selfJid, text).catch(() => {});
}

async function replyWithVoiceOrText(response, key) {
  const voicePref = ctx.store.facts["_voice_reply_pref"];
  const { synthesize, isTtsAvailable } = require("../services/tts");
  const ttsReady = isTtsAvailable() && response.length < 4000;
  if (voicePref === "on" && ttsReady) {
    try {
      const audio = await synthesize(response);
      await sendLinkedVoice(_selfJid, audio);
      return;
    } catch (e) {
      console.error("[wa-linked] voice reply failed, sending text:", e.message);
    }
  }
  await sayInSelfChat(response);
  if (!voicePref && ttsReady) {
    ctx.store.facts["_voice_reply_pref"] = "asked";
    saveStore();
    await sayInSelfChat("Tip: I can reply to voice messages with voice messages too. Say \"voice replies on\" to try it, or \"voice replies off\" to keep text only.");
  }
}

function bufferImage(buffer, mimeType, caption, key) {
  if (!_imageBatch) _imageBatch = { images: [], keys: [], caption: null, timer: null };
  _imageBatch.images.push({ buffer, mimeType });
  _imageBatch.keys.push(key);
  if (caption) _imageBatch.caption = caption;
  if (_imageBatch.timer) clearTimeout(_imageBatch.timer);
  _imageBatch.timer = setTimeout(() => {
    const batch = _imageBatch;
    _imageBatch = null;
    if (!batch || !batch.images.length) return;
    inSelfChatTurn(async (userId) => {
      try {
        let fileData;
        if (batch.images.length === 1) {
          const img = batch.images[0];
          fileData = await buildFileData(img.buffer, `image.${extFromMime(img.mimeType)}`, img.mimeType);
        } else {
          const ext = extFromMime(batch.images[0].mimeType);
          fileData = {
            isMultiImage: true,
            images: batch.images.map((img) => ({ base64: img.buffer.toString("base64"), mediaType: img.mimeType || "image/jpeg" })),
            ext, isImage: true, fileName: `images_${batch.images.length}.${ext}`,
          };
        }
        const response = await queuedAsk(userId, batch.caption, fileData, _selfJid);
        for (const k of batch.keys) react(k, "✅");
        if (response) await sayInSelfChat(response);
      } catch (e) {
        for (const k of batch.keys) react(k, "");
        console.error("[wa-linked] image batch failed:", e.message);
        await sayInSelfChat("Couldn't process those images. Try again?");
      }
    }).catch(() => {});
  }, IMAGE_DEBOUNCE_MS);
}

async function threadsCommand(userId, text) {
  const pick = text.match(/^\/thread\s+(\d+)$/i);
  let threads;
  try { threads = await getThreadList(userId, 10); } catch (_) { threads = null; }
  if (!threads) { await sayInSelfChat("Couldn't load threads. Try again."); return; }
  if (!threads.length) { await sayInSelfChat("No previous conversations. This is your first thread."); return; }
  if (pick) {
    const t = threads[Number(pick[1]) - 1];
    if (!t) { await sayInSelfChat(`There are ${threads.length} threads. Pick a number from /threads.`); return; }
    try {
      await switchThread(userId, t.id);
      saveStore();
      await sayInSelfChat(`Back in "${(t.title || "Untitled").substring(0, 40)}".`);
    } catch (_) {
      await sayInSelfChat("Couldn't switch to that thread. Try again.");
    }
    return;
  }
  const lines = threads.slice(0, 8).map((t, i) =>
    `${i + 1}. ${t.is_active ? "[active] " : ""}${(t.title || "Untitled").substring(0, 40)} (${t.message_count || 0} messages, ${formatRelativeTime(t.updated_at)})`);
  await sayInSelfChat(`Your threads:\n${lines.join("\n")}\n\nSend /thread and a number to go back to one.`);
}

async function openConversationIfNew() {
  await inSelfChatTurn(async (userId) => {
    if (ctx.store.facts["_onboarded"]) return;
    const settings = ctx.activeUserStore?.profile?.settings || {};
    if (settings.onboarding_step) return;
    await handleOnboardingMessage(userId, _selfJid, null);
  });
}

async function handleSelfChat(msg, text, media) {
  const key = msg.key;
  markRead(key);
  await inSelfChatTurn(async (userId) => {
    if (text && /^voice\s+replies?\s+(on|off)$/i.test(text)) {
      const pref = /on$/i.test(text) ? "on" : "off";
      ctx.store.facts["_voice_reply_pref"] = pref;
      saveStore();
      await sayInSelfChat(pref === "on" ? "Voice replies turned on. I'll respond to your voice messages with voice notes." : "Voice replies turned off. I'll respond with text.");
      return;
    }

    if (media === "image") {
      react(key, "🤔");
      try {
        const m = msg.message.imageMessage;
        const buffer = await downloadMedia(msg);
        bufferImage(buffer, m.mimetype || "image/jpeg", m.caption || null, key);
      } catch (e) {
        react(key, "");
        console.error("[wa-linked] image download failed:", e.message);
        await sayInSelfChat("Couldn't download that image. Try again?");
      }
      return;
    }

    if (media === "audio") {
      react(key, "🤔");
      try {
        const m = msg.message.audioMessage;
        const buffer = await downloadMedia(msg);
        const ext = extFromMime(m.mimetype);
        const transcript = await transcribeAudio(buffer, `voice.${ext}`);
        console.log(`[wa-linked] voice note transcribed: "${transcript.substring(0, 60)}"`);
        await presence("composing");
        const response = await queuedAsk(userId, transcript, null, _selfJid);
        await presence("paused");
        react(key, "✅");
        if (response) await replyWithVoiceOrText(response, key);
      } catch (e) {
        react(key, "");
        await presence("paused");
        console.error("[wa-linked] voice note failed:", e.message);
        await sayInSelfChat(`Couldn't transcribe that voice message: ${e.message}`);
      }
      return;
    }

    if (media === "document") {
      react(key, "🤔");
      try {
        const m = msg.message.documentMessage;
        const buffer = await downloadMedia(msg);
        const filename = m.fileName || `document.${extFromMime(m.mimetype)}`;
        const fileData = await buildFileData(buffer, filename, m.mimetype);
        const supported = [...IMAGE_EXTENSIONS, ...TEXT_EXTENSIONS, ...OFFICE_EXTENSIONS, "pdf"];
        if (!supported.includes(fileData.ext)) {
          react(key, "");
          await sayInSelfChat(`I can't read .${fileData.ext} files yet. Supported: images, PDFs, text files, and Office docs (docx, xlsx, pptx).`);
          return;
        }
        if (fileData.isImage) {
          bufferImage(buffer, fileData.mediaType, m.caption || null, key);
          return;
        }
        await presence("composing");
        const response = await queuedAsk(userId, m.caption || null, fileData, _selfJid);
        await presence("paused");
        react(key, "✅");
        if (response) await sayInSelfChat(response);
      } catch (e) {
        react(key, "");
        await presence("paused");
        console.error("[wa-linked] document failed:", e.message);
        await sayInSelfChat("Couldn't process that document. Try again?");
      }
      return;
    }

    if (text === "/start" || text.toLowerCase() === "start") {
      const services = [];
      if (isGoogleConnected()) services.push("Gmail, Calendar, Drive");
      if (isShopifyConnected()) services.push("Shopify");
      if (isMetaAdsConnected()) services.push("Meta Ads");
      await sayInSelfChat(`Connected: ${services.length ? services.join(", ") : "None yet"}\nManage settings from your dashboard`);
      return;
    }
    if (text === "/new") {
      try {
        await archiveThread(userId);
        saveStore();
        await sayInSelfChat("Fresh start. Your previous conversation is saved. Use /threads to go back to it anytime.");
      } catch (_) {
        ctx.store.conversations[userId] = [];
        saveStore();
        await sayInSelfChat("Started a new conversation.");
      }
      return;
    }
    if (text === "/threads" || /^\/thread\s+\d+$/i.test(text)) {
      await threadsCommand(userId, text);
      return;
    }
    if (text === "/clear") {
      try { await clearAllThreads(userId); } catch (_) {}
      ctx.store.conversations[userId] = [];
      saveStore();
      await sayInSelfChat("Conversation cleared.");
      return;
    }

    if (!ctx.store.facts["_onboarded"]) {
      const ps = ctx.activeUserStore?.profile?.settings || {};
      if (ps.onboarding_step === "done") {
        ctx.store.facts["_onboarded"] = new Date().toISOString();
      } else {
        await handleOnboardingMessage(userId, _selfJid, text);
        return;
      }
    }

    react(key, "🤔");
    presence("composing");
    // A reply gets its quoted referent prefixed, so "cancel this" is read
    // against the message it was attached to, not whatever was said last.
    const quoted = extractQuoted(msg);
    const engineText = quoted
      ? `[replying to ${quoted.who ? quoted.who + "'s message" : "an earlier message"}: "${quoted.text}"]\n${text}`
      : text;

    // Progress notes, so a long turn never looks abandoned: "Thinking..."
    // if nothing has happened after four seconds, the first tool's
    // description when it starts, and one more note on the third tool.
    let toolCount = 0;
    let statusSent = false;
    let thinkingTimer = setTimeout(() => {
      if (!statusSent) { statusSent = true; sayInSelfChat("Thinking..."); }
    }, 4000);
    const opts = {
      onStatusEvent(event) {
        if (event.type !== "tool_start") return;
        toolCount++;
        const desc = event.description || getActivityDescription(event.toolName, event.input) || "Working on it";
        if (thinkingTimer) { clearTimeout(thinkingTimer); thinkingTimer = null; }
        if (toolCount === 1 && !statusSent) { statusSent = true; sayInSelfChat(desc + "..."); }
        if (toolCount === 3) sayInSelfChat("Still working on it...");
      },
    };

    try {
      const response = await queuedAsk(userId, engineText, null, _selfJid, opts);
      if (thinkingTimer) clearTimeout(thinkingTimer);
      await presence("paused");
      react(key, "✅");
      if (response) await sayInSelfChat(response);
    } catch (err) {
      if (thinkingTimer) clearTimeout(thinkingTimer);
      await presence("paused");
      react(key, "");
      console.error("[wa-linked] handler error:", err.message);
      await sayInSelfChat("Something went wrong processing that. Try again?");
    }
  });
}

async function startSocket(ownerUserId) {
  if (_sock || _starting) return;
  _starting = true;
  _ownerUserId = ownerUserId;
  try {
    const baileys = require("@whiskeysockets/baileys");
    const makeWASocket = baileys.default || baileys.makeWASocket;
    const { useMultiFileAuthState, DisconnectReason } = baileys;

    fs.mkdirSync(SESSION_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      browser: ["ClosedHand", "Desktop", "1.0"],
    });
    _sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (u) => {
      if (u.qr) {
        console.log("[wa-linked] pairing QR refreshed");
        await updateConnMeta({ qr: u.qr, qr_at: new Date().toISOString(), linked: false });
      }
      if (u.connection === "open") {
        _selfJid = bareJid(sock.user?.id);
        _selfLid = bareJid(sock.user?.lid) || null;
        console.log(`[wa-linked] linked as ${_selfJid}${_selfLid ? ` (${_selfLid})` : ""}`);
        await updateConnMeta({ linked: true, jid: _selfJid, qr: null });
        // The self-chat is where schedules and agent digests deliver.
        try {
          await supabase.from("chat_links").upsert(
            { user_id: _ownerUserId, platform: "whatsapp_linked", platform_user_id: _selfJid },
            { onConflict: "platform,platform_user_id" }
          );
        } catch (_) {}
        // A fresh install: ClosedHand speaks first, so the chat is not an
        // empty screen waiting for the user to guess what to type.
        openConversationIfNew().catch(() => {});
      }
      if (u.connection === "close") {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        _sock = null;
        if (code === DisconnectReason.loggedOut) {
          console.log("[wa-linked] logged out from the phone; clearing session");
          try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch (_) {}
          await updateConnMeta({ linked: false, qr: null, jid: null });
        } else {
          console.log(`[wa-linked] connection closed (${code || "unknown"}); will retry`);
        }
      }
    });

    // Pairing-time history: a bounded snapshot into recall, never the firehose.
    sock.ev.on("messaging-history.set", async ({ chats, messages }) => {
      try {
        if (_historyIngested >= HISTORY_CAP) return;
        const names = {};
        for (const c of chats || []) names[bareJid(c.id)] = c.name || c.subject || "";
        const batch = (messages || []).slice(0, HISTORY_CAP - _historyIngested);
        const n = await ingestMessages(_ownerUserId, batch, names);
        _historyIngested += n;
        if (n) console.log(`[wa-linked] history: ingested ${n} messages (${_historyIngested} total)`);
      } catch (e) {
        console.log(`[wa-linked] history ingest failed: ${e.message}`);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      for (const msg of messages || []) {
        try {
          const jid = bareJid(msg.key?.remoteJid);
          if (!jid || !msg.key?.id) continue;
          if (_sentIds.has(msg.key.id)) continue; // our own sends echoing back
          const m = msg.message || {};

          // A reaction is deliberate, so it never earns a capability list.
          // Thumbs down on a reply is the shortest bug report there is.
          if (m.reactionMessage) {
            const emoji = m.reactionMessage.text || "";
            if (isSelfJid(jid) && emoji.startsWith("\u{1F44E}")) {
              const reply = await fileBugReport({
                userId: _ownerUserId, text: "/bug thumbs down on a reply", fileData: null,
                platform: "whatsapp_linked", chatId: _selfJid,
              });
              await sayInSelfChat(reply);
            }
            continue;
          }

          const text = extractText(msg);
          const media = m.imageMessage ? "image" : m.audioMessage ? "audio" : m.documentMessage ? "document" : null;

          // Read everything for recall; speak only in the self-chat.
          if (text) await ingestMessages(_ownerUserId, [msg]).catch(() => {});
          if (!isSelfJid(jid) || type !== "notify") continue;

          if (!text && !media) {
            // Held briefly: an album brings one of these along, and the
            // photos have already been answered on their own terms.
            const seenAt = Date.now();
            setTimeout(() => {
              if (Math.abs(_lastRealMsgAt - seenAt) <= UNSUPPORTED_GRACE_MS) return;
              sayInSelfChat("I can handle text, images, voice messages, and documents.");
            }, UNSUPPORTED_GRACE_MS);
            continue;
          }
          _lastRealMsgAt = Date.now();
          console.log(`[wa-linked] self-chat ${media || "message"}: "${(text || "").substring(0, 60)}"`);
          // Not awaited: a long turn must not hold up reading other chats.
          handleSelfChat(msg, (text || "").trim(), media).catch((e) => console.log(`[wa-linked] turn failed: ${e.message}`));
        } catch (e) {
          console.log(`[wa-linked] upsert handling failed: ${e.message}`);
        }
      }
    });
  } catch (e) {
    console.error(`[wa-linked] start failed: ${e.message}`);
    _sock = null;
  } finally {
    _starting = false;
  }
}

async function stopSocket() {
  const s = _sock;
  _sock = null;
  if (s) { try { await s.logout(); } catch (_) { try { s.end(); } catch (_) {} } }
}

// The speak gate, enforced at the only place a send can happen. Callers all
// pass the self-chat today, but a gate that lives in callers is a convention,
// and one future tool call handing this a contact's id would have the socket
// messaging that contact AS the user. Anything that is not the self-chat is
// refused loudly, never redirected silently.
function _gateSelfChat(chatId) {
  const jid = bareJid(chatId) || _selfJid;
  if (!isSelfJid(jid)) {
    throw new Error(`linked WhatsApp speaks only in the self-chat (asked for ${jid || "unknown"})`);
  }
  return _selfJid;
}

function remember(out) {
  if (out?.key?.id) {
    _sentIds.add(out.key.id);
    if (_sentIds.size > 300) { for (const id of Array.from(_sentIds).slice(0, 100)) _sentIds.delete(id); }
  }
  return out?.key?.id || null;
}

async function sendLinkedMessage(chatId, message) {
  if (!_sock) throw new Error("WhatsApp (linked) is not connected");
  const jid = _gateSelfChat(chatId);
  const text = String(message);
  const chunks = text.length > 4000 ? text.match(/.{1,4000}/gs) : [text];
  let last = null;
  for (const chunk of chunks) last = remember(await _sock.sendMessage(jid, { text: chunk }));
  return last;
}

async function sendLinkedVoice(chatId, audioBuffer) {
  if (!_sock) throw new Error("WhatsApp (linked) is not connected");
  const jid = _gateSelfChat(chatId);
  return remember(await _sock.sendMessage(jid, { audio: audioBuffer, ptt: true, mimetype: "audio/ogg; codecs=opus" }));
}

async function sendLinkedLocation(chatId, lat, lng, name, address) {
  if (!_sock) throw new Error("WhatsApp (linked) is not connected");
  const jid = _gateSelfChat(chatId);
  return remember(await _sock.sendMessage(jid, { location: { degreesLatitude: lat, degreesLongitude: lng, name: name || undefined, address: address || undefined } }));
}

async function sendLinkedDocument(chatId, buffer, filename, mimeType) {
  if (!_sock) throw new Error("WhatsApp (linked) is not connected");
  const jid = _gateSelfChat(chatId);
  return remember(await _sock.sendMessage(jid, { document: buffer, fileName: filename, mimetype: mimeType || "application/octet-stream" }));
}

// Watch for the connection row the webapp writes; start or stop to match.
function setup() {
  if (_watchTimer) return;
  const ensure = async () => {
    try {
      const { data } = await supabase.from("connections")
        .select("user_id, config").eq("service", "whatsapp_linked").limit(1);
      const row = data?.[0];
      if (row && row.config?.enabled && !_sock && !_starting) {
        await startSocket(row.user_id);
      } else if ((!row || !row.config?.enabled) && _sock) {
        console.log("[wa-linked] disabled; stopping");
        await stopSocket();
      }
    } catch (_) { /* next tick retries */ }
  };
  _watchTimer = setInterval(ensure, WATCH_INTERVAL_MS);
  ensure();
}

module.exports = { setup, sendLinkedMessage, sendLinkedDocument, sendLinkedVoice, sendLinkedLocation };
