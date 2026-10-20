// One reader for every file Closedhand is given: sent in a chat, attached to
// an email, added to File Search or opened from Drive. Vendored, byte for
// byte, as webapp/file-reader.js (scripts/vendored-manifest.json).
//
//   const { kind, text, note } = await readFile(buffer, "lease.pdf");
//
// It reads the whole file. How much of it goes in front of a model, or into
// an index, is the caller's choice; the reader never cuts.
//
// Files are told apart by what they hold first and by their name second, so
// a PDF saved as "scan.jpg" still reads as a PDF. Scans, photos of documents
// and PDF pages without a text layer are read on this computer: Apple's text
// recognition on a Mac, Tesseract (as WebAssembly) anywhere else. Nothing is
// sent to any company to read a file.
//
// kind is one of: text, html, xml, json, rtf, pdf, doc, docx, odt, xls, xlsx,
// ods, ppt, pptx, odp, pages, numbers, key, epub, eml, msg, zip, image,
// audio, video, unknown. text is "" when there is nothing to read, and note
// then says why in words the person can be shown.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const MAX_DEPTH = 3; // a zip in an email in a zip
const MAX_INNER_FILES = 300;
const MAX_INNER_BYTES = 200 * 1024 * 1024; // what a zip or email may unpack to
const MAX_OCR_PAGES = 300;
const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp", "tif", "tiff", "bmp", "heic", "heif", "avif"]);
const AUDIO_EXT = new Set(["mp3", "m4a", "wav", "ogg", "oga", "opus", "flac", "aac"]);
const VIDEO_EXT = new Set(["mp4", "m4v", "mov", "webm", "avi"]);

const at = (b, offset, s) => b.length >= offset + s.length && b.toString("latin1", offset, offset + s.length) === s;
const extOf = (name) => { const m = /\.([a-z0-9]+)$/i.exec(String(name || "")); return m ? m[1].toLowerCase() : ""; };

function looksLikeText(b) {
  const head = b.subarray(0, 65536);
  if (head.length >= 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))) return true;
  if (head.includes(0)) return false;
  let control = 0;
  for (const c of head) if (c < 32 && c !== 9 && c !== 10 && c !== 12 && c !== 13 && c !== 27) control++;
  return control * 100 <= head.length;
}

