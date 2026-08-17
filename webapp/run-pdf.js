// webapp/run-pdf.js — a finished agent run, typeset as a PDF for download.
//
// Mirrors the dashboard's renderReport() dialect so the download matches the
// web view: # headings, **bold**, `code`, pipe tables, and everything else
// keeps its own line breaks. Bullet and numbered lines get a hanging indent,
// which plain <pre-wrap> could not give the web view but print deserves.

const PDFDocument = require("pdfkit");
const path = require("path");
const fs = require("fs");

// pdfkit's built-in Helvetica speaks WinAnsi only, which silently mangles
// anything past Latin-1: a Turkish company name came out as glyph soup in a
// downloaded report (2026-08-13). DejaVu (bundled, free license) covers
// Latin extended, Greek and Cyrillic; the built-ins remain only as a fallback
// if the font files are missing in a stripped-down install.
const F = (() => {
  const d = path.join(__dirname, "fonts");
  const have = f => fs.existsSync(path.join(d, f));
  const base = have("DejaVuSans.ttf") && have("DejaVuSans-Bold.ttf") && have("DejaVuSansMono.ttf")
    ? { body: path.join(d, "DejaVuSans.ttf"), bold: path.join(d, "DejaVuSans-Bold.ttf"), mono: path.join(d, "DejaVuSansMono.ttf") }
    : { body: "Helvetica", bold: "Helvetica-Bold", mono: "Courier" };
  // One pan-CJK face (Japanese, Chinese, Korean; Regular only, its weight
  // difference barely reads at body sizes). It carries Latin glyphs too, so a
  // run that contains any East Asian character switches whole to Noto rather
  // than stitching fonts mid-word.
  base.cjk = have("NotoSansCJKjp-Regular.otf") ? path.join(d, "NotoSansCJKjp-Regular.otf") : null;
  return base;
})();

const CJK_RE = /[ᄀ-ᇿ⺀-〿぀-ヿ㄰-㆏ㇰ-㋿㐀-䶿一-鿿ꥠ-꥿가-퟿豈-﫿︰-﹏＀-￯]/;

// The face for one run of text: Noto when East Asian characters are present
// and the font is available, otherwise DejaVu in the asked-for weight.
function fontFor(s, opts = {}) {
  if (F.cjk && CJK_RE.test(String(s))) return F.cjk;
  return opts.code ? F.mono : opts.bold ? F.bold : F.body;
}

const MARGIN = 56;
const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const W = PAGE_W - MARGIN * 2;
const BOTTOM = PAGE_H - 64;

const INK = "#17181c";
const MUTED = "#6b6f76";
const RULE = "#d9dbe0";
const ACCENT = "#16a34a";

// Same title derivation as the dashboard card: the run's own title, else the
// first real sentence of what the user asked.
function runTitle(run) {
  let goal = run.title
    ? String(run.title)
    : String(run.goal || "Agent run").split(/\n\[Picking up work/)[0].replace(/\s+/g, " ").trim();
  if (!run.title) {
    const stop = goal.search(/[.!?](\s|$)/);
    if (stop > 25) goal = goal.slice(0, stop);
  }
  if (goal.length > 90) goal = goal.slice(0, 90) + "…";
  return goal.charAt(0).toUpperCase() + goal.slice(1);
}

// Split a line into inline segments: **bold** and `code`, everything else plain.
function inlineSegs(s) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ t: s.slice(last, m.index) });
    if (m[0].startsWith("**")) out.push({ t: m[0].slice(2, -2), b: true });
    else out.push({ t: m[0].slice(1, -1), c: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ t: s.slice(last) });
  return out.length ? out : [{ t: "" }];
}

function stripInline(s) {
  return String(s).replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
}

