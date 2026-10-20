// lib/files.js: files from the chats, as the engine takes them, and MIME types

const https = require("https");
const ctx = require("./context");

const TELEGRAM_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN || require("./config").getConfCached("TELEGRAM_BOT_TOKEN");

const MIME_TYPES = {
  // Images
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  gif: "image/gif", webp: "image/webp",
  // Documents
  pdf: "application/pdf",
  // Text-based (will be read as text, not base64)
  txt: "text/plain", csv: "text/csv", json: "application/json",
  md: "text/markdown", html: "text/html", xml: "text/xml",
  js: "text/javascript", py: "text/x-python", ts: "text/typescript",
  css: "text/css", sql: "text/sql", sh: "text/x-shellscript",
  yaml: "text/yaml", yml: "text/yaml", log: "text/plain",
  // Documents read to text by lib/file-reader.js
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  doc: "application/msword", xls: "application/vnd.ms-excel", ppt: "application/vnd.ms-powerpoint",
  odt: "application/vnd.oasis.opendocument.text", ods: "application/vnd.oasis.opendocument.spreadsheet", odp: "application/vnd.oasis.opendocument.presentation",
  rtf: "application/rtf", epub: "application/epub+zip", eml: "message/rfc822", msg: "application/vnd.ms-outlook",
  pages: "application/vnd.apple.pages", numbers: "application/vnd.apple.numbers", key: "application/vnd.apple.keynote",
  zip: "application/zip", heic: "image/heic", tiff: "image/tiff", tif: "image/tiff", bmp: "image/bmp",
};

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp"];

async function downloadTelegramFile(fileId) {
  try {
    const file = await ctx.bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN()}/${file.file_path}`;
    const fileName = file.file_path.split("/").pop();
    const ext = fileName.split(".").pop().toLowerCase();
    const buffer = await new Promise((resolve, reject) => {
      https.get(fileUrl, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks)));
        response.on("error", reject);
      }).on("error", reject);
    });
    return buildFileData(buffer, fileName, MIME_TYPES[ext]);
  } catch (error) {
    console.error("Error downloading file:", error.message);
    return null;
  }
}

// A file from any chat (web chat, Telegram, WhatsApp) as the engine takes it.
// A picture the chat model can look at stays a picture; an iPhone photo
// becomes a JPEG first. Everything else, PDFs and scans included, is read
// whole by lib/file-reader.js, the one reader, into textContent.
async function buildFileData(buffer, fileName, mimeType) {
  const reader = require("./file-reader");
  let name = String(fileName || "file");
  let ext = (/\.([a-z0-9]+)$/i.exec(name) || [])[1]?.toLowerCase() || "";
  const kind = reader.kindOf(buffer, name);
  if (kind === "image" && !IMAGE_EXTENSIONS.includes(ext) && /ftyp(heic|heix|hevc|mif1|msf1|avif)/.test(buffer.toString("latin1", 4, 12))) {
    const jpeg = await reader.toJpeg(buffer);
    if (jpeg) { buffer = jpeg; name = name.replace(/\.[a-z0-9]+$/i, "") + ".jpg"; ext = "jpg"; }
  }
  const base = { buffer, base64: buffer.toString("base64"), ext, fileName: name, kind };
  if (kind === "image" && IMAGE_EXTENSIONS.includes(ext)) {
    return { ...base, mediaType: MIME_TYPES[ext] || mimeType, isImage: true, isText: false, isPdf: false, textContent: null };
  }
  if (kind === "audio" || kind === "video") {
    return { ...base, mediaType: mimeType || "application/octet-stream", isImage: false, isText: false, isPdf: false, isAudio: kind === "audio", isVideo: kind === "video", textContent: null };
  }
  const read = await reader.readFile(buffer, name);
  return {
    ...base,
    mediaType: MIME_TYPES[ext] || mimeType || "application/octet-stream",
    isImage: false,
    isPdf: kind === "pdf",
    isText: true,
    // What the file says, or why there is nothing to read, in its place.
    textContent: read.text || `[${read.note || "There is no text in this file."}]`,
    pages: read.pages,
  };
}

module.exports = { MIME_TYPES, IMAGE_EXTENSIONS, downloadTelegramFile, buildFileData };
