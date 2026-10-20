// Every kind of file Closedhand is given reads as text, whole, through the one
// reader: made here from invented content, the way each app writes it.
// Needs the reader's packages on NODE_PATH (see .github/workflows/checks.yml).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const AdmZip = require('adm-zip');
const XLSX = require('xlsx');
const reader = require('../lib/file-reader');
const { readFile, kindOf } = reader;
require('node:test').after(() => reader.closeOcr());
const root = path.join(__dirname, '..');
const fixture = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f));

const zip = (files) => { const z = new AdmZip(); for (const [n, c] of Object.entries(files)) z.addFile(n, Buffer.isBuffer(c) ? c : Buffer.from(c)); return z.toBuffer(); };
const cfb = (streams) => { const c = XLSX.CFB.utils.cfb_new(); for (const [n, d] of Object.entries(streams)) XLSX.CFB.utils.cfb_add(c, n, d); return Buffer.from(XLSX.CFB.write(c, { type: 'buffer' })); };
const u16 = (s) => Buffer.from(s, 'utf16le');

// PDFs made with pdfkit, as the web app makes its own: one with a line of
// text on each page, and a scan, the fixture picture as the page with no text.
function pdfOf(draw) {
  const PDFDocument = require('pdfkit');
  return new Promise((resolve) => {
    const doc = new PDFDocument({ autoFirstPage: false, compress: false, info: { Producer: 'test', Creator: 'test' } });
    const parts = [];
    doc.on('data', (c) => parts.push(c)).on('end', () => resolve(Buffer.concat(parts)));
    draw(doc);
    doc.end();
  });
}
const textPdf = (lines) => pdfOf((doc) => { for (const line of lines) doc.addPage().fontSize(18).text(line, 72, 72); });
const scannedPdf = () => pdfOf((doc) => { doc.addPage({ size: [900, 220], margin: 0 }).image(fixture('reader-scan.png'), 0, 0, { width: 900 }); });

test('plain text under any name, in any common encoding, reads whole', async () => {
  const long = 'Plover Street lease. '.repeat(2000) + 'The last line is still here.';
  for (const [name, buf] of [['notes.txt', Buffer.from(long)], ['server.log', Buffer.from(long)], ['main.py', Buffer.from('print("Fairhaven")\n')], ['no-name', Buffer.from('Kestrel Lettings\n')]]) {
    const r = await readFile(buf, name);
    assert.equal(r.kind, 'text', name);
    assert.ok(r.text.length > 10, name);
  }
  assert.match((await readFile(Buffer.from(long), 'notes.txt')).text, /The last line is still here\.$/, 'nothing is cut');
  assert.equal((await readFile(Buffer.concat([Buffer.from([0xff, 0xfe]), u16('Caf\u00e9 Plover')]), 'a.txt')).text, 'Caf\u00e9 Plover', 'UTF-16 with its mark');
  assert.equal((await readFile(Buffer.from('Caf\xe9 Plover', 'latin1'), 'old.txt')).text, 'Caf\u00e9 Plover', 'an old Windows file is not noise');
});

test('web pages, XML, JSON and RTF read as their words', async () => {
  const html = await readFile(Buffer.from('<html><head><style>p{color:red}</style><script>var x=1</script></head><body><h1>Lease</h1><p>Rent is 1,250.</p><table><tr><td>Deposit</td><td>2,500</td></tr></table></body></html>'), 'lease.html');
  assert.equal(html.kind, 'html');
  assert.match(html.text, /Lease\nRent is 1,250\.\nDeposit\t2,500/);
  assert.doesNotMatch(html.text, /color|var x/);
  assert.equal((await readFile(Buffer.from('<?xml version="1.0"?><trip><stop>Fairhaven</stop></trip>'), 'trip.xml')).text, 'Fairhaven');
  assert.match((await readFile(Buffer.from('{"town":"Fairhaven","rooms":2}'), 'b.json')).text, /"town": "Fairhaven"/);
  const rtf = await readFile(Buffer.from('{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}{\\colortbl;\\red0;}{\\*\\generator Writer;}Caf\\\'e9 bill\\par Total \\u8364? 216\\par}', 'latin1'), 'bill.rtf');
  assert.equal(rtf.kind, 'rtf');
  assert.equal(rtf.text, 'Caf\u00e9 bill\nTotal \u20ac 216', 'escapes and Unicode, no font or colour tables');
});

