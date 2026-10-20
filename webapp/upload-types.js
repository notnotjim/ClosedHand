// webapp/upload-types.js: the kinds of file Closedhand opens, told apart by what
// the file holds, never by its name or the type the sender's app declared.
//
// Files from the web chat and every chat app pass acceptChatFile in queuedAsk
// (lib/engine.js) before anything stores or reads them, and email attachments
// pass checkFile in lib/assistant-email.js. A file that is none of these
// kinds, or is named as a different kind, is refused with REFUSED and goes no
// further: it is not stored, read or passed on.
//
// The kinds are what Closedhand reads or keeps: images the models see, and
// every kind of document lib/file-reader.js reads (PDFs and scans, Office
// and OpenDocument files, Pages, Numbers and Keynote, emails, ebooks, zips,
// iPhone photos, text under any name), and the audio and video the web chat
// offers to attach. Programs are refused, and SVG pictures, which can carry
// code, whatever they are called.
//
// Files put on the sandbox computer, from its panel or copied from a Mac
// through the Mac Bridge, pass checkWorkspaceFile in webapp/server.js before
// they are written, and a copied folder passes filterTar file by file. The
// sandbox computer is where the owner and Closedhand work on files, so its
// list is wider: archives, more image kinds, OpenDocument and Apple documents,
// SQLite databases and text under any name, code included. Programs and
// binary files of no listed kind are refused there too.

const REFUSED = "Closedhand can't open that kind of file.";

const IMAGE = ["jpg", "jpeg", "png", "gif", "webp"];
const PHOTO = ["heic", "heif", "avif"];
const MEDIA = ["mp4", "m4v", "mov", "m4a", "webm", "ogg", "oga", "opus", "mp3", "wav", "avi", "flac", "aac"];
const TEXT = ["txt", "md", "csv", "json", "html", "htm", "xml", "js", "py", "ts", "css", "sql", "sh", "yaml", "yml", "log", "rtf"];
// Old Office files and Outlook emails share one container.
const CFB = ["doc", "xls", "ppt", "msg", "dot", "xlt", "pot"];
// OpenDocument, Apple and e-book files are zips inside.
const ZIPPED = ["zip", "odt", "ods", "odp", "odg", "epub", "pages", "numbers", "key"];
// Names that say "program" are refused even when the file inside is text.
const PROGRAM = ["exe", "dll", "msi", "com", "scr", "bat", "cmd", "ps1", "vbs", "jar", "app", "dmg", "pkg", "deb", "rpm", "apk", "ipa", "bin", "so", "dylib", "iso", "img", "svg", "svgz"];

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
  { type: "application/x-cfb", ext: "doc", names: CFB, test: (b) => at(b, 0, "\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1") },
  { type: "image/heic", ext: "heic", names: PHOTO, test: (b) => at(b, 4, "ftyp") && /^(heic|heix|hevc|mif1|msf1|avif)/.test(b.toString("latin1", 8, 12)) },
  { type: "image/tiff", ext: "tiff", names: ["tif", "tiff"], test: (b) => at(b, 0, "II*\x00") || at(b, 0, "MM\x00*") },
  { type: "image/bmp", ext: "bmp", names: ["bmp"], test: (b) => at(b, 0, "BM") && b.length >= 26 },
  { type: "application/zip", ext: "zip", names: ZIPPED, test: (b) => at(b, 0, "PK\x03\x04") || at(b, 0, "PK\x05\x06") },
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
const KIND_NAMES = new Set(KINDS.flatMap((k) => k.names));

