// Places go into the person's own Google Maps lists the way they would do it
// themselves, in the sandbox browser where they signed in to Google: Google
// has no other way to write to saved lists. Invented places and lists only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const lib = (f) => path.join(__dirname, '../lib', f);

const runs = [];
let answer = (args) => ({ ok: true, results: args.places.map((q, i) => ({ query: q, found: q.split(',')[0], address: 'Somewhere', url: 'https://www.google.com/maps/search/?api=1&query=x', status: i === 0 ? 'saved_new_list' : 'saved' })) });
function stub(rel, exports) { const file = require.resolve(lib(rel)); require.cache[file] = { id: file, filename: file, loaded: true, exports }; }
stub('sandbox.js', {
  ensureSandbox: async () => {},
  sandboxExec: async (u, lang, code) => {
    const args = JSON.parse(Buffer.from(code.match(/b64decode\("([^"]+)"\)/)[1], 'base64').toString());
    runs.push(args);
    return { stdout: 'CLOSEDHAND_MAPS ' + JSON.stringify(answer(args)) };
  },
});
stub('config.js', { dashboardBase: async () => 'https://amber-fox-42.closedhand.ai' });
const touched = [];
stub('user-mutex.js', { touchMutexProgress: (u) => touched.push(u) });
const { saveToList, PER_RUN } = require('../lib/maps-lists');

test('places are saved in runs short enough for the sandbox, under one list name', async () => {
  runs.length = 0;
  const places = Array.from({ length: 8 }, (_, i) => ({ name: `Cafe ${i}`, area: 'Testville' }));
  const r = await saveToList({ userId: 'u1', list: '  Testville from the vlog  ', places: [...places, { name: 'Cafe 0', area: 'Testville' }] });
  assert.deepEqual(runs.map((a) => a.places.length), [PER_RUN, 8 - PER_RUN], 'repeats are dropped and runs stay short');
  assert.ok(runs.every((a) => a.list === 'Testville from the vlog'));
  assert.equal(r.saved.length, 8);
  assert.match(r.where, /open Saved, then the list "Testville from the vlog"/);
});

test('not signed in to Google says where to sign in, plainly', async () => {
  answer = () => ({ ok: false, kind: 'signin' });
  await assert.rejects(saveToList({ userId: 'u1', list: 'Trip', places: ['Cafe 1, Testville'] }),
    (e) => e.userFacing && /sign in there once, at https:\/\/amber-fox-42\.closedhand\.ai\/#computers/.test(e.message));
});

test('places it cannot find or save are reported, not hidden', async () => {
  answer = (args) => ({ ok: true, results: [{ query: args.places[0], status: 'not_found' }, { query: args.places[1], status: 'failed', error: 'timeout' }, { query: args.places[2], found: 'C', status: 'already_saved' }] });
  const r = await saveToList({ userId: 'u1', list: 'Trip', places: ['A, X', 'B, X', 'C, X'] });
  assert.deepEqual(r.not_found, ['A, X']); assert.deepEqual(r.failed, ['B, X']);
  assert.equal(r.saved[0].already, true);
});

test('the list name fits Google Maps and an empty request is refused', async () => {
  runs.length = 0;
  answer = (args) => ({ ok: true, results: [{ query: args.places[0], status: 'not_found' }] });
  await saveToList({ userId: 'u1', list: 'x'.repeat(60), places: ['A'] });
  assert.equal(runs[0].list.length, 40);
  await assert.rejects(saveToList({ userId: 'u1', list: '', places: ['A'] }), /name/);
  await assert.rejects(saveToList({ userId: 'u1', list: 'Trip', places: [] }), /no places/);
});

test('list names are read past the icon Google puts before them', { skip: !hasPython() }, () => {
  const out = execFileSync('python3', ['-c', `
import importlib.util, json
spec = importlib.util.spec_from_file_location("m", ${JSON.stringify(lib('maps-list-sandbox.py'))}); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps([m.list_title("\\ue896\\nWeekend in Testville\\nPrivate · 3 places"), m.list_title("Favorites\\nPrivate · 2 places")]))`]).toString();
  assert.deepEqual(JSON.parse(out), ['Weekend in Testville', 'Favorites']);
});

test('the tool is offered with the maps tools and the script checks for a Google sign-in first', () => {
  const def = require('../lib/tools/definitions').INTERNAL_TOOLS.find((t) => t.name === 'maps_save_list');
  assert.deepEqual(def.groups, ['maps']);
  const script = fs.readFileSync(lib('maps-list-sandbox.py'), 'utf8');
  assert.ok(script.indexOf('if not names & GOOGLE_SESSION') < script.indexOf('context.new_page()'), 'nothing is opened before the sign-in is confirmed');
  assert.match(script, /hl=en/, 'Maps in English, so the steps read the same buttons in any browser language');
});

function hasPython() { try { execFileSync('python3', ['--version']); return true; } catch { return false; } }

test('a run that hands places back is carried on until every place is done', async () => {
  runs.length = 0;
  answer = (args) => ({ ok: true, results: [{ query: args.places[0], found: 'x', status: 'saved' }], left: args.places.slice(1) });
  const r = await saveToList({ userId: 'u1', list: 'Trip', places: ['A, X', 'B, X', 'C, X'] });
  assert.equal(runs.length, 3, 'one place per run when Maps is slow');
  assert.deepEqual(r.saved.map((s) => s.asked), ['A, X', 'B, X', 'C, X']);
  assert.ok(runs.every((a) => a.budget === 60));
});

test('each run counts as progress, so a long list keeps a background task alive', async () => {
  touched.length = 0;
  answer = (args) => ({ ok: true, results: [{ query: args.places[0], found: 'x', status: 'saved' }], left: args.places.slice(1) });
  await saveToList({ userId: 'u1', list: 'Trip', places: ['A, X', 'B, X'] });
  assert.deepEqual(touched, ['u1', 'u1']);
});

test('a place Google only has under another name is asked about, not saved', async () => {
  answer = (args) => ({ ok: true, results: [{ query: args.places[0], status: 'unsure', google_has: ['Other Bakery'] }] });
  const r = await saveToList({ userId: 'u1', list: 'Trip', places: ['Pastry Corner, Testville'] });
  assert.deepEqual(r.unsure, [{ asked: 'Pastry Corner, Testville', google_has: ['Other Bakery'] }]);
  assert.equal(r.saved.length, 0);
});

test('a browser that does not answer says what to do, instead of hanging', async () => {
  answer = () => ({ ok: false, kind: 'browser' });
  await assert.rejects(saveToList({ userId: 'u1', list: 'Trip', places: ['A, X'] }), (e) => e.userFacing && /isn't responding/.test(e.message));
  assert.match(fs.readFileSync(lib('maps-list-sandbox.py'), 'utf8'), /connect_over_cdp\(.*timeout=30000\)/);
});

test('names are matched before saving: spelling variants pass, other places do not', { skip: !hasPython() }, () => {
  const pairs = [['Pastry Corner, Testville', 'Pastry Corner - Bakery', true], ['Ginjinha do Largo', 'Ginginha do Largo', true], ["Sam Cafe, Testville", "Sam's Café", true],
    ['the old mill, Testville', 'The Old Mill', true], ['Pastry Corner, Testville', 'Other Bakery', false], ['Taco Wharf', 'Burrito Factory', false]];
  const out = execFileSync('python3', ['-c', `
import importlib.util, json
spec = importlib.util.spec_from_file_location("m", ${JSON.stringify(lib('maps-list-sandbox.py'))}); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps([m.same_place(a, f) for a, f in ${JSON.stringify(pairs.map(([a, f]) => [a, f]))}]))`]).toString();
  assert.deepEqual(JSON.parse(out), pairs.map((p) => p[2]));
});