test('PDFs read page by page, and scanned pages are read by their pictures', async () => {
  const pdf = await readFile(await textPdf(['Kestrel Lettings lease', 'Break clause after 12 months']), 'lease.pdf');
  assert.equal(pdf.kind, 'pdf');
  assert.equal(pdf.pages, 2);
  assert.match(pdf.text, /\[Page 1\]\nKestrel Lettings lease\n\n\[Page 2\]\nBreak clause after 12 months/);
  assert.equal(pdf.ocr, false);
  assert.equal(kindOf(await textPdf(['x']), 'photo.jpg'), 'pdf', 'what a file holds wins over its name');

  const scan = await readFile(await scannedPdf(), 'scan.pdf');
  if (scan.note && /can't read|no text/i.test(scan.note) && !scan.ocr) return console.log('# no OCR on this computer; scanned pages left unread:', scan.note);
  assert.equal(scan.ocr, true);
  assert.match(scan.text, /Kestrel Plumbing invoice 4471/);
  assert.match(scan.text, /216\.00/);
  assert.equal((await readFile(await scannedPdf(), 'scan.pdf', { ocr: false })).text, '', 'OCR can be left off');
});

test('pictures of documents, iPhone photos included, read as their words', async () => {
  for (const f of ['reader-scan.png', 'reader-scan.heic']) {
    const r = await readFile(fixture(f), f);
    assert.equal(r.kind, 'image', f);
    if (!r.ocr) { console.log(`# no OCR for ${f} here:`, r.note); continue; }
    assert.match(r.text, /Kestrel Plumbing invoice 4471/, f);
  }
});

test('Word, Excel and PowerPoint, old and new, and OpenDocument read whole and in order', async () => {
  const docx = zip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Plover Street lease</w:t></w:r></w:p><w:p><w:r><w:t>Deposit 2,500</w:t></w:r></w:p></w:body></w:document>',
  });
  const d = await readFile(docx, 'lease.docx');
  assert.equal(d.kind, 'docx');
  assert.match(d.text, /Plover Street lease\n\nDeposit 2,500/);

  // Word 97: two pieces, one stored as 8-bit text and one as UTF-16.
  const first = 'Plover Street lease\r', second = 'Caf\u00e9 deposit 2,500\r';
  const word = Buffer.alloc(0x400 + first.length + second.length * 2);
  word.writeUInt16LE(0xa5ec, 0);
  word.write(first, 0x400, 'latin1');
  u16(second).copy(word, 0x400 + first.length);
  const plc = Buffer.alloc(3 * 4 + 2 * 8);
  plc.writeUInt32LE(0, 0); plc.writeUInt32LE(first.length, 4); plc.writeUInt32LE(first.length + second.length, 8);
  plc.writeUInt32LE((0x400 * 2) | 0x40000000, 12 + 2);
  plc.writeUInt32LE(0x400 + first.length, 12 + 8 + 2);
  const clx = Buffer.concat([Buffer.from([0x02]), Buffer.alloc(4), plc]);
  clx.writeUInt32LE(plc.length, 1);
  word.writeUInt32LE(0, 0x01a2); word.writeUInt32LE(clx.length, 0x01a6);
  const doc = await readFile(cfb({ WordDocument: word, '0Table': clx }), 'old.doc');
  assert.equal(doc.kind, 'doc');
  assert.equal(doc.text, 'Plover Street lease\nCaf\u00e9 deposit 2,500');

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Item', 'Amount'], ['Boiler service', 180], ['Total', 216]]), 'Costs');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Trip', 'Fairhaven']]), 'Trips');
  for (const type of ['xlsx', 'xls', 'ods']) {
    const r = await readFile(Buffer.from(XLSX.write(book, { type: 'buffer', bookType: type === 'xls' ? 'biff8' : type })), 'costs.' + type);
    assert.equal(r.kind, type);
    assert.match(r.text, /\[Sheet: Costs\]\nItem,Amount\nBoiler service,180\nTotal,216\n\n\[Sheet: Trips\]\nTrip,Fairhaven/, type);
  }

  const slide = (t) => `<p:sld xmlns:a="a" xmlns:p="p"><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sld>`;
  const pptx = await readFile(zip({ 'ppt/presentation.xml': '<p:presentation/>', 'ppt/slides/slide10.xml': slide('Plan B: the ferry'), 'ppt/slides/slide2.xml': slide('Budget 516'), 'ppt/slides/slide1.xml': slide('Fairhaven trip'), 'ppt/notesSlides/notesSlide1.xml': slide('Bring the railcard') }), 'trip.pptx');
  assert.equal(pptx.kind, 'pptx');
  assert.equal(pptx.text, '[Slide 1]\nFairhaven trip\nNotes: Bring the railcard\n\n[Slide 2]\nBudget 516\n\n[Slide 10]\nPlan B: the ferry', 'slides in their order, with notes');

  // PowerPoint 97: a slide container holding a text atom, and a master whose sample text is left out.
  const rec = (ver, type, body) => { const h = Buffer.alloc(8); h.writeUInt16LE(ver, 0); h.writeUInt16LE(type, 2); h.writeUInt32LE(body.length, 4); return Buffer.concat([h, body]); };
  const stream = Buffer.concat([rec(0x0f, 0x03e8, Buffer.concat([
    rec(0x0f, 0x03f8, rec(0, 0x0fa0, u16('Click to edit Master title style'))),
    rec(0x0f, 0x03ee, rec(0x0f, 0xf003, rec(0, 0x0fa0, u16('Fairhaven trip')))),
    rec(0x0f, 0x03ee, rec(0, 0x0fa8, Buffer.from('Budget 516', 'latin1'))),
  ]))]);
  const ppt = await readFile(cfb({ 'PowerPoint Document': stream }), 'trip.ppt');
  assert.equal(ppt.kind, 'ppt');
  assert.equal(ppt.text, '[Slide 1]\nFairhaven trip\n\n[Slide 2]\nBudget 516');

  const odt = await readFile(zip({ mimetype: 'application/vnd.oasis.opendocument.text', 'content.xml': '<office:document-content><office:body><office:text><text:h>Plover lease</text:h><text:p>Rent 1,250</text:p></office:text></office:body></office:document-content>' }), 'lease.odt');
  assert.equal(odt.kind, 'odt');
  assert.equal(odt.text, 'Plover lease\nRent 1,250');
  assert.equal(kindOf(zip({ mimetype: 'application/vnd.oasis.opendocument.text-web', 'content.xml': '<x/>' }), 'a.odt'), 'odt', 'web and template variants too');
});

