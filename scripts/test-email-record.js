// Every email ClosedHand keeps has one shape, whatever mailbox it came from,
// so everything that reads mail reads it one way. Outlook's copies used to
// lack the thread, the account, the attachment list and the web address that
// Gmail's and IMAP's had, which is why a booking from Outlook mail could not
// open its email or list its files.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { emailRecord, gmailWebLink, SHAPE } = require('../lib/services/email-record');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('Gmail, Outlook and IMAP records have exactly the same fields', () => {
  const gmail = emailRecord({ id: 'g1', threadId: 't1', account: 'pat@example.com', subject: 'Order', attachments: [{ filename: 'a.pdf', mimeType: 'application/pdf', attachmentId: 'x' }], webLink: gmailWebLink('pat@example.com', 't1') });
  const outlook = emailRecord({ id: 'AAMk=', threadId: 'conv1', account: 'pat@example.org', subject: 'Order', attachments: [{ filename: 'b.pdf', attachmentId: 'y', inline: false }], webLink: 'https://outlook.office.com/owa/?ItemID=AAMk' });
  const imap = emailRecord({ id: 'imap-7-42', subject: 'Order', attachments: [{ filename: 'c.pdf', attachmentId: 0 }], webLink: null });
  const keys = (r) => Object.keys(r).sort();
  assert.deepEqual(keys(outlook), keys(gmail));
  assert.deepEqual(keys(imap), keys(gmail));
  for (const r of [gmail, outlook, imap]) {
    assert.equal(r.shape, SHAPE);
    assert.ok(Array.isArray(r.attachments) && Array.isArray(r.labels));
    assert.equal(typeof r.attachments[0].attachmentId, 'string');
  }
  assert.equal(imap.threadId, 'imap-7-42', 'a mailbox with no threads keys a thread by the message');
  assert.equal(imap.webLink, null);
  assert.equal(gmail.webLink, 'https://mail.google.com/mail/?authuser=pat%40example.com#all/t1');
});

test('all three syncs build their records through the one shape', () => {
  const sync = read('lib/services/data-sync.js');
  assert.match(sync, /items\.push\(emailRecord\(\{\n\s*id: detail\.id,/, 'Gmail');
  assert.match(sync, /return emailRecord\(\{\n\s*id: msg\.id,\n\s*threadId: msg\.conversationId,/, 'Outlook');
  assert.match(read('lib/services/imap-mail.js'), /return require\("\.\/email-record"\)\.emailRecord\(\{/, 'IMAP');
});

test("Outlook's attachment list comes in the same request, with no file contents", () => {
  const sync = read('lib/services/data-sync.js');
  const urls = sync.match(/https:\/\/graph\.microsoft\.com\/v1\.0\/me\/mailFolders\/(inbox|sentitems)\/messages[^"]*/g);
  assert.equal(urls.length, 2);
  for (const u of urls) {
    assert.match(u, /\$expand=attachments\(\$select=id,name,contentType,size,isInline\)/);
    assert.match(u, /conversationId/);
    assert.match(u, /webLink/);
    assert.doesNotMatch(u, /contentBytes/);
  }
});

test('older cached records are brought to the shape, Outlook from its next list', () => {
  const sync = read('lib/services/data-sync.js');
  assert.match(sync, /await upgradeCachedEmails\(userId, "gmail", gmailLink\)/);
  assert.match(sync, /await upgradeCachedEmails\(userId, "gmail_" \+ acct\.slug, gmailLink\)/);
  assert.match(sync, /await upgradeCachedEmails\(userId, "imap"\)/);
  assert.match(sync, /const newItems = items\.filter\(i => !cachedIds\.has\(i\.external_id\) \|\| stale\.has\(i\.external_id\)\);/);
});
