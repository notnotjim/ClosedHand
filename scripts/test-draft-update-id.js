// Changing a draft works when given the draft's message id: search_cache shows
// the message id first, and the failure cost a reply six more model calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const handlers = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tools', 'handlers.js'), 'utf8');
const block = handlers.slice(handlers.indexOf('case "gmail_draft_update": {'), handlers.indexOf('\n    case "', handlers.indexOf('case "gmail_draft_update": {') + 10));

test('a message id is turned into the draft that holds it', () => {
  assert.match(block, /const existing = await readDraft\(draftId\)\.catch\(async \(e\) => \{/);
  assert.match(block, /const hit = \(list\.drafts \|\| \[\]\)\.find\(\(d\) => d\.message && d\.message\.id === draftId\);/);
  assert.match(block, /draftId = hit\.id;\n\s*return readDraft\(draftId\);/);
});

test('the update and its answer use the draft id that was found', () => {
  const after = block.slice(block.indexOf('return readDraft(draftId);'));
  assert.doesNotMatch(after, /toolInput\.draft_id/);
  assert.match(after, /drafts\/\$\{encodeURIComponent\(draftId\)\}`,\n\s*\{ id: draftId,/);
});
