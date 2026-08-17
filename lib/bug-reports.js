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
const SNAPSHOT_TURNS = 16;
const MAX_TURN_CHARS = 1500;
const MAX_SCREENSHOTS = 4;

function isBugReport(text) {
  return typeof text === "string" && BUG_PREFIX.test(text);
}

function stripCommand(text) {
  return (text || "").replace(BUG_PREFIX, "").trim();
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
    return `Logged, thanks.${shotNote} Reference ${ref}. This one gets looked at properly rather than guessed at.`;
  } catch (e) {
    console.error("[bug] Report failed:", e.message);
    return "Couldn't save that report. Try again in a moment?";
  }
}

module.exports = { isBugReport, fileBugReport, stripCommand };
