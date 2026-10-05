// Pulse's cheap screen: one short support-model call before the writer runs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { triage } = require('../lib/pulse-triage');
const items = ['EMAIL from alex@example.test: Please approve today\'s invoice', 'EVENT starting within 3h: Airport transfer'];

test('the support model gets the bar for the level and every item, in one short call', async () => {
  const calls = [];
  const verdict = await triage({ items, level: 'low', fallback: async (system, message, tokens) => {
    calls.push({ system, message, tokens }); return 'Sure: {"pulse": true, "flagged": ["Invoice due today"]}';
  } });
  assert.deepEqual(verdict, { pulse: true, flagged: ['Invoice due today'] });
  assert.equal(calls.length, 1);
  assert.match(calls[0].system, /Only flag what goes wrong in the next few hours/);
  assert.ok(items.every(item => calls[0].message.includes(item)));
  assert.equal(calls[0].tokens, 300);
});
test('an unreadable or empty reply means nothing to report', async () => {
  for (const raw of ['', 'no json here', '{not json', null]) {
    const verdict = await triage({ items, level: 'medium', fallback: async () => raw });
    assert.ok(!verdict.pulse && !(verdict.flagged || []).length, String(raw));
  }
});
test('an unknown level falls back to the medium bar, and nothing else is ever contacted', async () => {
  const realFetch = global.fetch; global.fetch = () => assert.fail('no network from the screen itself');
  try {
    let system = '';
    await triage({ items, level: 'loud', fallback: async s => { system = s; return '{"pulse":false,"flagged":[]}'; } });
    assert.match(system, /what a busy person would thank you for/);
  } finally { global.fetch = realFetch; }
});

test('at every level a nudge must add something the item itself did not', async () => {
  for (const level of ['low', 'medium', 'high']) {
    let system = '';
    await triage({ items, level, fallback: async (s) => { system = s; return '{"pulse":false,"flagged":[]}'; } });
    assert.match(system, /An email already told the person what it says when it arrived\. Flag an item only when a nudge would add something it did not/, level);
    assert.match(system, /A deadline weeks away is not worth a nudge on the day its email arrives\./, level);
    assert.match(system, /what the nudge adds that the item itself did not/, level);
  }
  const pulse = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'pulse.js'), 'utf8');
  assert.match(pulse, /What would this message tell \$\{userName\} that they do NOT already know, from my last message or from the email itself\?/, 'the writer asks the same question');
  assert.match(pulse, /Never list or sum up what is not worth mentioning \("everything else was routine"\)/, 'no digest of what does not matter');
});
test('the screen is told the date, so "tomorrow" and "weeks away" can be told apart', async () => {
  let message = '';
  await triage({ items, level: 'medium', now: 'Today is Monday 12 April 2027.', fallback: async (s, m) => { message = m; return '{"pulse":false,"flagged":[]}'; } });
  assert.match(message, /^Today is Monday 12 April 2027\.\n\nNew items since last check:/);
  const pulse = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'pulse.js'), 'utf8');
  assert.match(pulse, /items: triageItems, level, goals,\n\s*now: require\("\.\/timezone"\)\.nowStamp\(/);
});

// A mailing list can open "Dear Sam" and end "call me". The screen is told
// which mail went to a list, and that its "call me" is not a request.
test('mail sent to a list is marked, and the screen knows what that means', async () => {
  const { fromMailingList, sortedAsBulk } = require('../lib/pulse-triage');
  assert.equal(sortedAsBulk(['CATEGORY_PROMOTIONS', 'INBOX']), true);
  assert.equal(sortedAsBulk(['CATEGORY_UPDATES', 'INBOX']), false);
  assert.equal(sortedAsBulk(undefined), false);
  assert.equal(fromMailingList({ labels: ['CATEGORY_PROMOTIONS', 'INBOX'] }), true);
  assert.equal(fromMailingList({ labels: ['CATEGORY_SOCIAL'] }), true);
  assert.equal(fromMailingList({ labels: ['INBOX'], body: 'Dear Sam, a new flat on Mill Lane. Call me to view. You have been contacted because you registered with us.' }), true);
  assert.equal(fromMailingList({ labels: ['INBOX'], body: 'Hi, see you at 7. Can you take me off the rota?' }), false);
  assert.equal(fromMailingList({ labels: ['CATEGORY_PERSONAL', 'INBOX'], body: 'Can you confirm Saturday by tonight?' }), false);
  assert.equal(fromMailingList({}), false);
  let system = '';
  await triage({ items, level: 'medium', fallback: async (s) => { system = s; return '{"pulse":false,"flagged":[]}'; } });
  assert.match(system, /Mail marked \[mailing list\] went out to many people, however personally it is addressed/);
  assert.match(system, /A nudge that would only matter if something you do not know is true/);
  const pulse = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'pulse.js'), 'utf8');
  assert.match(pulse, /select\("external_id, data->>from, data->>subject, data->labels, data->>body"\)/);
  assert.match(pulse, /EMAIL\$\{fromMailingList\(e\) \? " \[mailing list\]" : ""\}/);
  assert.match(pulse, /its "call me" is not a request waiting on \$\{userName\}/, 'the writer holds the same line');
  assert.match(pulse, /filter\(e => !JUNK_SENDER\.test\(e\.from \|\| ""\) && !sortedAsBulk\(e\.labels\)\)/, 'what Gmail filed as bulk never reaches the screen');
});