test('Pages, Numbers and Keynote read through their text storage', async () => {
  const vint = (n) => { const out = []; do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n); return Buffer.from(out); };
  const field = (f, wire, v) => Buffer.concat([vint(f * 8 + wire), wire === 2 ? Buffer.concat([vint(v.length), v]) : vint(v)]);
  const storage = (t) => Buffer.concat([field(1, 0, 0), field(3, 2, Buffer.from(t))]);
  const body = storage('Plover Street lease\u2029Rent is 1,250 a month.');
  const other = Buffer.from('not text storage');
  const archive = (type, payload) => {
    const info = Buffer.concat([field(1, 0, 1), field(2, 2, Buffer.concat([field(1, 0, type), field(3, 0, payload.length)]))]);
    return Buffer.concat([vint(info.length), info, payload]);
  };
  const raw = Buffer.concat([archive(10000, other), archive(2001, body)]);
  // Snappy, written as literal runs.
  const lit = (b) => { const out = [vint(b.length)]; for (let i = 0; i < b.length; i += 60) { const c = b.subarray(i, i + 60); out.push(Buffer.from([(c.length - 1) << 2]), c); } return Buffer.concat(out); };
  const chunk = lit(raw);
  const iwa = Buffer.concat([Buffer.from([0, chunk.length & 0xff, (chunk.length >> 8) & 0xff, chunk.length >> 16]), chunk]);
  assert.deepEqual(reader.snappy(lit(Buffer.from('Fairhaven Fairhaven'))).toString(), 'Fairhaven Fairhaven');
  assert.equal(reader.snappy(Buffer.concat([Buffer.from([19, 0x24]), Buffer.from('Fairhaven '), Buffer.from([0x15, 0x0a])])).toString(), 'Fairhaven Fairhaven', 'back-references copy earlier bytes');
  for (const kind of ['pages', 'key']) {
    const r = await readFile(zip({ 'Index/Document.iwa': iwa, 'preview.jpg': Buffer.from([0xff, 0xd8, 0xff]) }), 'lease.' + kind);
    assert.equal(r.kind, kind);
    assert.equal(r.text, 'Plover Street lease\n\nRent is 1,250 a month.');
  }
});

