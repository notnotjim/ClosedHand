// lib/upload-types.js: the kinds of file Closedhand opens, told apart by what
// the file holds, never by its name or the type the sender's app declared.
//
// Files from the web chat and every chat app pass acceptChatFile in queuedAsk
// (lib/engine.js) before anything stores or reads them, and email attachments
// pass checkFile in lib/assistant-email.js. A file that is none of these
// kinds, or is named as a different kind, is refused with REFUSED and goes no
// further: it is not stored, read or passed on.
//
// The kinds are what Closedhand reads or keeps: images the models see, PDFs,
// text and Office documents it reads, and the audio and video the web chat
// offers to attach.

const REFUSED = "Closedhand can't open that kind of file.";

const IMAGE = ["jpg", "jpeg", "png", "gif", "webp"];
const MEDIA = ["mp4", "m4v", "mov", "m4a", "webm", "ogg", "oga", "opus", "mp3", "wav", "avi", "flac", "aac"];
const TEXT = ["txt", "md", "csv", "json", "html", "htm", "xml", "js", "py", "ts", "css", "sql", "sh", "yaml", "yml", "log", "rtf"];

const at = (b, offset, s) => b.length >= offset + s.length && b.toString("latin1", offset, offset + s.length) === s;
// Word, Excel and PowerPoint files are zip archives with a fixed layout.
const ooxml = (b, folder) => at(b, 0, "PK\x03\x04") && b.includes("[Content_Types].xml") && b.includes(folder);
// Text has no zero bytes and next to no other control characters.
function looksLikeText(b) {
  if (b.includes(0)) return false;
  const head = b.subarray(0, 65536);
  let control = 0;
  for (const c of head) if (c < 32 && c !== 9 && c !== 10 && c !== 12 && c !== 13 && c !== 27) control++;
  return control * 100 <= head.length;
}

// Checked in order; text last, since it is what is left.
const KINDS = [
  { type: "image/jpeg", ext: "jpg", names: IMAGE, test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: "image/png", ext: "png", names: IMAGE, test: (b) => at(b, 0, "\x89PNG\r\n\x1a\n") },
  { type: "image/gif", ext: "gif", names: IMAGE, test: (b) => at(b, 0, "GIF87a") || at(b, 0, "GIF89a") },
  { type: "image/webp", ext: "webp", names: IMAGE, test: (b) => at(b, 0, "RIFF") && at(b, 8, "WEBP") },
  { type: "application/pdf", ext: "pdf", names: ["pdf"], test: (b) => b.subarray(0, 1024).includes("%PDF-") },
  { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx", names: ["docx"], test: (b) => ooxml(b, "word/") },
  { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx", names: ["xlsx"], test: (b) => ooxml(b, "xl/") },
  { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: "pptx", names: ["pptx"], test: (b) => ooxml(b, "ppt/") },
  { type: "application/x-cfb", ext: "doc", names: ["doc", "xls"], test: (b) => at(b, 0, "\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1") },
  // MP4, QuickTime and M4A share one layout; an HEIC photo uses it too and is not media.
  { type: "video/mp4", ext: "mp4", names: MEDIA, test: (b) => at(b, 4, "ftyp") && !/^(heic|heix|hevc|mif1|msf1|avif)/.test(b.toString("latin1", 8, 12)) },
  { type: "video/webm", ext: "webm", names: MEDIA, test: (b) => at(b, 0, "\x1a\x45\xdf\xa3") },
  { type: "audio/ogg", ext: "ogg", names: MEDIA, test: (b) => at(b, 0, "OggS") },
  { type: "audio/wav", ext: "wav", names: MEDIA, test: (b) => at(b, 0, "RIFF") && at(b, 8, "WAVE") },
  { type: "video/x-msvideo", ext: "avi", names: MEDIA, test: (b) => at(b, 0, "RIFF") && at(b, 8, "AVI ") },
  { type: "audio/flac", ext: "flac", names: MEDIA, test: (b) => at(b, 0, "fLaC") },
  { type: "audio/mpeg", ext: "mp3", names: MEDIA, test: (b) => at(b, 0, "ID3") || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0) },
  { type: "audio/aac", ext: "aac", names: MEDIA, test: (b) => b[0] === 0xff && (b[1] & 0xf6) === 0xf0 },
  { type: "text/plain", ext: "txt", names: TEXT, test: looksLikeText },
];

// { ok: true, type, ext } for a file Closedhand opens, where type is what the
// contents are and ext the name's own extension (or the kind's, without
// one); { ok: false } for anything else.
function checkFile(buffer, name) {
  if (!Buffer.isBuffer(buffer)) return { ok: false };
  const named = /\.([a-z0-9]+)$/i.exec(String(name || ""));
  const ext = named ? named[1].toLowerCase() : "";
  const kind = KINDS.find((k) => k.test(buffer));
  if (!kind || (ext && !kind.names.includes(ext))) return { ok: false };
  return { ok: true, type: kind.type, ext: ext || kind.ext };
}

// A file as the web chat and chat apps hand it to the engine: one file, or a
// set of images. Each part must be a kind Closedhand opens, and what the
// platform took it for (an image, a PDF) must be what it is. The stored type
// becomes what the contents are. False when any part is refused.
function acceptChatFile(fileData) {
  const set = fileData.isMultiImage && Array.isArray(fileData.images) ? fileData.images : null;
  for (const part of set || [fileData]) {
    const buffer = Buffer.isBuffer(part.buffer) ? part.buffer : Buffer.from(String(part.base64 || ""), "base64");
    const found = checkFile(buffer, set ? "" : fileData.fileName || fileData.filename);
    if (!found.ok) return false;
    if ((set || fileData.isImage) && !found.type.startsWith("image/")) return false;
    if (fileData.isPdf && found.type !== "application/pdf") return false;
    part.mediaType = found.type;
    if (!set) fileData.ext = found.ext;
  }
  return true;
}

module.exports = { REFUSED, checkFile, acceptChatFile };
