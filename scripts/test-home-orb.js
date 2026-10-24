// closedhand.com on phones: the smoke ring with Closedhand answering inside
// it, in place of the fist the header already shows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const home = read('closedhand-com/views/home.html');

test('the film is the smoke alone, and nothing still points at the fist film', () => {
  for (const f of ['smoke.webm', 'smoke.mov', 'smoke-poster.png']) {
    assert.ok(fs.existsSync(path.join(root, 'closedhand-com/public/orb', f)), f);
    assert.ok(home.includes('/orb/' + f), 'the page plays ' + f);
  }
  assert.doesNotMatch(home, /ring-glass/);
  assert.doesNotMatch(read('scripts/brand.py'), /ring-glass|ring-video\/fist\.svg/, 'the film is not part of a mark any more');
  assert.doesNotMatch(read('closedhand-com/tools/ring-video/film.html'), /fist/i);
});

test('it answers and it speaks first, starting where the page does, every example fitting a small ring', () => {
  const examples = vm.runInNewContext('(' + home.match(/var EXAMPLES = (\[[\s\S]*?\]);/)[1] + ')');
  assert.ok(examples.some((e) => e.ask) && examples.some((e) => e.at), 'questions answered, and messages it sends unasked');
  // Reduced motion and no script show the page's own words: the first example.
  assert.ok(home.includes('<span class="orb-ask" id="orbAsk">' + examples[0].ask + '</span><span class="orb-answer" id="orbAnswer">' + examples[0].say + '</span>'));
  for (const e of examples) {
    assert.ok((e.ask || e.at).length <= 28, 'short first line: ' + (e.ask || e.at));
    assert.ok(e.say.length <= 48, 'short reply: ' + e.say);
  }
});

test('only phones and tablets get it, it is one link to the dashboard, and it says the same in words', () => {
  assert.match(home, /<a class="orb-open handheld-only" id="orbOpen" href="\/open" aria-label="Open your Closedhand">\s*<span class="orb-stage" aria-hidden="true">/);
  assert.match(home, /<p class="orb-said handheld-only">Ask Closedhand things like/);
  assert.match(home, /if \(!smoke \|\| !link \|\| !document\.documentElement\.classList\.contains\('handheld'\)\) return;/);
  // Still for reduced motion; otherwise talking only while on screen.
  assert.match(home, /if \(still\) talk\.classList\.add\('answered'\);\n  else \{/);
  assert.match(home, /async function awake\(\) \{ while \(!onScreen \|\| document\.hidden\) await wait\(400\); \}/);
});
