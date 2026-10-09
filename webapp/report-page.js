// A page, at /page/<id>: what Closedhand makes when an answer is worth
// keeping or sharing. One link that opens from any chat through the personal
// URL, readable on a phone, with the same content as a PDF, Word document or
// spreadsheet when a file is wanted. A page exists only when Closedhand judged
// one helps beyond the chat answer (save_report; the code still says report);
// the chat always carries the answer, and this is the fuller version.
//
// One reading of the page's Markdown feeds the page, the Word document and
// the spreadsheet, so the three never disagree about what the page says.

const AdmZip = require("adm-zip");

// A follow-on break (lib/follow-on.js) is a paragraph in a document.
const BREAK = /^[ \t]*\[\[next\]\][ \t]*$/gm;
const ROW = /^\s*\|.*\|\s*$/;
const RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cells(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

// Headings, paragraphs, lists and tables, in order.
function blocks(md) {
  const lines = String(md || "").replace(BREAK, "").split(/\r?\n/);
  const out = [];
  let para = [];
  const endPara = () => { if (para.length) { out.push({ type: "para", lines: para }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (ROW.test(line) && RULE.test(lines[i + 1] || "")) {
      endPara();
      const rows = [];
      for (i += 2; i < lines.length && ROW.test(lines[i]); i++) rows.push(cells(lines[i]));
      i--;
      out.push({ type: "table", header: cells(line), rows });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { endPara(); out.push({ type: "rule" }); continue; }
    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (heading) { endPara(); out.push({ type: "heading", level: Math.min(heading[1].length, 3), text: heading[2] }); continue; }
    const item = line.match(/^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/);
    if (item) {
      endPara();
      const ordered = !item[1];
      const last = out[out.length - 1];
      if (last && last.type === "list" && last.ordered === ordered) last.items.push(item[3]);
      else out.push({ type: "list", ordered, items: [item[3]] });
      continue;
    }
    if (!line.trim()) { endPara(); continue; }
    para.push(line.trim());
  }
  endPara();
  return out;
}

// The page shows the report's title; a document that opens with its own
// heading saying the same thing would show it twice.
const words = (t) => String(t || "").toLowerCase().replace(/[*_`#]/g, "").match(/[\p{L}\p{N}]+/gu) || [];
function withoutTitle(list, title) {
  const first = list[0];
  if (!first || first.type !== "heading") return list;
  const t = new Set(words(title)), h = words(first.text);
  const shared = h.filter((w) => t.has(w)).length;
  return shared >= Math.max(2, Math.ceil(t.size * 0.6)) ? list.slice(1) : list;
}

function hasTables(md) {
  return blocks(md).some((b) => b.type === "table");
}

// --- The page -------------------------------------------------------------

const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(text) {
  const e = esc(text);
  let out = "", last = 0, m;
  const link = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<]+)/g;
  const marks = (t) => t
    .replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=$|[\s).,:;!?])/g, "$1<em>$2</em>")
    .replace(/`([^`\n]+?)`/g, "<code>$1</code>");
  while ((m = link.exec(e))) {
    out += marks(e.slice(last, m.index));
    out += m[1] ? `<a href="${m[2]}" target="_blank" rel="noopener">${marks(m[1])}</a>` : `<a href="${m[3]}" target="_blank" rel="noopener">${m[3]}</a>`;
    last = link.lastIndex;
  }
  return out + marks(e.slice(last));
}

function bodyHtml(md, title) {
  return withoutTitle(blocks(md), title).map((b) => {
    if (b.type === "rule") return "<hr>";
    if (b.type === "heading") return `<h${b.level + 1}>${inline(b.text)}</h${b.level + 1}>`;
    if (b.type === "para") return `<p>${b.lines.map(inline).join("<br>")}</p>`;
    if (b.type === "list") return `<${b.ordered ? "ol" : "ul"}>${b.items.map((t) => `<li>${inline(t)}</li>`).join("")}</${b.ordered ? "ol" : "ul"}>`;
    const head = b.header.some((c) => c.trim()) ? `<thead><tr>${b.header.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead>` : "";
    return `<div class="table"><table>${head}`
      + `<tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }).join("\n");
}

// The page around a report, or around the note that one was deleted.
function shell(title, inner) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=Fraunces:opsz,wght@9..144,500;9..144,600&display=swap">
<style>
:root { --bg: #f7f3ee; --fg: #241c18; --muted: #75685f; --line: #e3dbd2; --accent: #b9452f; --head: #efe7de; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg: #141010; --fg: #efe6d6; --muted: #a2968b; --line: #2f2724; --accent: #d8624b; --head: #1f1917; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.65 "IBM Plex Sans", system-ui, -apple-system, sans-serif; padding: max(20px, env(safe-area-inset-top)) 16px 64px; }
main { max-width: 760px; margin: 0 auto; }
.bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding-bottom: 18px; margin-bottom: 26px; border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; text-decoration: none; }
.brand img { width: 18px; height: 18px; }
.files { display: flex; gap: 8px; }
.file { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 500; color: var(--fg); text-decoration: none; border: 1px solid var(--line); border-radius: 999px; padding: 5px 14px 5px 11px; }
.file svg { flex: none; color: var(--muted); }
.file:hover svg, .file:focus-visible svg { color: var(--accent); }
.file:hover, .file:focus-visible { border-color: var(--accent); color: var(--accent); }
h1 { font-family: Fraunces, Georgia, serif; font-weight: 600; font-size: clamp(1.6rem, 4vw, 2.2rem); line-height: 1.2; margin: 0 0 6px; text-wrap: balance; }
.when { color: var(--muted); font-size: 14px; margin: 0 0 28px; }
h2, h3, h4 { font-family: Fraunces, Georgia, serif; font-weight: 600; line-height: 1.25; margin: 30px 0 10px; text-wrap: balance; }
h2 { font-size: 1.35rem; } h3 { font-size: 1.12rem; } h4 { font-size: 1rem; }
p, ul, ol { margin: 0 0 14px; max-width: 68ch; }
li { margin: 4px 0; }
a { color: var(--accent); text-underline-offset: 3px; }
code { font: 0.9em "SF Mono", Menlo, monospace; background: var(--head); padding: 1px 5px; border-radius: 4px; }
.table { overflow-x: auto; margin: 6px 0 20px; border: 1px solid var(--line); border-radius: 10px; }
table { border-collapse: collapse; width: 100%; font-size: 14.5px; font-variant-numeric: tabular-nums; }
th, td { text-align: left; vertical-align: top; padding: 9px 12px; border-bottom: 1px solid var(--line); }
tr:last-child td { border-bottom: 0; }
th { background: var(--head); font-weight: 600; white-space: nowrap; }
hr { border: 0; border-top: 1px solid var(--line); margin: 28px 0; }
.end { margin-top: 40px; padding-top: 18px; border-top: 1px solid var(--line); font-size: 13px; color: var(--muted); }
.end summary { cursor: pointer; display: inline-block; list-style: none; border: 1px solid var(--line); border-radius: 999px; padding: 5px 14px; color: var(--muted); }
.end summary::-webkit-details-marker { display: none; }
.end summary:hover, .end summary:focus-visible { color: var(--accent); border-color: var(--accent); }
.end form { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 12px; }
.end button { font: inherit; font-weight: 500; color: var(--accent); background: none; border: 1px solid var(--accent); border-radius: 999px; padding: 5px 14px; cursor: pointer; }
</style></head>
<body><main>
${inner}
</main></body></html>`;
}

const brand = '<a class="brand" href="/"><img src="/fist.png" alt="">Closedhand</a>';
const dated = (iso) => iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "";

function pageHtml(report) {
  const id = encodeURIComponent(report.id);
  // Dates arrive as Date objects from the database, so compare the times.
  const edited = report.updated_at && new Date(report.updated_at) - new Date(report.created_at) > 60000 ? `, edited ${dated(report.updated_at)}` : "";
  // Each button downloads the page in that format, and says so: an arrow
  // into a tray, and a label that names the download for screen readers.
  const icon = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>';
  const file = (kind, label) => `<a class="file" href="/api/pages/${id}/${kind}" download aria-label="Download as ${label}" title="Download as ${label}">${icon}${label}</a>`;
  const files = [
    file("pdf", "PDF"),
    file("docx", "Word"),
    hasTables(report.content) ? file("xlsx", "Excel") : "",
  ].join("");
  // Deleting asks first, in place, with no script: the page has none.
  const remove = `<details class="end"><summary>Delete page</summary><form method="post" action="/api/pages/${id}/delete"><span>Delete this page for good? The answer stays in the chat you asked in.</span><button type="submit">Delete</button></form></details>`;
  return shell(report.title, `<div class="bar">${brand}<div class="files">${files}</div></div>
<h1>${esc(report.title)}</h1>
<p class="when">${esc(dated(report.created_at) + edited)}</p>
${bodyHtml(report.content, report.title)}
${remove}`);
}

function deletedHtml(report) {
  return shell("Page deleted", `<div class="bar">${brand}</div>
<h1>Page deleted</h1>
<p>"${esc(report.title)}" is gone, with its PDF, Word and Excel versions. The answer is still in the chat you asked in.</p>
<p><a href="/dashboard#pages">Your other pages</a> &middot; <a href="/">Back to Closedhand</a></p>`);
}

// A page link that leads nowhere: the same page around a short note, with
// the way back, instead of bare text on a white screen.
function missingHtml() {
  return shell("Page not found", `<div class="bar">${brand}</div>
<h1>This page isn\u2019t here</h1>
<p>It may have been deleted, or the link may be for a different Closedhand.</p>
<p><a href="/dashboard#pages">Your pages</a> &middot; <a href="/">Back to Closedhand</a></p>`);
}

// --- Word -------------------------------------------------------------------

const xml = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Text runs with bold kept; links become their words followed by the address.
function runs(text) {
  const plain = String(text).replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)").replace(/`([^`\n]+)`/g, "$1").replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=$|[\s).,:;!?])/g, "$1$2");
  return plain.split(/(\*\*[^*\n]+?\*\*)/).filter(Boolean).map((part) => {
    const bold = /^\*\*.*\*\*$/.test(part);
    const t = bold ? part.slice(2, -2) : part;
    return `<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${xml(t)}</w:t></w:r>`;
  }).join("");
}

function docxBuffer(report) {
  const title = report.title;
  const para = (inner, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}${inner}</w:p>`;
  const body = [para(runs(title), "Title")];
  for (const b of withoutTitle(blocks(report.content), title)) {
    if (b.type === "rule") { body.push(para("")); continue; }
    if (b.type === "heading") body.push(para(runs(b.text), `Heading${b.level}`));
    else if (b.type === "para") body.push(para(b.lines.map(runs).join('<w:r><w:br/></w:r>')));
    else if (b.type === "list") b.items.forEach((t, i) => body.push(para(`<w:r><w:t xml:space="preserve">${b.ordered ? `${i + 1}. ` : "• "}</w:t></w:r>${runs(t)}`, "ListParagraph")));
    else {
      const row = (cellsIn, head) => `<w:tr>${cellsIn.map((c) => `<w:tc><w:p>${head ? runs(`**${c}**`) : runs(c)}</w:p></w:tc>`).join("")}</w:tr>`;
      const headRow = b.header.some((c) => c.trim()) ? row(b.header, true) : "";
      body.push(`<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>${headRow}${b.rows.map((r) => row(r)).join("")}</w:tbl>`);
      body.push(para(""));
    }
  }
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:spacing w:before="200" w:after="100"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:rPr><w:b/><w:sz w:val="23"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:pPr><w:ind w:left="360"/><w:spacing w:after="60"/></w:pPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:color="BFBFBF"/><w:bottom w:val="single" w:sz="4" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideH w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:color="BFBFBF"/></w:tblBorders><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;
  const zip = new AdmZip();
  zip.addFile("[Content_Types].xml", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`));
  zip.addFile("_rels/.rels", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`));
  zip.addFile("word/_rels/document.xml.rels", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`));
  zip.addFile("word/styles.xml", Buffer.from(styles));
  zip.addFile("word/document.xml", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`));
  return zip.toBuffer();
}

// --- Excel ------------------------------------------------------------------

// One sheet per table, named from the heading above it when there is one.
function xlsxBuffer(report) {
  const XLSX = require("xlsx");
  const book = XLSX.utils.book_new();
  const used = new Set();
  let heading = "";
  const clean = (t) => String(t).replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)").replace(/`([^`]+)`/g, "$1");
  let n = 0;
  for (const b of blocks(report.content)) {
    if (b.type === "heading") { heading = clean(b.text); continue; }
    if (b.type !== "table") continue;
    n++;
    let name = (heading || `Table ${n}`).replace(/[\\/?*[\]:]/g, " ").slice(0, 31).trim() || `Table ${n}`;
    while (used.has(name)) name = `${name.slice(0, 27)} ${n++}`;
    used.add(name);
    const header = b.header.some((c) => c.trim()) ? [b.header.map(clean)] : [];
    const sheet = XLSX.utils.aoa_to_sheet([...header, ...b.rows.map((r) => r.map(clean))]);
    sheet["!cols"] = b.header.map((_, i) => ({ wch: Math.min(48, Math.max(10, ...[b.header, ...b.rows].map((r) => clean(r[i] || "").length))) }));
    XLSX.utils.book_append_sheet(book, sheet, name);
  }
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
}

module.exports = { blocks, hasTables, bodyHtml, pageHtml, deletedHtml, missingHtml, docxBuffer, xlsxBuffer };
