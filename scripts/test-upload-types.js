// A file sent to Closedhand is checked by what it holds, never by its name or
// the type the sender's app declared. A kind Closedhand does not open, or one
// named as another kind, is refused in plain words, before anything stores
// or reads it: from the web chat, a chat app or an email.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REFUSED, checkFile, acceptChatFile } = require('../lib/upload-types');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const bytes = (...parts) => Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, 'latin1'))));
const PNG = bytes('\x89PNG\r\n\x1a\n', Buffer.alloc(24, 1));
const JPEG = bytes('\xff\xd8\xff\xe0', Buffer.alloc(24, 2));
const GIF = bytes('GIF89a', Buffer.alloc(24, 3));
const WEBP = bytes('RIFF\x10\x00\x00\x00WEBPVP8 ', Buffer.alloc(16, 4));
const PDF = bytes('%PDF-1.7\n1 0 obj\n<< >>\nendobj\n');
const DOCX = bytes('PK\x03\x04', Buffer.alloc(26), '[Content_Types].xml', Buffer.alloc(8), 'word/document.xml');
const XLSX = bytes('PK\x03\x04', Buffer.alloc(26), '[Content_Types].xml', Buffer.alloc(8), 'xl/workbook.xml');
const ZIP = bytes('PK\x03\x04', Buffer.alloc(26), 'holiday/photos.txt');
const OLE = bytes('\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1', Buffer.alloc(24));
const MP4 = bytes('\x00\x00\x00\x18ftypisom', Buffer.alloc(16));
const HEIC = bytes('\x00\x00\x00\x18ftypheic', Buffer.alloc(16));
const WEBM = bytes('\x1a\x45\xdf\xa3', Buffer.alloc(16));
const OGG = bytes('OggS', Buffer.alloc(16));
const MP3 = bytes('ID3\x04\x00', Buffer.alloc(16));
const WAV = bytes('RIFF\x10\x00\x00\x00WAVEfmt ', Buffer.alloc(16));
const EXE = bytes('MZ\x90\x00\x03\x00\x00\x00', Buffer.alloc(32));
const ELF = bytes('\x7fELF\x02\x01\x01', Buffer.alloc(32));
const TEXT = Buffer.from('Quarterly totals for the Brightwater bakery\nflour,12\nsugar,7\n');

test('each kind Closedhand opens is told by its contents and keeps its name', () => {
  const cases = [
    [PNG, 'photo.png', 'image/png'], [JPEG, 'IMG_0001.JPG', 'image/jpeg'], [GIF, 'wave.gif', 'image/gif'], [WEBP, 'pic.webp', 'image/webp'],
    [PDF, 'invoice.pdf', 'application/pdf'], [DOCX, 'letter.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    [XLSX, 'budget.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], [OLE, 'old.doc', 'application/x-cfb'], [OLE, 'old.xls', 'application/x-cfb'],
    [MP4, 'clip.mp4', 'video/mp4'], [MP4, 'memo.m4a', 'video/mp4'], [WEBM, 'clip.webm', 'video/webm'], [OGG, 'voice.oga', 'audio/ogg'],
    [MP3, 'song.mp3', 'audio/mpeg'], [WAV, 'take.wav', 'audio/wav'],
    [TEXT, 'totals.csv', 'text/plain'], [TEXT, 'notes.md', 'text/plain'], [TEXT, 'script.py', 'text/plain'], [Buffer.alloc(0), 'empty.txt', 'text/plain'],
  ];
  for (const [buf, name, type] of cases) {
    const found = checkFile(buf, name);
    assert.equal(found.ok, true, name);
    assert.equal(found.type, type, name);
    assert.equal(found.ext, name.split('.').pop().toLowerCase(), name);
  }
  assert.deepEqual(checkFile(PNG, 'clipboard'), { ok: true, type: 'image/png', ext: 'png' }, 'no extension: the contents decide');
  assert.equal(checkFile(PNG, 'mislabelled.jpg').type, 'image/png', 'one image kind named as another is still an image');
});

test('a file that is not a kind Closedhand opens, or is named as another kind, is refused', () => {
  const refused = [
    [EXE, 'setup.exe'], [EXE, 'invoice.pdf'], [EXE, 'notes.txt'], [EXE, 'photo'], [ELF, 'run'],
    [PNG, 'notes.txt'], [PDF, 'photo.png'], [JPEG, 'report.pdf'], [TEXT, 'photo.jpg'], [TEXT, 'tool.exe'], [TEXT, 'drawing.svg'],
    [ZIP, 'archive.zip'], [ZIP, 'letter.docx'], [DOCX, 'budget.xlsx'], [HEIC, 'photo.heic'], [HEIC, 'clip.mp4'],
    [bytes('plain words', Buffer.alloc(1), 'more'), 'notes.txt'], [bytes('\x01\x02\x03\x04\x05\x06', 'abc'), 'data.csv'],
  ];
  for (const [buf, name] of refused) assert.deepEqual(checkFile(buf, name), { ok: false }, name);
  assert.deepEqual(checkFile('not a buffer', 'notes.txt'), { ok: false });
  assert.equal(REFUSED, "Closedhand can't open that kind of file.");
});

