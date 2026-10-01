// lib/files.js — Telegram file download, MIME types, file extraction

const https = require("https");
const mammoth = require("mammoth");
const XLSX = require("xlsx");
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
  // Binary docs (need extraction — handled separately)
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const TEXT_EXTENSIONS = ["txt", "csv", "json", "md", "html", "xml", "js", "py", "ts", "css", "sql", "sh", "yaml", "yml", "log"];
const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp"];
const OFFICE_EXTENSIONS = ["docx", "xlsx", "pptx"];

async function downloadTelegramFile(fileId) {
  try {
    const file = await ctx.bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN()}/${file.file_path}`;
    const ext = file.file_path.split(".").pop().toLowerCase();
    const mediaType = MIME_TYPES[ext] || "application/octet-stream";
    const fileName = file.file_path.split("/").pop();

    return new Promise((resolve, reject) => {
      https.get(fileUrl, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", async () => {
          const buffer = Buffer.concat(chunks);

          let textContent = null;
          if (TEXT_EXTENSIONS.includes(ext)) {
            textContent = buffer.toString("utf-8");
          } else if (ext === "docx") {
            try {
              const result = await mammoth.extractRawText({ buffer: buffer });
              textContent = result.value;
            } catch (e) {
              console.error("docx extraction error:", e.message);
            }
          } else if (ext === "xlsx" || ext === "csv") {
            try {
              const workbook = XLSX.read(buffer, { type: "buffer" });
              const sheets = [];
              for (const name of workbook.SheetNames) {
                const sheet = workbook.Sheets[name];
                const csv = XLSX.utils.sheet_to_csv(sheet);
                sheets.push(`--- Sheet: ${name} ---\n${csv}`);
              }
              textContent = sheets.join("\n\n");
            } catch (e) {
              console.error("xlsx extraction error:", e.message);
            }
          } else if (ext === "pptx") {
            // Basic pptx text extraction — reads XML from the zip
            try {
              const AdmZip = require("adm-zip");
              const zip = new AdmZip(buffer);
              const slides = [];
              for (const entry of zip.getEntries()) {
                if (entry.entryName.startsWith("ppt/slides/slide") && entry.entryName.endsWith(".xml")) {
                  const xml = entry.getData().toString("utf-8");
                  // Strip XML tags to get plain text
                  const text = xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
                  if (text.length > 10) slides.push(text);
                }
              }
              textContent = slides.map((s, i) => `--- Slide ${i + 1} ---\n${s}`).join("\n\n");
            } catch (e) {
              console.error("pptx extraction error:", e.message);
            }
          }

          resolve({
            buffer: buffer,
            base64: buffer.toString("base64"),
            mediaType: mediaType,
            ext: ext,
            fileName: fileName,
            isImage: IMAGE_EXTENSIONS.includes(ext),
            isText: TEXT_EXTENSIONS.includes(ext) || OFFICE_EXTENSIONS.includes(ext),
            isPdf: ext === "pdf",
            textContent: textContent,
          });
        });
        response.on("error", reject);
      });
    });
  } catch (error) {
    console.error("Error downloading file:", error.message);
    return null;
  }
}

async function buildFileData(buffer, fileName, mimeType) {
  const ext = fileName.split(".").pop().toLowerCase();
  const resolvedMimeType = mimeType || MIME_TYPES[ext] || "application/octet-stream";

  let textContent = null;
  if (TEXT_EXTENSIONS.includes(ext)) {
    textContent = buffer.toString("utf-8");
  } else if (ext === "docx") {
    try {
      const result = await mammoth.extractRawText({ buffer });
      textContent = result.value;
    } catch (e) { console.error("docx extraction error:", e.message); }
  } else if (ext === "xlsx" || ext === "csv") {
    try {
      const workbook = XLSX.read(buffer, { type: "buffer" });
      const sheets = [];
      for (const name of workbook.SheetNames) {
        sheets.push(`--- Sheet: ${name} ---\n${XLSX.utils.sheet_to_csv(workbook.Sheets[name])}`);
      }
      textContent = sheets.join("\n\n");
    } catch (e) { console.error("xlsx extraction error:", e.message); }
  } else if (ext === "pptx") {
    try {
      const AdmZip = require("adm-zip");
      const zip = new AdmZip(buffer);
      const slides = [];
      for (const entry of zip.getEntries()) {
        if (entry.entryName.startsWith("ppt/slides/slide") && entry.entryName.endsWith(".xml")) {
          const text = entry.getData().toString("utf-8").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
          if (text.length > 10) slides.push(text);
        }
      }
      textContent = slides.map((s, i) => `--- Slide ${i + 1} ---\n${s}`).join("\n\n");
    } catch (e) { console.error("pptx extraction error:", e.message); }
  }

  return {
    buffer,
    base64: buffer.toString("base64"),
    mediaType: resolvedMimeType,
    ext,
    fileName,
    isImage: IMAGE_EXTENSIONS.includes(ext),
    isText: TEXT_EXTENSIONS.includes(ext) || OFFICE_EXTENSIONS.includes(ext),
    isPdf: ext === "pdf",
    textContent,
  };
}

module.exports = {
  MIME_TYPES, TEXT_EXTENSIONS, IMAGE_EXTENSIONS, OFFICE_EXTENSIONS,
  downloadTelegramFile, buildFileData,
};
