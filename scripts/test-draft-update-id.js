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
const plainSrc = (name) => { const a = handlers.indexOf(`function ${name}(`); return handlers.slice(a, handlers.indexOf('\n}\n', a) + 2); };
const changedDraft = new Function(plainSrc('changedDraft') + '\nreturn changedDraft;')();
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
  const run = new Function('ctx', 'require', 'draftLastSeen', 'changedDraft', 'liveGmailDraft', 'gmailPlainText',
    fnSrc('draftSeenVersions') + '\nreturn async (toolInput, draftId, existing, dApi) => {\n' + check + '\nreturn "rewritten";\n};')(
    { activeUserId: 'u1' }, () => ({ supabase }), lastSeen, changedDraft,
    async () => ({ draft: { message: { payload: { mimeType: 'text/plain', body: { data: Buffer.from('Hi Mara,\nTwo racquets and a pavilion banner.').toString('base64url') } } } } }),
    (p) => Buffer.from(p.body.data, 'base64url').toString('utf8'));
  const draft = (id) => ({ message: { id } });

  // Closedhand wrote version msg-1; the person then saved msg-2 in Gmail.
  lastSeen.set('r-draft-1', 'msg-1');
  const back = await run({ draft_id: 'r-draft-1' }, 'r-draft-1', draft('msg-2'), null);
  assert.equal(back.changed_in_mailbox, true);
  assert.match(back.error, /edited in Gmail after you last saw it/);
  assert.equal(back.current_wording, 'Hi Mara,\nTwo racquets and a pavilion banner.');
  assert.match(back.error, /never tell them it did not/);
  assert.equal(await run({ draft_id: 'r-draft-1' }, 'r-draft-1', draft('msg-2'), null), 'rewritten', 'once seen, the change goes ahead');

  // Nothing written this run: the synced copy says which version was seen.
  lastSeen.clear();
  cached = [{ external_id: 'msg-1' }];
  assert.equal((await run({ draft_id: 'r-draft-1' }, 'r-draft-1', draft('msg-2'), null)).changed_in_mailbox, true, 'a copy from before the edit');
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

// Outlook keeps the draft's id and changes its changeKey on every save: the
// same check, by changeKey, from Closedhand's own write or the synced copy.
test('an Outlook draft edited since Closedhand last saw it is handed back, not overwritten', async () => {
  const caseSrc = block('outlook_draft_update');
  const lastSeen = new Map();
  let cached = null;
  const supabase = { from: () => { const q = { select: () => q, eq: () => q, limit: async () => ({ data: cached }) }; return q; } };
  const patches = [];
  let live = { id: 'AAMk-1', isDraft: true, changeKey: 'ck-2', body: { contentType: 'html', content: '<p>Hi Mara,</p><p>Two racquets and a pavilion banner.</p>' } };
  const msApi = async (method, url, body) => { if (method === 'PATCH') { patches.push(body); return { changeKey: 'ck-3' }; } return live; };
  const run = new Function('ctx', 'require', 'draftLastSeen', 'changedDraft', 'isMicrosoftConnected', 'draftAccountFor', 'microsoftReqFor', 'liveOutlookMessage', 'outlookWording', 'outlookRecipients',
    fnSrc('draftSeenVersions') + '\nreturn async (toolInput) => { switch ("outlook_draft_update") {\n' + caseSrc + '\n} };')(
    { activeUserId: 'u1' }, (m) => (m === 'cheerio' ? require('cheerio') : { supabase }), lastSeen, changedDraft, () => true, async () => 'ops@kestrelpadel.example', () => msApi,
    (api, id) => api('GET', id),
    new Function('require', plainSrc('outlookWording') + '\nreturn outlookWording;')((m) => require(m)),
    (text) => String(text).split(',').map((address) => ({ emailAddress: { address: address.trim() } })));

  lastSeen.set('AAMk-1', 'ck-1');
  const back = await run({ draft_id: 'AAMk-1', body: 'Hi Mara, two racquets.' });
  assert.equal(back.changed_in_mailbox, true, JSON.stringify(back));
  assert.equal(back.current_wording, 'Hi Mara,\nTwo racquets and a pavilion banner.');
  assert.match(back.error, /edited in Outlook after you last saw it/);
  assert.equal(patches.length, 0, 'nothing overwritten');
  const done = await run({ draft_id: 'AAMk-1', body: 'Hi Mara,\nTwo racquets, a pavilion banner and balls.' });
  assert.equal(done.success, true);
  assert.deepEqual(patches[0], { body: { contentType: 'Text', content: 'Hi Mara,\nTwo racquets, a pavilion banner and balls.' } }, 'only the wording changes');
  assert.equal(lastSeen.get('AAMk-1'), 'ck-3', 'its own write is what it saw');

  lastSeen.clear(); cached = [{ external_id: 'AAMk-1', version: 'ck-1' }];
  assert.equal((await run({ draft_id: 'AAMk-1', body: 'x' })).changed_in_mailbox, true, 'a synced copy from before the edit');
  live = { ...live, isDraft: false };
  assert.match((await run({ draft_id: 'AAMk-1', body: 'x' })).error, /already been sent/);
});

test('every mailbox has the same three draft tools, and each send asks first', () => {
  const defs = require('../lib/tools/definitions').INTERNAL_TOOLS.map((t) => t.name);
  for (const name of ['gmail_create_draft', 'gmail_draft_update', 'gmail_send_draft', 'outlook_create_draft', 'outlook_draft_update', 'outlook_send_draft', 'create_mail_draft', 'update_mail_draft', 'send_mail_draft'])
    assert.ok(defs.includes(name), name);
  const conf = fs.readFileSync(path.join(__dirname, '..', 'lib', 'confirmation.js'), 'utf8');
  const ACTIONS_NEEDING_CONFIRMATION = conf.slice(conf.indexOf('const ACTIONS_NEEDING_CONFIRMATION = ['), conf.indexOf('];', conf.indexOf('const ACTIONS_NEEDING_CONFIRMATION'))).match(/"[a-z_]+"/g).map((s) => s.slice(1, -1));
  const { DRAFT_SEND_TOOLS, MAIL_SEND_TOOLS } = require('../lib/send-gate');
  for (const name of ['gmail_send_draft', 'outlook_send_draft', 'send_mail_draft']) {
    assert.ok(ACTIONS_NEEDING_CONFIRMATION.includes(name) && DRAFT_SEND_TOOLS.has(name) && MAIL_SEND_TOOLS.has(name), name);
    assert.match(block(name), /draftAccountFor|imapDraftUid/, `${name} finds the draft it sends`);
  }
  assert.match(plainSrc('describeDraft'), /outlook_send_draft[\s\S]*describeOutlookDraft[\s\S]*send_mail_draft[\s\S]*describeImapDraft/);
  assert.match(block('outlook_send_draft'), /if \(!live\.isDraft\) return \{ error: "That draft has already been sent\. Nothing was sent again\." \};/);
  // Synced Outlook drafts carry their id and version, and leave the copy once sent.
  const sync = fs.readFileSync(path.join(__dirname, '..', 'lib', 'services', 'data-sync.js'), 'utf8');
  assert.match(sync, /mailFolders\/drafts\/messages\?\$top=100&\$select=[^"]*changeKey/);
  assert.match(sync, /draft_id: draft \? msg\.id : null,\n\s*version: draft \? msg\.changeKey \|\| null : null,/);
  assert.match(sync, /if \(!draftData\.failed && !draftData\["@odata\.nextLink"\]\) await reconcileDeletedDrafts\(userId, sourceTag,/);
});