function decodeText(b) {
  if (b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString("utf16le");
  if (b[0] === 0xfe && b[1] === 0xff) { const s = Buffer.from(b.subarray(2)); s.swap16(); return s.toString("utf16le"); }
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.subarray(3).toString("utf8");
  const s = b.toString("utf8");
  // Not UTF-8 (an old Windows file): read it as Latin-1 rather than as noise.
  return s.includes("\ufffd") && !b.toString("latin1").includes("\ufffd") ? b.toString("latin1") : s;
}

// --- Which kind of file this is ----------------------------------------------

function zipEntries(buffer) {
  const AdmZip = require("adm-zip");
  const zip = new AdmZip(buffer);
  return { zip, names: zip.getEntries().map((e) => e.entryName) };
}

function cfbOf(buffer) { return require("xlsx").CFB.read(buffer, { type: "buffer" }); }
const cfbHas = (cfb, name) => cfb.FullPaths.some((p) => p.split("/").filter(Boolean).pop() === name);

function kindOf(buffer, name) {
  const ext = extOf(name);
  const b = buffer;
  if (b.subarray(0, 1024).includes("%PDF-")) return "pdf";
  if (at(b, 0, "PK\x03\x04") || at(b, 0, "PK\x05\x06")) {
    try {
      const { zip, names } = zipEntries(b);
      const mimetype = zip.getEntry("mimetype") ? zip.readAsText("mimetype").trim() : "";
      if (names.includes("word/document.xml")) return "docx";
      if (names.includes("xl/workbook.xml")) return "xlsx";
      if (names.includes("ppt/presentation.xml")) return "pptx";
      // OpenDocument, templates and web variants included.
      const odf = /^application\/vnd\.oasis\.opendocument\.(text|spreadsheet|presentation)/.exec(mimetype);
      if (odf) return { text: "odt", spreadsheet: "ods", presentation: "odp" }[odf[1]];
      if (mimetype === "application/epub+zip") return "epub";
      if (names.some((n) => /^Index\/.*\.iwa$/.test(n)) || names.includes("Index.zip")) return ["pages", "numbers", "key"].includes(ext) ? ext : "pages";
    } catch (_) { /* a broken zip reads as one */ }
    return "zip";
  }
  if (at(b, 0, "\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1")) {
    try {
      const cfb = cfbOf(b);
      if (cfbHas(cfb, "WordDocument")) return "doc";
      if (cfbHas(cfb, "PowerPoint Document")) return "ppt";
      if (cfbHas(cfb, "Workbook") || cfbHas(cfb, "Book")) return "xls";
      if (cfb.FullPaths.some((p) => p.includes("__substg1.0_"))) return "msg";
    } catch (_) { /* fall through */ }
    return "unknown";
  }
  if (at(b, 0, "{\\rtf")) return "rtf";
  if ((b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || at(b, 0, "\x89PNG\r\n\x1a\n") || at(b, 0, "GIF87a") || at(b, 0, "GIF89a")
    || (at(b, 0, "RIFF") && at(b, 8, "WEBP")) || at(b, 0, "II*\x00") || at(b, 0, "MM\x00*") || (at(b, 0, "BM") && b.length >= 26)) return "image";
  if (at(b, 4, "ftyp")) return /^(heic|heix|hevc|mif1|msf1|avif)/.test(b.toString("latin1", 8, 12)) ? "image" : AUDIO_EXT.has(ext) ? "audio" : "video";
  if (at(b, 0, "OggS") || at(b, 0, "fLaC") || at(b, 0, "ID3") || (at(b, 0, "RIFF") && at(b, 8, "WAVE"))) return AUDIO_EXT.has(ext) || !VIDEO_EXT.has(ext) ? "audio" : "video";
  if (at(b, 0, "\x1a\x45\xdf\xa3") || (at(b, 0, "RIFF") && at(b, 8, "AVI "))) return "video";
  if (!looksLikeText(b)) return IMAGE_EXT.has(ext) ? "image" : AUDIO_EXT.has(ext) ? "audio" : VIDEO_EXT.has(ext) ? "video" : "unknown";
  const head = decodeText(b.subarray(0, 4096)).trimStart();
  if (ext === "eml" || /^(Return-Path|Received|From|Message-ID|MIME-Version|Delivered-To):/im.test(head.slice(0, 200)) && /^Subject:/im.test(decodeText(b.subarray(0, 65536)))) return "eml";
  if (["html", "htm", "xhtml"].includes(ext) || /^(<!doctype html|<html)/i.test(head)) return "html";
  if (ext === "json" || ext === "geojson") return "json";
  if (["xml", "svg", "plist", "rss", "atom", "kml", "gpx"].includes(ext) || head.startsWith("<?xml")) return "xml";
  return "text";
}

// --- Reading each kind -------------------------------------------------------

function xmlText(xml) {
  return String(xml)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    // A break where a block ends or a line breaks; a tab between cells.
    .replace(/<\/(p|div|h[1-6]|li|tr|text:p|text:h|a:p|w:p|dc:title)>|<(br|text:line-break)\b[^>]*\/?>/gi, "\n")
    .replace(/<\/(td|th|table:table-cell)>|<text:tab\b[^>]*\/?>/gi, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}
const tidy = (s) => String(s || "").replace(/\r\n?/g, "\n").replace(/[ \t\u00a0]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

function htmlText(html) {
  const cheerio = require("cheerio");
  const $ = cheerio.load(html);
  $("script, style, noscript, template").remove();
  // The page's own line breaks and indents are layout, not text.
  const flatten = (el) => { for (const c of el.children || []) { if (c.type === "text") c.data = c.data.replace(/\s+/g, " "); else if (c.name !== "pre") flatten(c); } };
  flatten($.root()[0]);
  $("br").replaceWith("\n");
  $("p, div, li, tr, h1, h2, h3, h4, h5, h6, section, article, header, footer, blockquote, pre, table").each((_, el) => { $(el).append("\n"); });
  $("td, th").each((_, el) => { $(el).append("\t"); });
  return tidy(($("body").length ? $("body") : $.root()).text().replace(/ *\t */g, "\t").replace(/\t+\n/g, "\n").replace(/ *\n */g, "\n"));
}

// RTF as text: paragraphs, escaped characters and Unicode, without the font,
// colour and style tables or embedded pictures.
function rtfText(rtf) {
  let out = "", i = 0, uc = 1;
  const skip = [false];
  const SKIPPED = new Set(["fonttbl", "colortbl", "stylesheet", "info", "pict", "header", "footer", "listtable", "listoverridetable", "rsidtbl", "generator", "themedata", "colorschememapping", "latentstyles", "datastore", "xmlnstbl", "mmathPr"]);
  while (i < rtf.length) {
    const c = rtf[i];
    if (c === "{") { skip.push(skip[skip.length - 1]); i++; continue; }
    if (c === "}") { if (skip.length > 1) skip.pop(); i++; continue; }
    if (c === "\\") {
      const next = rtf[i + 1];
      if (next === "'") { if (!skip[skip.length - 1]) out += Buffer.from([parseInt(rtf.substr(i + 2, 2), 16)]).toString("latin1"); i += 4; continue; }
      if (next === "*") { skip[skip.length - 1] = true; i += 2; continue; }
      if (next === "\\" || next === "{" || next === "}") { if (!skip[skip.length - 1]) out += next; i += 2; continue; }
      if (next === "~") { if (!skip[skip.length - 1]) out += " "; i += 2; continue; }
      const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i, i + 40));
      if (!m) { i += 2; continue; }
      i += m[0].length;
      const word = m[1], arg = m[2] === undefined ? null : +m[2];
      if (SKIPPED.has(word)) { skip[skip.length - 1] = true; continue; }
      if (skip[skip.length - 1]) continue;
      if (word === "par" || word === "line" || word === "sect" || word === "row") out += "\n";
      else if (word === "tab" || word === "cell") out += "\t";
      else if (word === "uc") uc = arg || 1;
      else if (word === "u" && arg !== null) {
        out += String.fromCharCode(arg < 0 ? arg + 65536 : arg);
        // Skip the stand-in characters that follow for older readers.
        for (let n = 0; n < uc && i < rtf.length; n++) i += rtf[i] === "\\" && rtf[i + 1] === "'" ? 4 : 1;
      }
      continue;
    }
    if (c !== "\r" && c !== "\n" && !skip[skip.length - 1]) out += c;
    i++;
  }
  return tidy(out);
}

// PDF.js reads the text layer: the build Firefox uses, since the one inside
// pdf-parse (2017) refused common PDFs, those made with pdfkit among them.
let _pdfjs = null;
async function pdfjs() {
  // By path, so it is found wherever require finds packages (NODE_PATH too).
  if (!_pdfjs) _pdfjs = await import(require("url").pathToFileURL(path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "legacy/build/pdf.mjs")).href);
  return _pdfjs;
}
async function openPdf(buffer) {
  const { getDocument } = await pdfjs();
  const dist = path.dirname(require.resolve("pdfjs-dist/package.json"));
  return getDocument({
    data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false, verbosity: 0,
    cMapUrl: path.join(dist, "cmaps") + path.sep, cMapPacked: true, standardFontDataUrl: path.join(dist, "standard_fonts") + path.sep,
  }).promise;
}
async function pdfRead(buffer, opts) {
  const doc = await openPdf(buffer);
  // One string per page, so a scanned page among typed ones is found.
  const pages = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => (item.str || "") + (item.hasEOL ? "\n" : "")).join("").replace(/[ \t]+\n/g, "\n"));
      page.cleanup();
    }
  } finally { doc.destroy(); }
  const data = { text: pages.join("\n") };
  const count = pages.length;
  const blank = [];
  for (let p = 0; p < count; p++) if (String(pages[p] || "").replace(/\s/g, "").length < 20) blank.push(p);
  let used = false;
  if (blank.length && opts.ocr) {
    const read = await ocrPdfPages(buffer, blank.slice(0, MAX_OCR_PAGES));
    for (const r of read || []) if (r.text && r.text.trim()) { pages[r.page] = r.text; used = true; }
  }
  const text = count > 1
    ? Array.from({ length: count }, (_, p) => (pages[p] || "").trim() ? `[Page ${p + 1}]\n${tidy(pages[p])}` : "").filter(Boolean).join("\n\n")
    : tidy(pages[0] || data.text);
  const unread = blank.filter((p) => !String(pages[p] || "").trim()).length;
  const note = !text ? (opts.ocr ? "This PDF has no text Closedhand could read, and no words were found on its pages." : "This PDF has no text layer.")
    : unread ? `${unread} of ${count} pages had no text Closedhand could read.` : undefined;
  return { text, pages: count, ocr: used, note };
}