// Results written before agents learned to end standalone sometimes close
// with a chat offer ("Want shipping labels drafted ... ?"). In a downloaded
// document that is a dangling question to nobody. Only the final block goes,
// and only when it is short and unmistakably offer-shaped; anything else is
// content and stays.
function stripChatTrailer(md) {
  const blocks = String(md).replace(/\s+$/, "").split(/\n{2,}/);
  if (blocks.length < 2) return md;
  const last = blocks[blocks.length - 1].trim();
  // Only a block that OPENS as an offer goes. A block that merely ends with a
  // question stays: "should the VAT be credited?" is content, not chat.
  const offerStart = /^(want|would you like|should i|shall i|happy to|let me know|say the word|just say|if you(?:'d| would) like)\b/i;
  if (last.length <= 240 && !last.includes("|") && !/^#/.test(last) && offerStart.test(last)) {
    return blocks.slice(0, -1).join("\n\n");
  }
  return md;
}

function ensureRoom(doc, needed) {
  if (doc.y + needed > BOTTOM) doc.addPage();
}

// Flow one line's inline segments starting at x with the given wrap width.
function writeInline(doc, s, x, width, opts = {}) {
  const list = inlineSegs(s);
  list.forEach((sg, i) => {
    doc
      .font(fontFor(sg.t, { code: sg.c, bold: sg.b || opts.bold }))
      .fontSize(sg.c ? (opts.size || 10.5) - 1 : opts.size || 10.5)
      .fillColor(opts.color || INK);
    if (i === 0) doc.text(sg.t, x, doc.y, { width, lineGap: opts.lineGap ?? 3, continued: list.length > 1 });
    else doc.text(sg.t, { width, lineGap: opts.lineGap ?? 3, continued: i < list.length - 1 });
  });
}

function drawTable(doc, head, rows) {
  const pad = 5;
  const lens = head.map((h, ci) =>
    Math.max(stripInline(h).length, ...rows.map(r => stripInline(r[ci] || "").length), 4));
  const totalLen = lens.reduce((a, b) => a + b, 0) || 1;
  let widths = lens.map(l => Math.max(52, (l / totalLen) * W));
  const scale = W / widths.reduce((a, b) => a + b, 0);
  widths = widths.map(w => w * scale);

  const drawRow = (cells, isHead) => {
    const clean = cells.map(c => stripInline(c || ""));
    const cellFonts = clean.map(c => fontFor(c, { bold: isHead }));
    doc.fontSize(9);
    const h = Math.max(...clean.map((c, ci) => doc.font(cellFonts[ci]).heightOfString(c, { width: widths[ci] - pad * 2 })), 10) + pad * 2;
    if (doc.y + h > BOTTOM) doc.addPage();
    const y = doc.y;
    let x = MARGIN;
    clean.forEach((c, ci) => {
      doc.font(cellFonts[ci]).fillColor(isHead ? MUTED : INK).text(c, x + pad, y + pad, { width: widths[ci] - pad * 2, lineGap: 1 });
      x += widths[ci];
    });
    doc.moveTo(MARGIN, y + h).lineTo(MARGIN + W, y + h)
      .lineWidth(isHead ? 1 : 0.5).strokeColor(isHead ? "#b9bcc2" : RULE).stroke();
    doc.x = MARGIN;
    doc.y = y + h;
  };

  ensureRoom(doc, 40);
  drawRow(head, true);
  rows.forEach(r => drawRow(r, false));
  doc.moveDown(0.9);
}

function writeBody(doc, md) {
  const lines = String(md).split(/\r?\n/);
  const isRow = l => /^\s*\|.*\|\s*$/.test(l);
  const cells = l => l.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());

  let i = 0;
  let blank = 0;
  while (i < lines.length) {
    const line = lines[i];

    // A ``` fence line is markup, not content: keep what is inside the fence
    // as ordinary lines, drop the backtick rows themselves.
    if (/^\s*```/.test(line)) { i++; continue; }

    // Pipe table with a separator row, exactly as the web view detects them.
    if (isRow(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && isRow(lines[i])) { rows.push(cells(lines[i])); i++; }
      drawTable(doc, head, rows);
      blank = 0;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const size = level === 1 ? 15 : level === 2 ? 12.5 : 11;
      ensureRoom(doc, 50);
      doc.moveDown(0.6);
      writeInline(doc, heading[2], MARGIN, W, { bold: true, size, lineGap: 2 });
      doc.moveDown(0.25);
      i++; blank = 0;
      continue;
    }

    if (!line.trim()) {
      // Collapse runs of blank lines into one paragraph gap.
      if (blank === 0) doc.moveDown(0.55);
      blank++;
      i++;
      continue;
    }

    const bullet = line.match(/^(\s*)([-*•]|\d{1,2}[.)])\s+(.+)$/);
    if (bullet) {
      const marker = /\d/.test(bullet[2]) ? bullet[2] : "•";
      const indent = MARGIN + (bullet[1].length >= 2 ? 16 : 4);
      ensureRoom(doc, 24);
      const y = doc.y;
      doc.font(F.body).fontSize(10.5).fillColor(INK).text(marker, indent, y, { lineBreak: false, width: 22 });
      doc.y = y;
      writeInline(doc, bullet[3], indent + 16, W - (indent + 16 - MARGIN));
      doc.x = MARGIN;
      i++; blank = 0;
      continue;
    }

    ensureRoom(doc, 24);
    writeInline(doc, line, MARGIN, W);
    doc.x = MARGIN;
    i++; blank = 0;
  }
}

// Build the document. Returns the PDFDocument stream; pipe it before end()
// runs, so the route does runPdf(run).pipe(res).
function runPdf(run) {
  const doc = new PDFDocument({ size: "A4", margin: MARGIN, bufferPages: true, info: { Title: runTitle(run), Author: "ClosedHand" } });

  // Header: wordmark, date, rule.
  const finished = run.completed_at || run.created_at;
  let dateStr = finished
    ? new Date(finished).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" })
    : "";
  if (run.result_edited_at) {
    dateStr += (dateStr ? " · " : "") + "edited " + new Date(run.result_edited_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }
  doc.font(F.bold).fontSize(10).fillColor(ACCENT).text("ClosedHand", MARGIN, MARGIN - 10, { continued: false });
  if (dateStr) {
    doc.font(F.body).fontSize(9).fillColor(MUTED)
      .text(dateStr, MARGIN, MARGIN - 9, { width: W, align: "right" });
  }
  doc.moveTo(MARGIN, MARGIN + 8).lineTo(MARGIN + W, MARGIN + 8).lineWidth(1).strokeColor(RULE).stroke();
  doc.y = MARGIN + 24;

  // Title + what was asked, when it differs from the title.
  doc.font(fontFor(runTitle(run), { bold: true })).fontSize(19).fillColor(INK).text(runTitle(run), MARGIN, doc.y, { width: W, lineGap: 2 });
  const asked = String(run.goal || "").split(/\n\[Picking up work/)[0].replace(/\s+/g, " ").trim();
  if (run.title && asked && asked.toLowerCase() !== runTitle(run).toLowerCase()) {
    doc.moveDown(0.3);
    doc.font(fontFor(asked)).fontSize(9).fillColor(MUTED).text(asked.length > 220 ? asked.slice(0, 220) + "…" : asked, { width: W, lineGap: 2 });
  }
  doc.moveDown(1);

  writeBody(doc, stripChatTrailer(run.result || ""));

  // Footer on every page: wordmark left, page number right. The bottom margin
  // is zeroed while stamping, or pdfkit treats the footer as overflowing body
  // text and quietly appends a blank page for it.
  const range = doc.bufferedPageRange();
  for (let p = range.start; p < range.start + range.count; p++) {
    doc.switchToPage(p);
    const ob = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font(F.body).fontSize(8).fillColor(MUTED);
    doc.text("ClosedHand", MARGIN, PAGE_H - 42, { lineBreak: false });
    doc.text(`${p - range.start + 1} of ${range.count}`, MARGIN, PAGE_H - 42, { width: W, align: "right", lineBreak: false });
    doc.page.margins.bottom = ob;
  }

  doc.end();
  return doc;
}

module.exports = { runPdf, runTitle };
