// lib/attachments.js — File attachment save/load/list/cleanup

const fs = require("fs");
const path = require("path");
const mammoth = require("mammoth");
const XLSX = require("xlsx");
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
        } else if (att.isPdf) {
          // Extract the text so any model can read the PDF. The chat/agent model
          // is text-only and cannot consume a PDF block, and handing one back is
          // what pushed agents to read PDFs on the cloud computer. Fall back to
          // the raw block only if extraction fails (e.g. a scanned image PDF).
          let pdfText = null;
          try { pdfText = await require("./services/usi").extractAttachmentText(buffer, att.fileName || "document.pdf"); } catch (_) { /* fall back to block */ }
          if (pdfText && pdfText.trim()) {
            return { _type: "text", textContent: pdfText, fileName: att.fileName, description: att.description };
          }
          return {
            _type: "pdf",
            base64: buffer.toString("base64"),
            mediaType: att.mediaType,
            description: att.description,
          };
        } else if (att.isText) {
          // For office docs, re-extract the text from the binary file
          let textContent = null;
          const ext = att.ext || att.filePath.split(".").pop().toLowerCase();

          if (ext === "docx") {
            try {
              const result = await mammoth.extractRawText({ buffer: buffer });
              textContent = result.value;
            } catch (e) { textContent = "[Could not extract text from docx]"; }
          } else if (ext === "xlsx") {
            try {
              const workbook = XLSX.read(buffer, { type: "buffer" });
              const sheets = [];
              for (const name of workbook.SheetNames) {
                const sheet = workbook.Sheets[name];
                const csv = XLSX.utils.sheet_to_csv(sheet);
                sheets.push(`--- Sheet: ${name} ---\n${csv}`);
              }
              textContent = sheets.join("\n\n");
            } catch (e) { textContent = "[Could not extract text from xlsx]"; }
          } else if (ext === "pptx") {
            try {
              const AdmZip = require("adm-zip");
              const zip = new AdmZip(buffer);
              const slides = [];
              for (const entry of zip.getEntries()) {
                if (entry.entryName.startsWith("ppt/slides/slide") && entry.entryName.endsWith(".xml")) {
                  const xml = entry.getData().toString("utf-8");
                  const text = xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
                  if (text.length > 10) slides.push(text);
                }
              }
              textContent = slides.map((s, i) => `--- Slide ${i + 1} ---\n${s}`).join("\n\n");
            } catch (e) { textContent = "[Could not extract text from pptx]"; }
          } else {
            textContent = buffer.toString("utf-8");
          }

          return {
            _type: "text",
            textContent: textContent,
            fileName: att.fileName,
            description: att.description,
          };
        } else {
          return {
            _type: "unsupported",
            description: att.description,
            fileName: att.fileName,
            error: `This file type (${att.ext}) can't be viewed directly. Description: "${att.description}"`,
          };
        }
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
