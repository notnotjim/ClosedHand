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
const { swapToCloudStore, cleanupUserContext } = require("../storage");
const { queuedAsk } = require("../engine");

const SESSION_DIR = path.join(process.env.STORAGE_DIR || path.resolve(__dirname, "../../storage"), "wa-linked-session");
const WATCH_INTERVAL_MS = 20000;
const HISTORY_CAP = 2000;
const INGEST_TEXT_CAP = 2000;

let _sock = null;
let _ownerUserId = null;
let _selfJid = null;
let _starting = false;
let _watchTimer = null;
const _sentIds = new Set(); // our own sends, so self-chat echoes are not re-processed
let _historyIngested = 0;

function bareJid(jid) {
  return String(jid || "").replace(/:\d+(?=@)/, "");
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
    const jid = bareJid(msg.key.remoteJid);
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

async function handleSelfChatMessage(text) {
  const userId = _ownerUserId;
  const selfJid = _selfJid;
  queueUserMessage(userId, async () => {
    const userStore = await UserStore.load(userId);
    swapToCloudStore(userStore, userId, selfJid);
    ctx.activePlatform = "whatsapp_linked";
    try {
      const response = await queuedAsk(userId, text, null, selfJid, {});
      if (response) await sendLinkedMessage(selfJid, response);
    } finally {
      cleanupUserContext();
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
        console.log(`[wa-linked] linked as ${_selfJid}`);
        await updateConnMeta({ linked: true, jid: _selfJid, qr: null });
        // The self-chat is where schedules and agent digests deliver.
        try {
          await supabase.from("chat_links").upsert(
            { user_id: _ownerUserId, platform: "whatsapp_linked", platform_user_id: _selfJid },
            { onConflict: "platform,platform_user_id" }
          );
        } catch (_) {}
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
          const text = extractText(msg);
          if (!jid || !text) continue;
          if (_sentIds.has(msg.key.id)) continue; // our own reply echoing back

          // Read everything for recall; speak only in the self-chat.
          await ingestMessages(_ownerUserId, [msg]).catch(() => {});
          const isSelfChat = _selfJid && jid === _selfJid;
          if (isSelfChat && type === "notify") {
            console.log(`[wa-linked] self-chat message: "${text.substring(0, 60)}"`);
            await handleSelfChatMessage(text);
          }
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
  if (!_selfJid || jid !== _selfJid) {
    throw new Error(`linked WhatsApp speaks only in the self-chat (asked for ${jid || "unknown"})`);
  }
  return jid;
}

async function sendLinkedMessage(chatId, message) {
  if (!_sock) throw new Error("WhatsApp (linked) is not connected");
  const jid = _gateSelfChat(chatId);
  const out = await _sock.sendMessage(jid, { text: String(message) });
  if (out?.key?.id) {
    _sentIds.add(out.key.id);
    if (_sentIds.size > 300) { for (const id of Array.from(_sentIds).slice(0, 100)) _sentIds.delete(id); }
  }
  return out?.key?.id || null;
}

async function sendLinkedDocument(chatId, buffer, filename, mimeType) {
  if (!_sock) throw new Error("WhatsApp (linked) is not connected");
  const jid = _gateSelfChat(chatId);
  const out = await _sock.sendMessage(jid, { document: buffer, fileName: filename, mimetype: mimeType || "application/octet-stream" });
  if (out?.key?.id) _sentIds.add(out.key.id);
  return out?.key?.id || null;
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

module.exports = { setup, sendLinkedMessage, sendLinkedDocument };
