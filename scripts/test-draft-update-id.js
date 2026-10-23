// A draft is found from its message id as well as its draft id: search_cache
// shows the message id first, and failing on it cost a reply six more model
// calls. Changing a draft and sending one both read it this way (liveGmailDraft).
// A draft saved again in Gmail since Closedhand last saw it is not rewritten
// from the older wording: the person's edit would be wiped without a word.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const handlers = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tools', 'handlers.js'), 'utf8');
const fnSrc = (name) => { const a = handlers.indexOf(`async function ${name}(`); return handlers.slice(a, handlers.indexOf('\n}\n', a) + 2); };
const liveGmailDraft = new Function(fnSrc('liveGmailDraft') + '\nreturn liveGmailDraft;')();
const block = (name) => handlers.slice(handlers.indexOf(`case "${name}": {`), handlers.indexOf('\n    case "', handlers.indexOf(`case "${name}": {`) + 10));

function fakeGmail() {
  const calls = [];
  const api = async (method, url) => {
    calls.push(url);
    if (url.includes('/drafts/r-draft-1?')) return { id: 'r-draft-1', message: { id: 'msg-77', raw: 'x' } };
    if (url.includes('/drafts?maxResults')) return { drafts: [{ id: 'r-draft-1', message: { id: 'msg-77' } }] };
    throw new Error('404 Not Found');
  };
  return { api, calls };
}

test('a draft id reads the draft straight away', async () => {
  const { api, calls } = fakeGmail();
  const { draftId, draft } = await liveGmailDraft(api, 'r-draft-1');
  assert.equal(draftId, 'r-draft-1'); assert.equal(draft.message.id, 'msg-77'); assert.equal(calls.length, 1);
});

test('a message id is turned into the draft that holds it', async () => {
  const { api } = fakeGmail();
  const { draftId } = await liveGmailDraft(api, 'msg-77');
  assert.equal(draftId, 'r-draft-1');
  await assert.rejects(liveGmailDraft(api, 'msg-nothing'), /404/);
});

test('changing a draft and sending one both use the draft id that was found', () => {
  const update = block('gmail_draft_update');
  assert.match(update, /const \{ draftId, draft: existing \} = await liveGmailDraft\(dApi, toolInput\.draft_id\);/);
  const after = update.slice(update.indexOf('liveGmailDraft('));
  assert.doesNotMatch(after.slice(after.indexOf('\n')), /encodeURIComponent\(toolInput\.draft_id\)|id: toolInput\.draft_id/, 'writes go to the draft found');
  assert.match(after, /drafts\/\$\{encodeURIComponent\(draftId\)\}`,\n\s*\{ id: draftId,/);
  assert.match(block('gmail_send_draft'), /const \{ draftId \} = await liveGmailDraft\(googleReqFor\(account\), toolInput\.draft_id, "minimal"\);\n\s*const sent = await sendGmailDraft\(account, draftId\);/);
});

test('a draft edited in Gmail since Closedhand last saw it is handed back, not overwritten', async () => {
  const start = handlers.indexOf('        const live = existing.message.id;');
  const check = handlers.slice(start, handlers.indexOf('\n        let raw = ', start));
  const lastSeen = new Map();
  let cached = null;
  const supabase = { from: () => { const q = { select: () => q, eq: () => q, limit: async () => ({ data: cached }) }; return q; } };
  const run = new Function('ctx', 'require', 'draftLastSeen', 'liveGmailDraft', 'gmailPlainText',
    fnSrc('draftSeenVersions') + '\nreturn async (toolInput, draftId, existing, dApi) => {\n' + check + '\nreturn "rewritten";\n};')(
    { activeUserId: 'u1' }, () => ({ supabase }), lastSeen,
    async () => ({ draft: { message: { payload: { mimeType: 'text/plain', body: { data: Buffer.from('Hi Mara,\nTwo racquets and a pavilion banner.').toString('base64url') } } } } }),
    (p) => Buffer.from(p.body.data, 'base64url').toString('utf8'));
  const draft = (id) => ({ message: { id } });

  // Closedhand wrote version msg-1; the person then saved msg-2 in Gmail.
  lastSeen.set('r-draft-1', 'msg-1');
  const back = await run({ draft_id: 'r-draft-1' }, 'r-draft-1', draft('msg-2'), null);
  assert.equal(back.changed_in_gmail, true);
  assert.equal(back.current_wording, 'Hi Mara,\nTwo racquets and a pavilion banner.');
  assert.match(back.error, /never tell them it did not/);
  assert.equal(await run({ draft_id: 'r-draft-1' }, 'r-draft-1', draft('msg-2'), null), 'rewritten', 'once seen, the change goes ahead');

  // Nothing written this run: the synced copy says which version was seen.
  lastSeen.clear();
  cached = [{ external_id: 'msg-1' }];
  assert.equal((await run({ draft_id: 'r-draft-1' }, 'r-draft-1', draft('msg-2'), null)).changed_in_gmail, true, 'a copy from before the edit');
  lastSeen.clear();
  cached = [{ external_id: 'msg-2' }];
  assert.equal(await run({ draft_id: 'r-draft-1' }, 'r-draft-1', draft('msg-2'), null), 'rewritten', 'a copy that has the edit');
  lastSeen.clear();
  cached = [{ external_id: 'msg-1' }];
  assert.equal(await run({ draft_id: 'msg-2' }, 'r-draft-1', draft('msg-2'), null), 'rewritten', 'naming the live version means it was seen');
  cached = null;
  assert.equal(await run({ draft_id: 'r-draft-1' }, 'r-draft-1', draft('msg-9'), null), 'rewritten', 'nothing known, nothing to compare');

  // What Closedhand saves is what it has seen.
  assert.match(block('gmail_draft_update'), /const saved = result\.message\?\.id \|\| \(await liveGmailDraft\(dApi, draftId, "minimal"\)\)\.draft\?\.message\?\.id;\n\s*if \(saved\) draftLastSeen\.set\(draftId, saved\);/);
  assert.match(block('gmail_create_draft'), /if \(result\.messageId\) draftLastSeen\.set\(result\.draftId, result\.messageId\);/);
  assert.match(fnSrc('createGmailDraft'), /return \{ draftId: draft\.id, messageId: draft\.message\?\.id \};/);
  const defs = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tools', 'definitions.js'), 'utf8');
  assert.match(defs, /A draft in search_cache is a copy that can be a few minutes behind Gmail[^"]*never tell them their edit did not save\. Sending it is gmail_send_draft, and only when the person says to send\."/);
});