// { ok: true, type, ext } for a file Closedhand opens, where type is what the
// contents are and ext the name's own extension (or the kind's, without
// one); { ok: false } for anything else.
function checkFile(buffer, name) {
  if (!Buffer.isBuffer(buffer)) return { ok: false };
  const named = /\.([a-z0-9]+)$/i.exec(String(name || ""));
  const ext = named ? named[1].toLowerCase() : "";
  if (PROGRAM.includes(ext)) return { ok: false };
  const kind = KINDS.find((k) => k.test(buffer));
  if (kind && (!ext || kind.names.includes(ext))) return { ok: true, type: kind.type, ext: ext || kind.ext };
  // Text is read under any name (a .eml, a .tex, code) that is not a binary kind's.
  if (kind && kind.type === "text/plain" && !KIND_NAMES.has(ext)) return { ok: true, type: kind.type, ext };
  return { ok: false };
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

// The sandbox computer's wider list, checked before the chat kinds' text
// catch-all. A zip is told apart only from the Office layouts above it, so
// "zip" covers OpenDocument, Apple and e-book files, which are zips inside.
const WORKSPACE_KINDS = [
  ...KINDS.slice(0, -1),
  { type: "application/gzip", ext: "gz", names: ["gz", "tgz"], test: (b) => b[0] === 0x1f && b[1] === 0x8b },
  { type: "application/x-tar", ext: "tar", names: ["tar"], test: (b) => at(b, 257, "ustar") },
  { type: "application/x-bzip2", ext: "bz2", names: ["bz2", "tbz2"], test: (b) => at(b, 0, "BZh") },
  { type: "application/x-xz", ext: "xz", names: ["xz", "txz"], test: (b) => at(b, 0, "\xfd7zXZ\x00") },
  { type: "application/x-7z-compressed", ext: "7z", names: ["7z"], test: (b) => at(b, 0, "7z\xbc\xaf\x27\x1c") },
  { type: "application/vnd.sqlite3", ext: "sqlite", names: ["sqlite", "sqlite3", "db"], test: (b) => at(b, 0, "SQLite format 3\x00") },
];
const BINARY_NAMES = new Set(WORKSPACE_KINDS.flatMap((k) => k.names).filter((n) => !TEXT.includes(n)));

function workspaceRefused(name) {
  return `${name} wasn't copied: the sandbox computer takes documents, images, audio, video, text and archives, not programs or files of a kind it doesn't know.`;
}

// { ok: true, type, ext } for a file the sandbox computer takes; { ok: false,
// reason } for anything else. Text is taken under any name except one that
// says it is a binary kind, so "invoice.pdf" holding text is refused.
function checkWorkspaceFile(buffer, name) {
  if (!Buffer.isBuffer(buffer)) return { ok: false, reason: workspaceRefused(String(name || "The file")) };
  const base = String(name || "").split("/").pop();
  const named = /\.([a-z0-9]+)$/i.exec(base);
  const ext = named ? named[1].toLowerCase() : "";
  const kind = WORKSPACE_KINDS.find((k) => k.test(buffer));
  if (kind && (!ext || kind.names.includes(ext))) return { ok: true, type: kind.type, ext: ext || kind.ext };
  if (!kind && looksLikeText(buffer) && !BINARY_NAMES.has(ext)) return { ok: true, type: "text/plain", ext };
  return { ok: false, reason: workspaceRefused(base || "The file") };
}

// The folder copy arrives as a tar file. Each regular file in it is checked
// as above. Folders are kept; refused files, links and device files are left
// out, along with the headers that belong to them. Finder's own files
// (.DS_Store and "._" copies of extended attributes) are left out without
// being named, since nobody chose to copy them.
// Returns { tar, kept, leftOut } where leftOut lists the names refused.
function filterTar(buffer) {
  const out = [];
  const leftOut = [];
  let kept = 0;
  let pending = []; // pax or long-name headers waiting for their entry
  let longName = null;
  const str = (b, o, n) => { const s = b.toString("utf8", o, o + n); const z = s.indexOf("\0"); return z === -1 ? s : s.slice(0, z); };
  const size = (h) => {
    if (h[124] & 0x80) return -1; // base-256 sizes are beyond 8 GB, past any upload limit
    const n = parseInt(str(h, 124, 12).trim() || "0", 8);
    return Number.isFinite(n) ? n : -1;
  };
  let off = 0;
  while (off + 512 <= buffer.length) {
    const h = buffer.subarray(off, off + 512);
    if (h.every((c) => c === 0)) break;
    const n = size(h);
    if (n < 0) break;
    const end = off + 512 + Math.ceil(n / 512) * 512;
    if (end > buffer.length) break;
    const block = buffer.subarray(off, end);
    const data = buffer.subarray(off + 512, off + 512 + n);
    const type = String.fromCharCode(h[156] || 48);
    off = end;
    if (type === "x" || type === "L") {
      pending.push(block);
      if (type === "L") longName = str(data, 0, data.length);
      else for (const m of data.toString("utf8").matchAll(/\d+ path=([^\n]*)\n/g)) longName = m[1];
      continue;
    }
    if (type === "g") continue;
    const prefix = str(h, 345, 155);
    const path = longName || (prefix ? prefix + "/" : "") + str(h, 0, 100);
    const headers = pending;
    pending = [];
    longName = null;
    let keep = false;
    if (type === "5") keep = true;
    else if (type === "0" || type === "7" || h[156] === 0) {
      const base = path.replace(/\/+$/, "").split("/").pop();
      const finder = base === ".DS_Store" || base.startsWith("._");
      keep = !finder && checkWorkspaceFile(data, base).ok;
      if (!keep && !finder) leftOut.push(path.replace(/^\.\//, ""));
    }
    else if (type === "1" || type === "2") leftOut.push(path.replace(/^\.\//, "") + " (a link)");
    if (keep) { out.push(...headers, block); if (type !== "5") kept++; }
  }
  out.push(Buffer.alloc(1024));
  return { tar: Buffer.concat(out), kept, leftOut };
}

module.exports = { REFUSED, checkFile, acceptChatFile, checkWorkspaceFile, filterTar, workspaceRefused };
