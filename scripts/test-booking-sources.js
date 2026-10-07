// A flight or booking card opens the email it came from, and lists the files
// that came with the booking from every email naming its reference (the
// order confirmation has the details, the airline's email has the e-ticket).
// A booking with no end time is over a few hours after it starts, so last
// night's dinner moves to Past instead of staying "upcoming".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const server = read('webapp/server.js');
const helpers = server.slice(server.indexOf('const MAIL_SOURCE ='), server.indexOf('// A file attached to an email ClosedHand keeps'));

const CACHE = [
  { source: 'gmail', external_id: 'order11', data: { subject: 'Your order', body: 'Booking QZX7KP confirmed', threadId: 'thr11', account: 'pat@example.com', attachments: [],
    webLink: 'https://mail.google.com/mail/?authuser=pat%40example.com#all/thr11' } },
  { source: 'gmail', external_id: 'airline22', data: { subject: 'Travel Reservation - QZX7KP', body: 'see attached', threadId: 'thr22', account: 'pat@example.com',
    attachments: [{ filename: 'logo.png', mimeType: 'image/png', attachmentId: 'a0', inline: true }, { filename: 'E-ticket QZX7KP.pdf', mimeType: 'application/pdf', attachmentId: 'a1', inline: false }] } },
  { source: 'outlook', external_id: 'AAMk33=', data: { subject: 'QZX7KP receipt', body: '', attachments: [{ filename: 'Receipt.pdf', mimeType: 'application/pdf', attachmentId: 'b1', inline: false }],
    webLink: 'https://outlook.office.com/owa/?ItemID=AAMk33' } },
  { source: 'imap', external_id: 'imap-7-42', data: { subject: 'Table at Rosa\'s', body: 'Booking ROSA77X', attachments: [{ filename: 'menu.pdf', mimeType: 'application/pdf', attachmentId: '0', inline: false }], webLink: null } },
  { source: 'gmail', external_id: 'evil99', data: { subject: 'phish', webLink: 'https://evil.example/login', attachments: [] } },
];
function fakeDb() {
  return { from: () => {
    const filters = [];
    const q = {
      select: () => q, eq: (c, v) => { filters.push((r) => (c === 'external_id' ? r.external_id === v : c === 'source' ? r.source === v : true)); return q; },
      ilike: (c, v) => { const needle = v.replace(/%/g, '').toLowerCase(); const key = c.split('->>')[1]; filters.push((r) => String(r.data[key] || '').toLowerCase().includes(needle)); return q; },
      limit: () => q,
      then: (ok) => ok({ data: CACHE.filter((r) => filters.every((f) => f(r))), error: null }),
    };
    return q;
  } };
}
function load(now) {
  const box = { supabase: fakeDb(), Date: { now: () => now, parse: Date.parse }, encodeURIComponent, String, Number, isNaN, crypto: require('node:crypto'), process, BOT_INTERNAL_URL: 'http://bot:3000' };
  vm.runInNewContext(helpers + '\nthis.sourceMail = sourceMail; this.bookingOver = bookingOver;', box);
  return box;
}

test('a flight opens its own email in the right account, with files from every email naming the booking', async () => {
  const sm = JSON.parse(JSON.stringify(await load(Date.now()).sourceMail('u1', { emailId: 'order11', reference: 'QZX7KP' })));
  assert.equal(sm.open_url, 'https://mail.google.com/mail/?authuser=pat%40example.com#all/thr11');
  assert.deepEqual(sm.documents.map((d) => d.name), ['E-ticket QZX7KP.pdf', 'Receipt.pdf'], 'Gmail and Outlook alike; inline pictures left out');
  assert.equal(sm.documents[0].url, '/api/mail/attachment?source=gmail&id=airline22&n=0');
  assert.equal(sm.documents[1].url, '/api/mail/attachment?source=outlook&id=AAMk33%3D&n=0');
});

test('Outlook opens in Outlook; IMAP, with no web address, opens ClosedHand\'s copy; a strange link is not trusted', async () => {
  const box = load(Date.now());
  assert.equal((await box.sourceMail('u1', { emailId: 'AAMk33=' })).open_url, 'https://outlook.office.com/owa/?ItemID=AAMk33');
  const imap = JSON.parse(JSON.stringify(await box.sourceMail('u1', { emailId: 'imap-7-42' })));
  assert.equal(imap.open_url, '/mail?source=imap&id=imap-7-42');
  assert.deepEqual(imap.documents.map((d) => d.url), ['/api/mail/attachment?source=imap&id=imap-7-42&n=0']);
  assert.equal((await box.sourceMail('u1', { emailId: 'evil99' })).open_url, '/mail?source=gmail&id=evil99');
});

test('nothing is linked when nothing is known', async () => {
  assert.equal(await load(Date.now()).sourceMail('u1', { emailId: 'nope', reference: 'ZZZZZZ' }), null);
  assert.equal(await load(Date.now()).sourceMail('u1', { emailId: '../x', reference: 'a b' }), null, 'odd ids and references are not searched');
});

test('a booking with no end is over a few hours after it starts', () => {
  const dinner = { kind: 'restaurant', starts_at: '2026-10-06T19:00:00+07:00' };
  const at = (iso) => load(Date.parse(iso)).bookingOver(dinner, Date.parse(iso));
  assert.equal(at('2026-10-06T20:30:00+07:00'), false, 'during dinner it is still on');
  assert.equal(at('2026-10-07T00:43:00+07:00'), true, 'after midnight it is over');
  const hotel = { kind: 'hotel', starts_at: '2026-10-06T14:00:00+07:00', ends_at: '2026-10-09T12:00:00+07:00' };
  assert.equal(load(0).bookingOver(hotel, Date.parse('2026-10-08T10:00:00+07:00')), false, 'a stated end wins');
});

test('the file route is behind the login, checks its inputs, asks the bot and never serves script', () => {
  const route = server.slice(server.indexOf('app.get("/api/mail/attachment"'), server.indexOf('app.get("/mail"'));
  assert.ok(server.indexOf('app.get("/api/mail/attachment"') > server.indexOf('const SIGNED_BY_BRIDGE'), 'registered after the dashboard login gate');
  assert.match(route, /if \(!userId\) return res\.status\(401\)/);
  assert.match(route, /if \(!MAIL_SOURCE\.test\(source\) \|\| !MAIL_ID\.test\(id\)/);
  assert.match(route, /await askBot\(userId, `\/internal\/mail-file\?/);
  assert.match(route, /"Content-Security-Policy": "sandbox"/);
  assert.match(route, /viewable \? type : "application\/octet-stream"/);
  const view = server.slice(server.indexOf('app.get("/mail"'), server.indexOf('app.get("/api/bookings"'));
  assert.match(view, /if \(!userId\) return res\.redirect\("\/login/);
  assert.match(view, /"Content-Security-Policy": "default-src 'none'/, 'ClosedHand\'s copy of an email runs no script');
});

test('the dashboard opens the email from the card, lists the files and moves finished bookings to Past', () => {
  const dash = read('webapp/views/dashboard.html');
  assert.match(dash, /onclick="openSourceMail\(event, this\.dataset\.mail\)" title="Open the email this came from"/);
  assert.match(dash, /if \(!url \|\| ev\.target\.closest\('a, button'\)\) return;/);
  assert.match(dash, /\(docs\.length > 2 \? '<button type="button" class="source-doc-more"/);
  assert.match(dash, /var over = rows\.filter\(function\(b\) \{ return b\.over; \}\);/);
  assert.match(dash, /<div id="recent-bookings"><\/div>/);
});