test('emails read with their attachments, from Apple Mail, Gmail or Outlook', async () => {
  const eml = [
    'From: Kestrel Lettings <lettings@kestrel.example>', 'To: Rowan <rowan@example.com>', 'Subject: Your lease', 'Date: Tue, 20 Oct 2026 09:00:00 +0000', 'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b1"', '', '--b1', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '',
    'The deposit is =C2=A32,500 and the break clause is at 12 months.', '--b1', 'Content-Type: text/plain; name="terms.txt"', 'Content-Disposition: attachment; filename="terms.txt"', 'Content-Transfer-Encoding: base64', '',
    Buffer.from('Pets allowed with consent.').toString('base64'), '--b1--', '',
  ].join('\r\n');
  const e = await readFile(Buffer.from(eml), 'lease.eml');
  assert.equal(e.kind, 'eml');
  assert.match(e.text, /^From: Kestrel Lettings <lettings@kestrel\.example>\nTo: Rowan <rowan@example\.com>\nDate: Tue, 20 Oct 2026 09:00:00 GMT\nSubject: Your lease\n\nThe deposit is \u00a32,500/);
  assert.match(e.text, /Attachments:\n\[terms\.txt\]\nPets allowed with consent\./);
  assert.equal(kindOf(Buffer.from(eml), 'saved-message'), 'eml', 'known by its headers without the name');

  const msg = await readFile(cfb({
    '__substg1.0_0037001F': u16('Your lease'), '__substg1.0_0C1A001F': u16('Kestrel Lettings'), '__substg1.0_0E04001F': u16('Rowan'),
    '__substg1.0_1000001F': u16('The deposit is 2,500.'),
    '__attach_version1.0_#00000000/__substg1.0_3707001F': u16('terms.txt'), '__attach_version1.0_#00000000/__substg1.0_37010102': Buffer.from('Pets allowed with consent.'),
  }), 'lease.msg');
  assert.equal(msg.kind, 'msg');
  assert.equal(msg.text, 'From: Kestrel Lettings\nTo: Rowan\nSubject: Your lease\n\nThe deposit is 2,500.\n\nAttachments:\n[terms.txt]\nPets allowed with consent.');
});

