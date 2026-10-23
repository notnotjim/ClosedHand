// A draft is found from its message id as well as its draft id: search_cache
// shows the message id first, and failing on it cost a reply six more model
// calls. Changing a draft and sending one both read it this way (liveGmailDraft).
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
  assert.doesNotMatch(after.slice(after.indexOf('\n')), /toolInput\.draft_id/);
  assert.match(after, /drafts\/\$\{encodeURIComponent\(draftId\)\}`,\n\s*\{ id: draftId,/);
  assert.match(block('gmail_send_draft'), /const \{ draftId \} = await liveGmailDraft\(googleReqFor\(account\), toolInput\.draft_id, "minimal"\);\n\s*const sent = await sendGmailDraft\(account, draftId\);/);
});
