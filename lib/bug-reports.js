// lib/bug-reports.js — /bug, a zero-friction flag for anything that looked wrong.
//
// Most real bugs are noticed in normal use and then lost: by the time anyone
// looks, the chat has moved on and nobody can say what the screen showed. This
// captures the moment where it happened. Reports are worked through from
// scripts/bug-queue.js, which is what the session-start hook lists.
//
// Reports contain verbatim conversation content and screenshots. They are
// written with the service key into a table with RLS on and no policies, so no
// user-facing surface can read them back.

const ctx = require("./context");
const { supabase, UserStore } = require("../user-store");

const BUG_PREFIX = /^\s*\/bug\b[:,\s]*/i;
// A platform prefixes a reply with the message it answers ("[replying to
// ...]\n/bug ..."), which is exactly how people flag a bad answer. The command
// is read past that prefix, and the quoted message rides along in the comment.
const REPLY_PREFIX = /^\s*\[replying to ([^\]]*)\]\s*/i;
// Five turns: enough to see what went wrong, small enough that people are
// willing to send it on. The comment carries the rest.
const SNAPSHOT_TURNS = 5;
// Where a self-host report goes when the person says yes to sending it. The
// hosted tier writes straight into the same table this posts to.
const INTAKE_URL = process.env.BUG_INTAKE_URL || "https://closedhand.com/api/bug-intake";
const SEND_OFFER_MS = 15 * 60 * 1000;
const MAX_TURN_CHARS = 1500;
const MAX_SCREENSHOTS = 4;

function isBugReport(text) {
  return typeof text === "string" && BUG_PREFIX.test(text.replace(REPLY_PREFIX, ""));
}

function stripCommand(text) {
  const m = String(text || "").match(REPLY_PREFIX);
  const body = String(text || "").replace(REPLY_PREFIX, "").replace(BUG_PREFIX, "").trim();
  return m ? `${body} (in reply to: ${m[1].trim()})`.trim() : body;
}

// Self-host runs against the person's own database, where a report is seen by
// nobody unless they send it on. Hosted reports already land in the queue.
function isSelfHost() {
  return process.env.DB_DRIVER === "pg" || (!!process.env.DATABASE_URL && !process.env.SUPABASE_URL);
}
function appVersion() {
  let v = "";
  try { v = require("../package.json").version || ""; } catch (_) {}
  const sha = (process.env.CLOSEDHAND_SHA || "").slice(0, 7);
  return sha ? `${v}+${sha}` : v;
}
// One opaque id per install, so reports from the same machine group together
// without saying anything about who it is.
function installId() {
  const seed = ctx.activeUserStore?.profile?.created_at || "";
  if (!seed) return null;
  return require("crypto").createHash("sha256").update(String(seed)).digest("hex").slice(0, 12);
}

// Conversation entries are a mix of plain strings and Anthropic-shaped block
// arrays (tool_use, tool_result, images). Flatten to something readable and
// drop base64: the screenshot is stored once, and a transcript full of image
// data is unreadable and enormous.
function flattenContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");

  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    switch (block.type) {
      case "text":
        parts.push(block.text || "");
        break;
      case "image":
        parts.push("[image]");
        break;
      case "document":
        parts.push(`[document: ${block.source?.filename || "file"}]`);
        break;
      case "tool_use":
        parts.push(`[called ${block.name} ${JSON.stringify(block.input || {}).substring(0, 300)}]`);
        break;
      case "tool_result": {
        const inner = typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map(b => (b.type === "text" ? b.text : `[${b.type}]`)).join(" ")
            : JSON.stringify(block.content ?? "");
        parts.push(`[result${block.is_error ? " (error)" : ""}: ${String(inner).substring(0, 400)}]`);
        break;
      }
      default:
        parts.push(`[${block.type}]`);
    }
  }
  return parts.filter(Boolean).join("\n");
}

async function snapshotTurns(userId) {
  // In-memory first: it holds the turn that just went wrong, which may not have
  // been saved yet. Falling back to the store covers being called from a timer
  // (WhatsApp batches images that way) where the context bubble has moved on.
  let turns = [];
  try {
    turns = ctx.store?.conversations?.[userId] || [];
  } catch (_) {
    turns = [];
  }
  if (turns.length === 0) {
    try {
      const store = await UserStore.load(userId);
      turns = store.conversations || [];
    } catch (e) {
      console.error("[bug] Could not load conversation:", e.message);
    }
  }

  return turns.slice(-SNAPSHOT_TURNS).map(m => ({
    role: m.role,
    content: flattenContent(m.content).substring(0, MAX_TURN_CHARS),
  }));
}

function imagesFrom(fileData) {
  if (!fileData) return [];
  if (fileData.isMultiImage && Array.isArray(fileData.images)) {
    return fileData.images
      .map(img => ({
        buffer: img.buffer || (img.base64 ? Buffer.from(img.base64, "base64") : null),
        mediaType: img.mediaType || "image/jpeg",
      }))
      .filter(i => i.buffer);
  }
  const buffer = fileData.buffer || (fileData.base64 ? Buffer.from(fileData.base64, "base64") : null);
  if (!buffer) return [];
  return [{ buffer, mediaType: fileData.mediaType || "application/octet-stream" }];
}

function extFor(mediaType) {
  const map = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };
  return map[mediaType] || "bin";
}

/**
 * File a report and return the line to send back to the user.
 * Never throws: a failure here must not also swallow the user's message.
 */
