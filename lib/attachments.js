// lib/attachments.js: saving, loading, listing and clearing attachments

const fs = require("fs");
const path = require("path");
const ctx = require("./context");
const { saveStore } = require("./storage");

const BOT_DIR = path.resolve(__dirname, "..");
const ATTACHMENTS_DIR = path.join(BOT_DIR, "attachments");
const ATTACHMENT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

// Ensure attachments directory exists
if (!fs.existsSync(ATTACHMENTS_DIR)) {
  fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
}

function getUserAttachments(userId) {
  if (!ctx.store.attachments[userId]) {
    ctx.store.attachments[userId] = [];
  }
  return ctx.store.attachments[userId];
}

function cleanupOldAttachments() {
  const now = Date.now();
  let cleaned = 0;

  for (const userId of Object.keys(ctx.store.attachments || {})) {
    const attachments = ctx.store.attachments[userId];
    if (!attachments) continue;

    for (let i = attachments.length - 1; i >= 0; i--) {
      const att = attachments[i];
      const lastUsed = att.lastAccessed || parseInt(att.id.replace("att_", ""), 10);
      if (now - lastUsed > ATTACHMENT_MAX_AGE_MS) {
        // Delete file from disk
        try {
          if (fs.existsSync(att.filePath)) fs.unlinkSync(att.filePath);
        } catch (e) {}
        attachments.splice(i, 1);
        cleaned++;
      }
    }
  }

  if (cleaned > 0) {
    saveStore();
    console.log(`Auto-cleaned ${cleaned} attachments not accessed in 90+ days.`);
  }
}

// Saving several images from one message happens inside a single millisecond,
// so the timestamp alone is not a unique id: without the counter the files
// overwrite each other on disk and the store holds duplicate ids.
let _attachmentCounter = 0;

function saveAttachment(userId, fileData, description) {
  const id = `att_${Date.now()}_${(_attachmentCounter = (_attachmentCounter + 1) % 1000)}`;
  const filePath = path.join(ATTACHMENTS_DIR, `${id}.${fileData.ext}`);

  fs.writeFileSync(filePath, fileData.buffer);

  const attachments = getUserAttachments(userId);
  attachments.push({
    id: id,
    filePath: filePath,
    fileName: fileData.fileName,
    mediaType: fileData.mediaType,
    ext: fileData.ext,
    isImage: fileData.isImage,
    isText: fileData.isText,
    isPdf: fileData.isPdf,
    description: description || "an uploaded file",
    lastAccessed: Date.now(),
  });

  saveStore();

  // The container has no persistent disk, so the file above lives only until
  // the next deploy. Copy it to storage and record it, so it is still there
  // tomorrow and so the user can find it again. Fire and forget: the caller
  // is mid conversation and must not wait on an upload, and a failed copy
  // should not lose them the turn.
  (async () => {
    try {
      const { uploadFile, UserStore } = require("../user-store");
      const storagePath = await uploadFile(userId, id, fileData.buffer, fileData.mediaType);
      const store = await UserStore.load(userId);
      await store.saveAttachment({
        id,
        fileName: fileData.fileName,
        description: description || "an uploaded file",
        mediaType: fileData.mediaType,
        storagePath,
        sizeBytes: fileData.buffer ? fileData.buffer.length : 0,
        direction: fileData.direction || "in",
      });
    } catch (e) {
      console.error(`[attachments] Could not persist ${id}: ${e.message}`);
    }
  })();

  return id;
}

async function loadAttachment(attachmentId) {
  for (const userId of Object.keys(ctx.store.attachments)) {
    const att = ctx.store.attachments[userId].find((a) => a.id === attachmentId);
    if (att) {
      // Update last accessed time
      att.lastAccessed = Date.now();
      saveStore();
      try {
        // After a deploy the local copy is gone, because the container has no
        // persistent disk. Fall back to the copy in storage rather than
        // telling the user a file they sent this morning no longer exists.
        let buffer;
        if (fs.existsSync(att.filePath)) {
          buffer = fs.readFileSync(att.filePath);
        } else {
          const { downloadFile } = require("../user-store");
          buffer = await downloadFile(att.storagePath || `${userId}/${att.id}`);
          if (!buffer) throw new Error("attachment no longer available");
          try { fs.writeFileSync(att.filePath, buffer); } catch (_) { /* cache only */ }
        }

        if (att.isImage) {
          return {
            _type: "image",
            base64: buffer.toString("base64"),
            mediaType: att.mediaType,
            description: att.description,
          };
        }
        // Everything else is read whole by the one reader (lib/file-reader.js);
        // view_attachment hands it over a part at a time when it is long.
        const read = await require("./file-reader").readFile(buffer, att.fileName || `file.${att.ext}`);
        if (read.kind === "audio" || read.kind === "video") {
          // What's said in it, heard again on this computer, with its times.
          const heard = await require("./video").hearMedia({ userId, buffer, name: att.fileName, video: read.kind === "video" })
            .catch((e) => ({ error: e }));
          const said = heard.error ? `[${heard.error.userFacing ? heard.error.message : "Closedhand couldn't hear this file just now."}]`
            : require("./hear-route").saidText(heard.said) || "[Nothing is said in it.]";
          return { _type: "text", textContent: `What's said, each line with its time:\n${said}`, fileName: att.fileName, description: att.description };
        }
        return { _type: "text", textContent: read.text || `[${read.note || "There is no text in this file."}]`, fileName: att.fileName, description: att.description };
      } catch (e) {
        return {
          error: `This attachment was deleted from local storage. I can only see the original description: "${att.description}". Ask the user to re-upload the file if you need to see the full content.`,
        };
      }
    }
  }
  return { error: `Attachment ${attachmentId} not found.` };
}

// Raw bytes for an attachment, for attaching to an outgoing email. Unlike
// loadAttachment this does NOT extract/transform: it returns the original file
// so it can be re-sent as-is. Disk first, storage fallback (agents have no
// local copy), matching send_file.
async function loadAttachmentRaw(attachmentId) {
  for (const userId of Object.keys(ctx.store.attachments || {})) {
    const att = (ctx.store.attachments[userId] || []).find((a) => a.id === attachmentId);
    if (!att) continue;
    let buffer;
    if (att.filePath && fs.existsSync(att.filePath)) {
      buffer = fs.readFileSync(att.filePath);
    } else {
      const { downloadFile } = require("../user-store");
      buffer = await downloadFile(att.storagePath || `${userId}/${att.id}`);
    }
    if (!buffer) return null;
    return { buffer, fileName: att.fileName || attachmentId, mimeType: att.mediaType || "application/octet-stream" };
  }
  return null;
}

function listAttachments(userId) {
  const attachments = getUserAttachments(userId);
  if (attachments.length === 0) return "No attachments saved.";
  return attachments
    .map((a) => `${a.id}: ${a.description}`)
    .join("\n");
}

module.exports = {
  ATTACHMENTS_DIR,
  ATTACHMENT_MAX_AGE_MS,
  getUserAttachments,
  cleanupOldAttachments,
  saveAttachment,
  loadAttachment,
  loadAttachmentRaw,
  listAttachments,
};
