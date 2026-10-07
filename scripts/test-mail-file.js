// The dashboard's mail files come through the bot, which fetches each the
// way its mailbox needs: Gmail and Outlook through their APIs, IMAP by
// downloading the message again. Only a request signed for this person is
// served, and only files the cached email lists (never its inline pictures).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROWS = {
  'gmail:g1234': { attachments: [{ filename: 'pic.png', mimeType: 'image/png', attachmentId: 'i0', inline: true }, { filename: 'ticket.pdf', mimeType: 'application/pdf', attachmentId: 'a1', inline: false }] },
  'outlook:AAMk=': { attachments: [{ filename: 'receipt.pdf', mimeType: 'application/pdf', attachmentId: 'o1', inline: false }] },
  'imap:imap-7-42': { attachments: [{ filename: 'menu.pdf', mimeType: 'application/pdf', attachmentId: '0', inline: false }] },
};
const fetched = [];
function stub(rel, exports) {
  const file = require.resolve(path.join(__dirname, '../lib', rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
stub('db', { supabase: { from: () => {
  const f = {};
  const q = { select: () => q, eq: (c, v) => { f[c] = v; return q; },
    maybeSingle: async () => { const d = ROWS[`${f.source}:${f.external_id}`]; return { data: d ? { data: d } : null, error: null }; } };
  return q;
} } });
stub('context', { runWithInheritedContext: (fn) => fn() });
stub('services/imap-mail', { fetchImapAttachment: async (store, id, att) => { fetched.push(['imap', id, att]); return { buffer: Buffer.from('imap-bytes') }; } });
stub('services/usi', { fetchAttachmentBuffer: async (u, source, id, att) => { fetched.push([source, id, att]); return Buffer.from(`${source}-bytes`); } });
stub('web-chat-ws', { verifyToken: (t) => (t === 'good' ? 'u1' : null) });
const userStore = require.resolve(path.join(__dirname, '../user-store'));
require.cache[userStore] = { id: userStore, filename: userStore, loaded: true, exports: { UserStore: { load: async () => ({}) } } };
const { mailFile, register } = require('../lib/mail-file');

test('each mailbox fetches its own way, and only listed files', async () => {
  assert.equal(String((await mailFile('u1', 'gmail', 'g1234', 0)).buffer), 'gmail-bytes', 'the first file, skipping the inline picture');
  assert.equal(String((await mailFile('u1', 'outlook', 'AAMk=', 0)).buffer), 'outlook-bytes');
  assert.equal(String((await mailFile('u1', 'imap', 'imap-7-42', 0)).buffer), 'imap-bytes');
  assert.deepEqual(fetched, [['gmail', 'g1234', 'a1'], ['outlook', 'AAMk=', 'o1'], ['imap', 'imap-7-42', '0']]);
  await assert.rejects(mailFile('u1', 'gmail', 'g1234', 5), (e) => e.status === 404);
  await assert.rejects(mailFile('u1', 'dropbox', 'g1', 0), (e) => e.status === 400);
  await assert.rejects(mailFile('u1', 'gmail', 'nope', 0), (e) => e.status === 404);
});

test('the bot serves a file only to a request signed for this person', async () => {
  const routes = {};
  register({ get: (p, h) => { routes[p] = h; } });
  const run = async (token) => {
    const out = { status: 200, headers: {} };
    await routes['/internal/mail-file']({ get: () => token, query: { source: 'gmail', id: 'g1234', n: '0' } },
      { status(c) { out.status = c; return this; }, json(b) { out.body = b; }, set(h) { Object.assign(out.headers, h); }, send(b) { out.sent = String(b); } });
    return out;
  };
  assert.equal((await run('bad')).status, 401);
  const ok = await run('good');
  assert.equal(ok.sent, 'gmail-bytes');
  assert.equal(ok.headers['X-File-Name'], 'ticket.pdf');
});

test('the real modules export what the bot calls (the stubs above stand in for them)', () => {
  const fs = require('node:fs');
  const exportsOf = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').match(/module\.exports = \{([\s\S]*?)\};/)[1];
  assert.match(exportsOf('lib/services/usi.js'), /\bfetchAttachmentBuffer\b/);
  assert.match(exportsOf('lib/services/imap-mail.js'), /\bfetchImapAttachment\b/);
  assert.match(exportsOf('lib/web-chat-ws.js'), /\bverifyToken\b/);
});