async function docxRead(buffer) {
  const mammoth = require("mammoth");
  return tidy((await mammoth.extractRawText({ buffer })).value);
}

// Word 97-2003: the text sits in the WordDocument stream in pieces, listed by
// the piece table in the table stream; each piece is 8-bit or UTF-16.
function docRead(buffer) {
  const cfb = cfbOf(buffer);
  const find = (n) => { const i = cfb.FullPaths.findIndex((p) => p.split("/").filter(Boolean).pop() === n); return i >= 0 ? Buffer.from(cfb.FileIndex[i].content) : null; };
  const word = find("WordDocument");
  if (!word) return "";
  const flags = word.readUInt16LE(0x0a);
  const table = find(flags & 0x0200 ? "1Table" : "0Table");
  const fcClx = word.readUInt32LE(0x01a2), lcbClx = word.readUInt32LE(0x01a6);
  let out = "";
  if (table && lcbClx) {
    const clx = table.subarray(fcClx, fcClx + lcbClx);
    let i = 0;
    while (i < clx.length && clx[i] === 0x01) i += 3 + clx.readUInt16LE(i + 1); // Prc blocks before the piece table
    if (clx[i] === 0x02) {
      const plc = clx.subarray(i + 5, i + 5 + clx.readUInt32LE(i + 1));
      const n = (plc.length - 4) / 12;
      for (let k = 0; k < n; k++) {
        const cpStart = plc.readUInt32LE(k * 4), cpEnd = plc.readUInt32LE((k + 1) * 4);
        const fcRaw = plc.readUInt32LE((n + 1) * 4 + k * 8 + 2);
        const compressed = (fcRaw & 0x40000000) !== 0;
        const fc = compressed ? (fcRaw & ~0x40000000) / 2 : fcRaw;
        const len = cpEnd - cpStart;
        out += compressed ? word.subarray(fc, fc + len).toString("latin1") : word.subarray(fc, fc + len * 2).toString("utf16le");
      }
    }
  }
  if (!out) {
    const ccpText = word.readUInt32LE(0x004c), fcMin = word.readUInt32LE(0x0018);
    out = word.subarray(fcMin, fcMin + ccpText).toString("latin1");
  }
  // Field codes (\x13 code \x14 result \x15) keep their result; marks become breaks.
  out = out.replace(/\x13[^\x14\x15]*\x14?([^\x15]*)\x15/g, "$1").replace(/[\r\x0b\x0c]/g, "\n").replace(/\x07/g, "\t").replace(/[\x00-\x08\x0e-\x1f]/g, "");
  return tidy(out);
}

