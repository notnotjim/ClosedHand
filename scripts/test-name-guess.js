// A name the setup scan guessed goes when the person chooses a different
// one, and the scan's other notes are filed under the chosen name.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { plan, correct } = require('../lib/name-guess');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const scan = (value, subject) => JSON.stringify({ value, category: 'profile', subject, source: 'setup scan' });
const rows = () => [
  { key: 'profile-name', value: scan('Robbie Lane', 'Robbie Lane'), subject: 'Robbie Lane' },
  { key: 'profile-email', value: scan('robbie.lane@example.com', 'Robbie Lane'), subject: 'Robbie Lane' },
  { key: 'partner', value: JSON.stringify({ value: 'Ana is married to Robbie Lane', subject: 'Ana Ruiz' }), subject: 'Ana Ruiz' },
];

test('a contradicted guess goes and the scan notes move to the chosen name', () => {
  assert.deepEqual(plan(rows(), 'Robert'), { remove: ['profile-name'], refile: ['profile-email'], guessed: 'Robbie Lane' });
});

test('nothing changes when the first names agree, or the name was not a scan guess', () => {
  assert.deepEqual(plan(rows(), 'robbie').remove, []);
  const told = [{ key: 'profile-name', value: JSON.stringify({ value: 'Robbie Lane' }), subject: 'Robbie Lane' }];
  assert.deepEqual(plan(told, 'Robert').remove, [], 'a name the person gave is not a guess');
  assert.deepEqual(plan([], 'Robert').remove, []);
});

test('correct removes the note and its recall copy, and refiles in the table and in memory', async () => {
  const data = rows(); const deleted = []; const updated = []; const vectors = [];
  const db = { from: () => {
    const q = { op: 'select', select() { return q; }, delete() { q.op = 'delete'; return q; }, update(v) { q.op = 'update'; q.v = v; return q; },
      eq(k, v) { q[k] = v; return q; },
      then(res) { if (q.op === 'delete') deleted.push(q.key); if (q.op === 'update') updated.push([q.key, q.v]); return Promise.resolve(q.op === 'select' ? { data } : {}).then(res); } };
    return q; } };
  const store = { facts: { 'profile-name': { value: 'Robbie Lane' }, 'profile-email': { value: 'robbie.lane@example.com', subject: 'Robbie Lane' } } };
  const out = await correct({ db, userId: 'u1', chosen: 'Robert', store, removeVector: async (u, k) => vectors.push(k) });
  assert.deepEqual(out, { removed: 1, refiled: 1 });
  assert.deepEqual(deleted, ['profile-name']);
  assert.deepEqual(vectors, ['profile-name']);
  assert.equal(updated[0][0], 'profile-email');
  assert.equal(updated[0][1].subject, 'Robert');
  assert.equal(JSON.parse(updated[0][1].value).subject, 'Robert');
  assert.equal(store.facts['profile-name'], undefined);
  assert.equal(store.facts['profile-email'].subject, 'Robert');
});

test('every place a name is chosen runs it', () => {
  assert.match(read('webapp/server.js'), /await require\("\.\/name-guess"\)\.correct\(\{ db: supabase, userId, chosen: name,/);
  assert.match(read('lib/tools/handlers.js'), /await require\("\.\.\/name-guess"\)\.correct\(\{ db: supabase, userId, chosen: toolInput\.preferred_name,/);
  const onboarding = read('lib/onboarding.js');
  assert.match(onboarding, /await saveProfileSetting\("preferred_name", user\);\n\s*await correctNameGuess\(userId, user\);/, 'the answer at setup');
  assert.match(onboarding, /if \(chosen\) await correctNameGuess\(userId, chosen, userStore\);/, 'a scan that finishes after the answer');
});