test('ebooks and zips read inside, and a zip cannot unpack without end', async () => {
  const chapter = (t) => `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>${t}</p></body></html>`;
  const epub = await readFile(zip({
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>',
    'OEBPS/book.opf': '<package><metadata><dc:title>Fairhaven guide</dc:title></metadata><manifest><item id="a" href="a.xhtml"/><item id="b" href="b.xhtml"/></manifest><spine><itemref idref="b"/><itemref idref="a"/></spine></package>',
    'OEBPS/a.xhtml': chapter('Second: the harbour.'), 'OEBPS/b.xhtml': chapter('First: the station.'),
  }), 'guide.epub');
  assert.equal(epub.kind, 'epub');
  assert.equal(epub.text, 'Fairhaven guide\n\nFirst: the station.\n\nSecond: the harbour.', 'chapters in reading order');

  const inner = zip({ 'costs.csv': 'Item,Amount\nTotal,216\n' });
  const z = await readFile(zip({ 'notes.txt': 'Plover Street', 'more/inner.zip': inner, '__MACOSX/._notes.txt': 'junk', 'tool.exe': Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x00\x00\x00\x00', 'latin1') }), 'bundle.zip');
  assert.equal(z.kind, 'zip');
  assert.match(z.text, /\[notes\.txt\]\nPlover Street/);
  assert.match(z.text, /\[more\/inner\.zip\]\n\[costs\.csv\]\nItem,Amount\nTotal,216/);
  assert.match(z.text, /\[tool\.exe: Closedhand can't read this kind of file \(\.exe\)\.\]/);
  assert.doesNotMatch(z.text, /junk/, 'Finder copies are left out');

  let nest = Buffer.from('bottom');
  for (let i = 0; i < 6; i++) nest = zip({ [`level${i}.zip`]: nest });
  assert.match((await readFile(nest, 'deep.zip')).text, /not opened, there is too much inside/, 'nesting stops');
});

test('what has no text says so in plain words, and a broken file does not throw', async () => {
  const exe = await readFile(Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x00\x00\x00\x00', 'latin1'), 'setup.exe');
  assert.equal(exe.kind, 'unknown');
  assert.equal(exe.text, '');
  assert.equal(exe.note, "Closedhand can't read this kind of file (.exe).");
  assert.equal((await readFile(Buffer.from('\x00\x00\x00\x18ftypisom\x00\x00\x00\x00', 'latin1'), 'clip.mp4')).kind, 'video');
  const broken = await readFile(Buffer.from('PK\x03\x04broken', 'latin1'), 'lease.docx');
  assert.equal(broken.text, '');
  assert.ok(broken.note);
});

test('the reader is the same file in both services, and every reader in the code is this one', () => {
  assert.equal(fs.readFileSync(path.join(root, 'lib/file-reader.js'), 'utf8'), fs.readFileSync(path.join(root, 'webapp/file-reader.js'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'scripts/vendored-manifest.json'), 'utf8'));
  assert.ok(manifest['file-reader'], 'vendored and recorded');
  const callers = ['lib/files.js', 'lib/attachments.js', 'lib/services/usi.js', 'lib/tools/handlers.js', 'lib/web-chat-ws.js', 'webapp/rag-processor.js'];
  for (const f of callers) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.doesNotMatch(src, /mammoth\.extractRawText|XLSX\.read\(|require\(["']pdf-parse["']\)|ppt\/slides\/slide/, f + ' reads files itself');
  }
});

test('File Search offers the same kinds of file it indexes', () => {
  const rag = fs.readFileSync(path.join(root, 'webapp/rag-processor.js'), 'utf8');
  const indexed = JSON.parse('[' + /const RAG_FILE_TYPES = Object\.fromEntries\(\[([\s\S]*?)\]\.map/.exec(rag)[1].replace(/,\s*$/, '') + ']');
  const page = fs.readFileSync(path.join(root, 'webapp/views/index.html'), 'utf8');
  const offered = /return \/\\\.\(([a-z0-9|]+)\)\$\/i\.test\(f\.name\);/.exec(page)[1].split('|');
  assert.deepEqual([...offered].sort(), [...indexed].sort());
  for (const kind of ['pdf', 'doc', 'pages', 'msg', 'epub', 'heic', 'zip', 'mp3', 'm4a', 'mp4', 'mov']) assert.ok(indexed.includes(kind), kind);
});