async function fileBugReport({ userId, text, fileData, platform, chatId }) {
  try {
    const comment = stripCommand(text);
    const transcript = await snapshotTurns(userId);

    const { data: row, error } = await supabase
      .from("bug_reports")
      .insert({
        user_id: userId,
        platform: platform || null,
        chat_id: chatId ? String(chatId) : null,
        comment: comment || null,
        transcript,
      })
      .select("id")
      .single();

    if (error) {
      console.error("[bug] Insert failed:", error.message);
      return "Something went wrong saving that report. It has been logged on the server instead.";
    }

    // Screenshots go up after the row exists so they can be named by report id.
    const images = imagesFrom(fileData).slice(0, MAX_SCREENSHOTS);
    if (images.length > 0) {
      const stored = [];
      for (let i = 0; i < images.length; i++) {
        const path = `${userId}/bug/${row.id}_${i}.${extFor(images[i].mediaType)}`;
        const { error: upErr } = await supabase.storage
          .from("attachments")
          .upload(path, images[i].buffer, { contentType: images[i].mediaType, upsert: true });
        if (upErr) console.error("[bug] Screenshot upload failed:", upErr.message);
        else stored.push({ path, mediaType: images[i].mediaType });
      }
      if (stored.length > 0) {
        await supabase.from("bug_reports").update({ screenshots: stored }).eq("id", row.id);
      }
    }

    console.log(`[bug] ${row.id} from ${userId} on ${platform}: "${comment.substring(0, 80)}" (${transcript.length} turns, ${images.length} screenshots)`);

    const ref = String(row.id).substring(0, 8);
    const shotNote = images.length > 0 ? ` Screenshot saved with it.` : "";
    if (isSelfHost()) {
      // The report is on their machine and nobody else can see it. Offer the
      // last hop, say exactly what it carries, and wait for a yes.
      await saveSetting(userId, "bug_send_pending", { id: row.id, at: Date.now() });
      const carries = images.length > 0 ? `your last ${SNAPSHOT_TURNS} messages and the screenshot` : `your last ${SNAPSHOT_TURNS} messages`;
      return `Logged, thanks.${shotNote} Reference ${ref}.\n\nWant me to send it to the ClosedHand team so it gets fixed? It includes ${carries}, nothing else. Reply yes to send, or no to keep it here.`;
    }
    return `Logged, thanks.${shotNote} Reference ${ref}. This one gets looked at properly rather than guessed at.`;
  } catch (e) {
    console.error("[bug] Report failed:", e.message);
    return "Couldn't save that report. Try again in a moment?";
  }
}

async function saveSetting(userId, key, value) {
  const store = ctx.activeUserStore;
  if (!store || !store.profile) return;
  const settings = { ...(store.profile.settings || {}) };
  if (value === null || value === undefined) delete settings[key]; else settings[key] = value;
  store.profile.settings = settings;
  const { error } = await supabase.from("profiles").update({ settings }).eq("id", userId);
  if (error) console.error("[bug] settings write failed:", error.message);
}

// The yes or no after a self-host report. Only a bare answer within a few
// minutes of the offer counts; anything else means they moved on, and the
// offer is dropped so a later "yes" to something else is never read as this.
// Synchronous decision (the caller is not async): returns null to let the
// message through, or a promise of the reply to send instead.
function handleBugSendReply(userId, text) {
  if (!isSelfHost()) return null;
  const pending = ctx.activeUserStore?.profile?.settings?.bug_send_pending;
  if (!pending || !pending.id) return null;
  const t = String(text || "").trim().toLowerCase();
  const yes = /^(yes|y|yep|yeah|yup|sure|ok|okay|send|send it|go ahead|please do)[.! ]*$/.test(t);
  const no = /^(no|n|nope|nah|keep it|don'?t|keep it here|not now)[.! ]*$/.test(t);
  const fresh = Date.now() - (pending.at || 0) < SEND_OFFER_MS;
  const clear = saveSetting(userId, "bug_send_pending", null).catch(() => {});
  if (!fresh || (!yes && !no)) return null;
  if (no) return clear.then(() => "Kept here only. You can read or delete it in your dashboard.");
  return clear.then(() => sendReport(userId, pending.id));
}

async function sendReport(userId, reportId) {
  try {
    const { data: r, error } = await supabase.from("bug_reports").select("*").eq("id", reportId).single();
    if (error || !r) return "Couldn't find that report any more, so nothing was sent.";
    const screenshots = [];
    for (const s of (r.screenshots || []).slice(0, MAX_SCREENSHOTS)) {
      try {
        const { data: blob } = await supabase.storage.from("attachments").download(s.path);
        if (!blob) continue;
        const buf = Buffer.from(await blob.arrayBuffer());
        screenshots.push({ mediaType: s.mediaType, base64: buf.toString("base64") });
      } catch (e) { console.error("[bug] screenshot read failed:", e.message); }
    }
    const body = {
      install_id: installId(),
      app_version: appVersion(),
      platform: r.platform,
      comment: r.comment,
      transcript: (r.transcript || []).slice(-SNAPSHOT_TURNS),
      screenshots,
      created_at: r.created_at,
    };
    const res = await fetch(INTAKE_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`intake replied ${res.status}`);
    const { error: markErr } = await supabase.from("bug_reports").update({ sent_at: new Date().toISOString() }).eq("id", reportId);
    if (markErr) console.error("[bug] sent_at write failed:", markErr.message);
    console.log(`[bug] ${reportId} sent to ${INTAKE_URL}`);
    return "Sent. Thank you. It lands in the queue that gets worked through, and the copy here stays yours.";
  } catch (e) {
    console.error("[bug] send failed:", e.message);
    return "Couldn't reach the ClosedHand team just now. The report is still saved here; send /bug again later and say yes.";
  }
}

module.exports = { isBugReport, fileBugReport, stripCommand, handleBugSendReply, sendReport, isSelfHost };