function sheetRead(buffer) {
  const XLSX = require("xlsx");
  const wb = XLSX.read(buffer, { type: "buffer" });
  return tidy(wb.SheetNames.map((n) => {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[n], { blankrows: false });
    return csv.trim() ? (wb.SheetNames.length > 1 ? `[Sheet: ${n}]\n` : "") + csv : "";
  }).filter(Boolean).join("\n\n"));
}

function pptxRead(buffer) {
  const { zip, names } = zipEntries(buffer);
  const num = (n) => +(/(\d+)\.xml$/.exec(n) || [0, 0])[1];
  const textOf = (n) => tidy(xmlText(zip.readAsText(n).replace(/<a:br\/>/g, "\n")));
  return names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => num(a) - num(b)).map((n) => {
    const notes = names.includes(`ppt/notesSlides/notesSlide${num(n)}.xml`) ? textOf(`ppt/notesSlides/notesSlide${num(n)}.xml`).replace(/^\d+$/m, "").trim() : "";
    return `[Slide ${num(n)}]\n${textOf(n)}${notes ? `\nNotes: ${notes}` : ""}`;
  }).join("\n\n");
}

// PowerPoint 97-2003: records in the "PowerPoint Document" stream. Each
// slide container holds its shapes' text; files from PowerPoint itself also
// list placeholder text in the slide list, one slide per persist atom. The
// masters' sample text is left out.
function pptRead(buffer) {
  const cfb = cfbOf(buffer);
  const i = cfb.FullPaths.findIndex((p) => p.endsWith("PowerPoint Document"));
  if (i < 0) return "";
  const s = Buffer.from(cfb.FileIndex[i].content);
  const inSlides = [], inList = [], notes = [];
  let slide = null, listed = null, note = null;
  const walk = (start, end, where) => {
    let o = start;
    while (o + 8 <= end) {
      const ver = s.readUInt16LE(o) & 0x0f, type = s.readUInt16LE(o + 2), len = s.readUInt32LE(o + 4);
      const body = o + 8, stop = Math.min(end, body + len);
      if (ver === 0x0f) {
        if (type === 0x03ee) { inSlides.push(slide = []); walk(body, stop, "slide"); }
        else if (type === 0x03f0) { notes.push(note = []); walk(body, stop, "notes"); }
        else if (type === 0x0ff0) walk(body, stop, "list");
        else if (type !== 0x03f8 && type !== 0x0fc9) walk(body, stop, where);
      } else if (where === "list" && type === 0x03f3) inList.push(listed = []);
      else if (type === 0x0fa0 || type === 0x0fa8) {
        const t = (type === 0x0fa0 ? s.toString("utf16le", body, stop) : s.toString("latin1", body, stop)).replace(/\r/g, "\n");
        if (where === "slide" && slide) slide.push(t);
        else if (where === "list" && listed) listed.push(t);
        else if (where === "notes" && note) note.push(t);
      }
      o = stop;
    }
  };
  walk(0, s.length, null);
  const words = (list) => list.map((t) => t.join("\n")).join("").replace(/\s/g, "").length;
  const slides = words(inSlides) >= words(inList) ? inSlides : inList;
  // Notes point at their slide by id, not by place, and the first is the
  // notes master's placeholders ("*"), so they are listed after the slides.
  const said = notes.map((t) => tidy(t.join("\n").replace(/^\*$/gm, ""))).filter(Boolean);
  return [...slides.map((t, n) => tidy(t.join("\n")) ? `[Slide ${n + 1}]\n${tidy(t.join("\n"))}` : ""), said.length ? `[Notes]\n${said.join("\n\n")}` : ""]
    .filter(Boolean).join("\n\n");
}

