// A change ClosedHand made to a booking is written straight to it, with where
// it moved from, and shows on the dashboard card.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const row = { id: 'b1', user_id: 'u', title: 'Harbour Grill', starts_at: '2026-10-09T11:30:00.000Z', status: 'confirmed', details: { guests: 2 } };
let written = null;
const supabase = { from: () => {
  let mode = 'select', patch = null; const q = {
    select() { return q; }, eq() { return q; }, maybeSingle() { return Promise.resolve({ data: { ...row }, error: null }); },
    update(p) { mode = 'update'; patch = p; return q; },
    then(res) { if (mode === 'update') written = patch; return Promise.resolve({ data: null, error: null }).then(res); } };
  return q; } };
stub('../lib/db', { supabase });
stub('../lib/llm', { getInternalClient: () => ({}) });
stub('../lib/services/data-access', { searchCache: async () => ({ results: [] }) });
stub('../lib/model-wire', { responseText: () => '' });
const { recordChange } = require('../lib/bookings');

test('a moved table keeps where it moved from', async () => {
  const r = await recordChange('u', { id: 'b1', starts_at: '2026-10-09T19:00:00+07:00', note: 'Moved on Google Reserve' });
  assert.equal(r.success, true);
  assert.equal(r.moved_from, '2026-10-09T11:30:00.000Z');
  assert.equal(written.starts_at, '2026-10-09T12:00:00.000Z');
  assert.equal(written.details.moved_from, '2026-10-09T11:30:00.000Z');
  assert.equal(written.details.guests, 2, 'other details kept');
  assert.equal(written.details.change_note, 'Moved on Google Reserve');
  assert.ok(written.details.changed_by_closedhand);
});

test('bad input is refused with a reason, a cancellation is recorded', async () => {
  assert.match((await recordChange('u', {})).error, /id/);
  assert.match((await recordChange('u', { id: 'b1', starts_at: '2026-10-09T19:00' })).error, /UTC offset/);
  assert.match((await recordChange('u', { id: 'b1', status: 'maybe' })).error, /confirmed or cancelled/);
  written = null;
  assert.equal((await recordChange('u', { id: 'b1', status: 'cancelled' })).status, 'cancelled');
  assert.equal(written.status, 'cancelled');
});

test('the tool exists, chat and agents are told to use it, the card shows the move', () => {
  const root = path.join(__dirname, '..');
  assert.match(fs.readFileSync(path.join(root, 'lib', 'tools', 'definitions.js'), 'utf8'), /name: "booking_update"/);
  assert.match(fs.readFileSync(path.join(root, 'lib', 'tools', 'handlers.js'), 'utf8'), /case "booking_update": \{\n\s*const \{ recordChange \} = require\("\.\.\/bookings"\);/);
  for (const f of ['engine.js', 'agents.js']) assert.match(fs.readFileSync(path.join(root, 'lib', f), 'utf8'), /record it with booking_update straight away/, f);
  const dash = fs.readFileSync(path.join(root, 'webapp', 'views', 'dashboard.html'), 'utf8');
  assert.match(dash, /<span class="booking-moved">moved from ' \+ escHtml\(movedFrom\)/);
  assert.match(dash, /if \(b\.reference\) details\.push/);
  assert.match(dash, /var showProvider = b\.provider && String\(b\.provider\)\.trim\(\)\.toLowerCase\(\) !== String\(b\.title\)\.trim\(\)\.toLowerCase\(\);/);
  assert.match(dash, /const field = \(label, v\) => \{ if \(v \|\| soon\)/);
});

test('a change ClosedHand made stands against an older email, and a newer email wins', () => {
  const { keepOwnChange } = require('../lib/booking-identity');
  const old = { starts_at: '2026-11-03T12:00:00.000Z', ends_at: null, status: 'confirmed', details: { changed_by_closedhand: '2026-11-02T20:00:00.000Z', moved_from: '2026-11-03T11:30:00.000Z' } };
  const fromEmail = { starts_at: '2026-11-03T11:30:00.000Z', ends_at: null, status: 'confirmed', title: 'Harbour Grill, table for 2' };
  const kept = keepOwnChange(fromEmail, old, 'Mon, 02 Nov 2026 07:00:00 +0000');
  assert.equal(kept.starts_at, '2026-11-03T12:00:00.000Z', 'the older confirmation does not undo the move');
  assert.equal(kept.title, undefined, 'nor does it rename it');
  assert.equal(keepOwnChange({ ...fromEmail, provider: 'Harbour Grill' }, old, '').provider, 'Harbour Grill', 'other fields still come from the email');
  assert.equal(keepOwnChange(fromEmail, old, '').starts_at, '2026-11-03T12:00:00.000Z', 'an email of unknown date does not undo it either');
  const later = { ...fromEmail, status: 'cancelled' };
  assert.equal(keepOwnChange(later, old, 'Tue, 03 Nov 2026 09:00:00 +0000').status, 'cancelled', 'an email sent after the change wins');
  assert.equal(keepOwnChange(fromEmail, { ...old, details: {} }, '').starts_at, '2026-11-03T11:30:00.000Z', 'without a change of its own, the email decides');
});

test('the scan applies it to every match', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'bookings.js'), 'utf8');
  assert.match(src, /const merged = keepOwnChange\(mergeInto\(r, hit\), hit, sentAt\.get\(r\)\);/);
});