test('a chat file must be what the platform took it for, and is stored as what it is', () => {
  const image = { isImage: true, fileName: 'image.png', ext: 'png', mediaType: 'image/jpeg', buffer: PNG };
  assert.equal(acceptChatFile(image), true);
  assert.equal(image.mediaType, 'image/png', 'the declared type is replaced by the real one');
  assert.equal(acceptChatFile({ isImage: true, fileName: 'image.png', buffer: PDF }), false);
  assert.equal(acceptChatFile({ isImage: true, fileName: 'scan.pdf', mediaType: 'image/png', buffer: PDF }), false, 'a PDF the browser called an image');
  assert.equal(acceptChatFile({ isPdf: true, fileName: 'scan.pdf', base64: PDF.toString('base64') }), true);
  assert.equal(acceptChatFile({ isText: true, fileName: 'notes.txt', buffer: EXE }), false);
  const set = { isMultiImage: true, isImage: true, fileName: 'images_2.jpg', images: [{ base64: JPEG.toString('base64'), mediaType: 'image/png' }, { base64: WEBP.toString('base64') }] };
  assert.equal(acceptChatFile(set), true);
  assert.deepEqual(set.images.map((i) => i.mediaType), ['image/jpeg', 'image/webp']);
  assert.equal(acceptChatFile({ isMultiImage: true, isImage: true, images: [{ base64: JPEG.toString('base64') }, { base64: PDF.toString('base64') }] }), false);
});

test('every way a file comes in is checked before it is kept', () => {
  const engine = read('lib/engine.js');
  const queued = engine.slice(engine.indexOf('function queuedAsk('), engine.indexOf('const run = async () => {', engine.indexOf('function queuedAsk(')));
  assert.ok(queued.indexOf('uploads.acceptChatFile(fileData)') > 0, 'queuedAsk checks the file');
  assert.ok(queued.indexOf('uploads.acceptChatFile(fileData)') < queued.indexOf('isBugReport(userMessage)'), 'before /bug can keep it');
  assert.match(queued, /if \(!uploads\.acceptChatFile\(fileData\)\) \{[\s\S]{0,200}?return uploads\.REFUSED;/);
  for (const f of ['lib/web-chat-ws.js', 'lib/platforms/telegram.js', 'lib/platforms/whatsapp.js', 'lib/platforms/whatsapp-linked.js', 'lib/platforms/discord.js']) {
    assert.doesNotMatch(read(f), /saveAttachment\(/, `${f} keeps no file before queuedAsk`);
  }
  const telegram = read('lib/platforms/telegram.js');
  assert.match(telegram, /if \(!supportedTypes\.includes\(fileData\.ext\)\) \{[\s\S]{0,200}?sendMessage\(chatId, require\("\.\.\/upload-types"\)\.REFUSED\);\s*return;/);
  const email = read('lib/assistant-email.js');
  const remember = email.slice(email.indexOf('async function remember('), email.indexOf('async function processMessage('));
  assert.ok(remember.indexOf('uploads.checkFile(buffer, file.filename)') < remember.indexOf('uploadFile('), 'email: checked before it is stored');
  assert.match(remember, /if \(!kind\.ok\) \{ attachmentTexts\.push\('\[Attachment: ' \+ file\.filename \+ '\]\\n' \+ uploads\.REFUSED\); continue; \}/);
  assert.match(remember, /uploadFile\(account\.user_id, id, buffer, kind\.type\)/);
});

test('the web chat offers only kinds Closedhand opens', () => {
  const accept = read('webapp/views/index.html').match(/id="fileInput" multiple accept="([^"]+)"/)[1].split(',');
  const opens = /^\.(jpg|jpeg|png|gif|webp|pdf|docx|xlsx|pptx|doc|xls|mp4|m4v|mov|m4a|webm|ogg|oga|opus|mp3|wav|avi|flac|aac|txt|md|csv|json|html|htm|xml|js|py|ts|css|sql|sh|yaml|yml|log|rtf)$/;
  for (const kind of accept) assert.ok(opens.test(kind) || ['image/*', 'video/*', 'audio/*'].includes(kind), kind);
});