function odfRead(buffer) {
  const { zip } = zipEntries(buffer);
  return tidy(xmlText(zip.readAsText("content.xml")).replace(/^<number>$/gm, ""));
}

function epubRead(buffer) {
  const { zip, names } = zipEntries(buffer);
  const container = zip.getEntry("META-INF/container.xml") ? zip.readAsText("META-INF/container.xml") : "";
  const opfPath = (/full-path="([^"]+)"/.exec(container) || [])[1] || names.find((n) => n.endsWith(".opf"));
  if (!opfPath) return "";
  const opf = zip.readAsText(opfPath);
  const base = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const items = {};
  for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
    const id = (/\bid="([^"]+)"/.exec(m[0]) || [])[1], href = (/\bhref="([^"]+)"/.exec(m[0]) || [])[1];
    if (id && href) items[id] = base + decodeURIComponent(href);
  }
  const order = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((m) => items[m[1]]).filter((p) => p && zip.getEntry(p));
  const title = tidy(xmlText((/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/.exec(opf) || [])[1] || "")).replace(/^Unknown Title$/, "");
  return tidy((title ? title + "\n\n" : "") + order.map((p) => htmlText(zip.readAsText(p))).join("\n\n"));
}

// Apple Pages, Numbers and Keynote: Index/*.iwa files, each a run of Snappy
// chunks holding protobuf messages. The words are the text field (3) of the
// text storage messages (type 2001); tables in Numbers are read with
// SheetJS first.
function snappy(src) {
  let i = 0, len = 0, shift = 0, b;
  do { b = src[i++]; len |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
  const out = Buffer.alloc(len);
  let o = 0;
  while (i < src.length && o < len) {
    const tag = src[i++], type = tag & 3;
    if (type === 0) {
      let n = tag >> 2;
      if (n >= 60) { const bytes = n - 59; n = 0; for (let k = 0; k < bytes; k++) n |= src[i++] << (8 * k); }
      n += 1;
      src.copy(out, o, i, i + n); i += n; o += n;
      continue;
    }
    let n, off;
    if (type === 1) { n = ((tag >> 2) & 7) + 4; off = ((tag >> 5) << 8) | src[i++]; }
    else if (type === 2) { n = (tag >> 2) + 1; off = src.readUInt16LE(i); i += 2; }
    else { n = (tag >> 2) + 1; off = src.readUInt32LE(i); i += 4; }
    for (let k = 0; k < n; k++, o++) out[o] = out[o - off];
  }
  return out;
}
function varint(b, i) { let v = 0, shift = 0, c; do { c = b[i++]; v += (c & 0x7f) * 2 ** shift; shift += 7; } while (c & 0x80 && i < b.length); return [v, i]; }
function protoFields(b) {
  const fields = [];
  let i = 0;
  while (i < b.length) {
    let key; [key, i] = varint(b, i);
    const field = Math.floor(key / 8), wire = key & 7;
    if (wire === 0) { let v; [v, i] = varint(b, i); fields.push([field, v]); }
    else if (wire === 2) { let n; [n, i] = varint(b, i); fields.push([field, b.subarray(i, i + n)]); i += n; }
    else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else break;
  }
  return fields;
}
function iwaTexts(iwa) {
  const texts = [];
  let i = 0;
  const parts = [];
  while (i + 4 <= iwa.length) {
    const n = iwa[i + 1] | (iwa[i + 2] << 8) | (iwa[i + 3] << 16);
    parts.push(iwa[i] === 0 ? snappy(iwa.subarray(i + 4, i + 4 + n)) : iwa.subarray(i + 4, i + 4 + n));
    i += 4 + n;
  }
  const data = Buffer.concat(parts);
  let o = 0;
  while (o < data.length) {
    let infoLen; [infoLen, o] = varint(data, o);
    const info = protoFields(data.subarray(o, o + infoLen));
    o += infoLen;
    for (const [field, value] of info) {
      if (field !== 2 || !Buffer.isBuffer(value)) continue; // MessageInfo
      const mi = protoFields(value);
      const type = (mi.find(([f]) => f === 1) || [])[1], length = (mi.find(([f]) => f === 3) || [])[1] || 0;
      const body = data.subarray(o, o + length);
      o += length;
      if (type === 2001) for (const [f, v] of protoFields(body)) if (f === 3 && Buffer.isBuffer(v)) texts.push(v.toString("utf8"));
    }
  }
  return texts;
}
async function iworkRead(buffer, kind) {
  if (kind === "numbers") { try { const t = sheetRead(buffer); if (t) return t; } catch (_) { /* text storage below */ } }
  let { zip, names } = zipEntries(buffer);
  if (names.includes("Index.zip")) ({ zip, names } = zipEntries(zip.readFile("Index.zip")));
  const files = names.filter((n) => /(^|\/)Index\/.*\.iwa$/.test(n) || /^[^/]*\.iwa$/.test(n))
    .sort((a, b) => (/Document\.iwa$/.test(b) ? 1 : 0) - (/Document\.iwa$/.test(a) ? 1 : 0) || a.localeCompare(b));
  const texts = [];
  for (const n of files) { try { texts.push(...iwaTexts(zip.readFile(n))); } catch (_) { /* skip a part that will not open */ } }
  return tidy(texts.join("\n").replace(/[\ufffc\u2028]/g, "\n").replace(/\u2029/g, "\n\n"));
}

// Outlook .msg: properties stored as streams named __substg1.0_<id><type>.
function msgRead(buffer, opts, readInner) {
  const cfb = cfbOf(buffer);
  const prop = (prefix, id) => {
    for (const type of ["001F", "001E", "0102"]) {
      const i = cfb.FullPaths.findIndex((p) => p === `${prefix}__substg1.0_${id}${type}`);
      if (i < 0) continue;
      const c = Buffer.from(cfb.FileIndex[i].content || []);
      return type === "001F" ? c.toString("utf16le").replace(/\0+$/, "") : type === "001E" ? c.toString("latin1").replace(/\0+$/, "") : c;
    }
    return null;
  };
  const root = cfb.FullPaths[0];
  const head = [["From", prop(root, "0C1A") || prop(root, "0042")], ["To", prop(root, "0E04")], ["Cc", prop(root, "0E03")], ["Subject", prop(root, "0037")]]
    .filter(([, v]) => v && String(v).trim()).map(([k, v]) => `${k}: ${String(v).trim()}`);
  let body = prop(root, "1000");
  if (!body) { const html = prop(root, "1013"); if (html) body = htmlText(Buffer.isBuffer(html) ? html.toString("utf8") : html); }
  const attachments = cfb.FullPaths.filter((p) => /^[^/]*\/__attach_version1\.0_#[0-9A-F]{8}\/$/i.test(p));
  return { head: head.join("\n"), body: tidy(body || ""), attachments: attachments.map((a) => ({ name: prop(a, "3707") || prop(a, "3704") || "attachment", data: prop(a, "3701") })).filter((a) => Buffer.isBuffer(a.data)) };
}

async function emlRead(buffer) {
  const { simpleParser } = require("mailparser");
  const mail = await simpleParser(buffer, { skipImageLinks: true, skipTextToHtml: true });
  const who = (a) => a ? a.value.map((v) => (v.name ? `${v.name} <${v.address}>` : v.address)).join(", ") : null;
  const head = [["From", who(mail.from)], ["To", who(mail.to)], ["Cc", who(mail.cc)], ["Date", mail.date ? mail.date.toUTCString() : null], ["Subject", mail.subject]]
    .filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  const body = mail.text ? tidy(mail.text) : mail.html ? htmlText(mail.html) : "";
  return { head: head.join("\n"), body, attachments: (mail.attachments || []).filter((a) => a.contentDisposition !== "inline" || !/^image\//.test(a.contentType)).map((a) => ({ name: a.filename || "attachment", data: a.content })) };
}

// --- Reading text in pictures (OCR) -----------------------------------------

// Apple's text recognition through JavaScript for Automation: images (HEIC
// included) and chosen PDF pages, which PDFKit draws first. Prints JSON.
const VISION_SCRIPT = `ObjC.import('Foundation'); ObjC.import('Vision'); ObjC.import('PDFKit'); ObjC.import('AppKit');
function run(argv) {
  var path = argv[0], wanted = argv[1] ? argv[1].split(',').map(Number) : null, url = $.NSURL.fileURLWithPath(path);
  function read(handler) {
    var req = $.VNRecognizeTextRequest.alloc.init;
    req.recognitionLevel = 0; req.usesLanguageCorrection = true;
    if (req.respondsToSelector('setAutomaticallyDetectsLanguage:')) req.automaticallyDetectsLanguage = true;
    handler.performRequestsError($([req]), null);
    var obs = req.results, lines = [];
    for (var i = 0; i < obs.count; i++) { var o = obs.objectAtIndex(i), b = o.boundingBox; lines.push({ y: b.origin.y + b.size.height, x: b.origin.x, t: o.topCandidates(1).objectAtIndex(0).string.js }); }
    lines.sort(function (a, b) { return Math.abs(a.y - b.y) > 0.01 ? b.y - a.y : a.x - b.x; });
    return lines.map(function (l) { return l.t; }).join('\\n');
  }
  var out = [];
  if (/\\.pdf$/i.test(path)) {
    var doc = $.PDFDocument.alloc.initWithURL(url);
    for (var p = 0; p < doc.pageCount; p++) {
      if (wanted && wanted.indexOf(p) < 0) continue;
      var page = doc.pageAtIndex(p), box = page.boundsForBox(0), scale = Math.min(3, 2200 / Math.max(box.size.width, box.size.height));
      var img = page.thumbnailOfSizeForBox({ width: box.size.width * scale, height: box.size.height * scale }, 0);
      out.push({ page: p, text: read($.VNImageRequestHandler.alloc.initWithDataOptions(img.TIFFRepresentation, $({}))) });
    }
  } else out.push({ page: 0, text: read($.VNImageRequestHandler.alloc.initWithURLOptions(url, $({}))) });
  return JSON.stringify(out);
}`;

const run = (cmd, args, timeout = 120000) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
});
const has = (cmd) => run("/bin/sh", ["-c", `command -v ${cmd}`], 5000).then(() => true, () => false);

// One OCR job at a time: it is heavy, and a folder of scans should not take
// the whole computer.
let queue = Promise.resolve();
function oneAtATime(job) { const p = queue.then(job, job); queue = p.catch(() => {}); return p; }

async function withTemp(buffer, ext, job) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "closedhand-read-"));
  const file = path.join(dir, "file." + ext);
  fs.writeFileSync(file, buffer);
  try { return await job(file, dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// CLOSEDHAND_OCR=tesseract uses Tesseract on a Mac too, as tests do.
const appleVision = () => process.platform === "darwin" && process.env.CLOSEDHAND_OCR !== "tesseract";
let _worker = null, _idle = null;
// Lets the engine go now rather than after its quiet minute (tests, shutdown).
async function closeOcr() { clearTimeout(_idle); const w = _worker; _worker = null; if (w) await w.terminate().catch(() => {}); }
async function tesseractWorker() {
  clearTimeout(_idle);
  if (!_worker) {
    const { createWorker, OEM } = require("tesseract.js");
    const data = path.dirname(require.resolve("@tesseract.js-data/eng/package.json"));
    _worker = await createWorker("eng", OEM.LSTM_ONLY, {
      langPath: path.join(data, "4.0.0_best_int"), gzip: true, cacheMethod: "none", logger: () => {},
      // Without a handler a failed job also throws outside any promise, which
      // would end the whole process; with one, the await below just fails.
      errorHandler: () => {},
    });
  }
  // Let the engine go after a quiet minute; it holds memory while it waits.
  _idle = setTimeout(() => { const w = _worker; _worker = null; if (w) w.terminate().catch(() => {}); }, 60000);
  _idle.unref?.();
  return _worker;
}
async function tesseract(file) {
  const worker = await tesseractWorker();
  return (await worker.recognize(file)).data.text || "";
}

// HEIC (iPhone photos) and AVIF as JPEG, for OCR here and for models that
// only take the common kinds. null when nothing on this computer converts it.
async function toJpeg(buffer) {
  return withTemp(buffer, "heic", async (file, dir) => {
    const out = path.join(dir, "out.jpg");
    if (process.platform === "darwin") await run("/usr/bin/sips", ["-s", "format", "jpeg", file, "--out", out]);
    else if (await has("heif-convert")) await run("heif-convert", ["-q", "90", file, out]);
    else return null;
    return fs.existsSync(out) ? fs.readFileSync(out) : null;
  }).catch(() => null);
}

async function ocrImage(buffer) {
  return oneAtATime(async () => {
    const heif = at(buffer, 4, "ftyp");
    if (appleVision()) {
      try {
        const out = await withTemp(buffer, heif ? "heic" : "img", (file) => run("/usr/bin/osascript", ["-l", "JavaScript", "-e", VISION_SCRIPT, file]));
        return (JSON.parse(out)[0] || {}).text || "";
      } catch (_) { /* fall back to Tesseract */ }
    }
    let input = buffer;
    if (heif) { input = await toJpeg(buffer); if (!input) return null; }
    try { return await withTemp(input, "png", (file) => tesseract(file)); } catch (_) { return null; }
  });
}

// [{ page, text }] for the chosen pages (0-based), or null when this computer
// has no way to read them.
async function ocrPdfPages(buffer, pages) {
  if (!pages.length) return [];
  return oneAtATime(() => withTemp(buffer, "pdf", async (file, dir) => {
    if (appleVision()) {
      try { return JSON.parse(await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", VISION_SCRIPT, file, pages.join(",")], 600000)); }
      catch (_) { /* fall back to Tesseract */ }
    }
    // PDF.js draws each page, about 200 dots to the inch, for Tesseract.
    const doc = await openPdf(buffer);
    const out = [];
    try {
      for (const p of pages) {
        try {
          const page = await doc.getPage(p + 1);
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: Math.min(3, 2200 / Math.max(base.width, base.height)) });
          const { canvas, context } = doc.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
          await page.render({ canvasContext: context, viewport, canvas }).promise;
          const png = path.join(dir, `p${p}.png`);
          fs.writeFileSync(png, canvas.toBuffer("image/png"));
          out.push({ page: p, text: await tesseract(png) });
          page.cleanup();
        } catch (_) { out.push({ page: p, text: "" }); }
      }
    } finally { doc.destroy(); }
    return out;
  }));
}

// --- The reader --------------------------------------------------------------

async function readFile(buffer, name, opts = {}) {
  opts = { ocr: true, depth: 0, ...opts };
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer || []);
  const kind = kindOf(buffer, name);
  const done = (text, extra = {}) => ({ kind, text: text || "", ocr: false, ...extra, ...(!text && !extra.note ? { note: "There is no text in this file." } : {}) });
  // Files inside an email or a zip, read in turn under their own headings.
  const budget = opts.budget || { files: 0, bytes: 0 };
  const inner = async (list) => {
    const parts = [];
    for (const f of list) {
      if (f.tooBig || opts.depth >= MAX_DEPTH || budget.files >= MAX_INNER_FILES || budget.bytes + f.data.length > MAX_INNER_BYTES) { parts.push(`[${f.name}: not opened, there is too much inside]`); continue; }
      budget.files++; budget.bytes += f.data.length;
      const r = await readFile(f.data, f.name, { ...opts, depth: opts.depth + 1, budget }).catch(() => null);
      parts.push(r && r.text ? `[${f.name}]\n${r.text}` : `[${f.name}: ${r?.note || "could not be read"}]`);
    }
    return parts.join("\n\n");
  };
  try {
    switch (kind) {
      case "text": return done(tidy(decodeText(buffer)));
      case "html": return done(htmlText(decodeText(buffer)));
      case "xml": return done(tidy(xmlText(decodeText(buffer))));
      case "json": { const s = decodeText(buffer); try { return done(JSON.stringify(JSON.parse(s), null, 2)); } catch (_) { return done(tidy(s)); } }
      case "rtf": return done(rtfText(buffer.toString("latin1")));
      case "pdf": { const r = await pdfRead(buffer, opts); return { kind, ...r, text: r.text || "" }; }
      case "docx": return done(await docxRead(buffer));
      case "doc": return done(docRead(buffer));
      case "xls": case "xlsx": case "ods": return done(sheetRead(buffer));
      case "pptx": return done(pptxRead(buffer));
      case "ppt": return done(pptRead(buffer));
      case "odt": case "odp": return done(odfRead(buffer));
      case "epub": return done(epubRead(buffer));
      case "pages": case "numbers": case "key": return done(await iworkRead(buffer, kind));
      case "eml": case "msg": {
        const m = kind === "eml" ? await emlRead(buffer) : msgRead(buffer);
        const attached = m.attachments.length ? await inner(m.attachments) : "";
        return done(tidy([m.head, m.body, attached && `Attachments:\n${attached}`].filter(Boolean).join("\n\n")));
      }
      case "zip": {
        const { zip } = zipEntries(buffer);
        const files = zip.getEntries().filter((e) => !e.isDirectory && !/(^|\/)(__MACOSX\/|\.DS_Store$|\._)/.test(e.entryName));
        const list = [];
        for (const e of files) {
          if (list.length >= MAX_INNER_FILES || budget.bytes + e.header.size > MAX_INNER_BYTES) { list.push({ name: e.entryName, tooBig: true }); continue; }
          list.push({ name: e.entryName, data: e.getData() });
        }
        return done(await inner(list), list.length ? {} : { note: "This zip is empty." });
      }
      case "image": {
        if (!opts.ocr) return done("", { note: "A picture." });
        const text = await ocrImage(buffer);
        if (text === null) return done("", { note: "Closedhand can't read text in pictures on this computer." });
        return done(tidy(text), { ocr: true, ...(tidy(text) ? {} : { note: "A picture with no words in it." }) });
      }
      case "audio": return done("", { note: "A sound recording." });
      case "video": return done("", { note: "A video." });
      default: return done("", { note: `Closedhand can't read this kind of file${extOf(name) ? ` (.${extOf(name)})` : ""}.` });
    }
  } catch (e) {
    return done("", { note: `Closedhand couldn't open this file: it may be damaged or locked with a password.`, error: e.message });
  }
}

// A long text in parts that fit beside a conversation: about a third of the
// model's context window (counting four characters to a token), never less
// than 8,000 characters or more than 100,000. part counts from 1.
function textPart(text, part = 1, contextWindow = 200000) {
  const size = Math.max(8000, Math.min(100000, Math.floor((contextWindow || 200000) * 4 * 0.3)));
  const all = String(text || "");
  const parts = Math.max(1, Math.ceil(all.length / size));
  const n = Math.min(Math.max(1, Math.floor(part) || 1), parts);
  return { text: all.slice((n - 1) * size, n * size), part: n, parts };
}

module.exports = { readFile, kindOf, toJpeg, ocrImage, closeOcr, textPart, looksLikeText, rtfText, snappy, iwaTexts };
