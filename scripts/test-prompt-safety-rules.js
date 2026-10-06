// Rules that protect everyone's mail reach everyone. "Never guess an email
// address" and "never send when asked for a draft" sat inside the Mac Bridge
// block, so people without the Bridge never got them. And the prompt names
// only tools and things that exist.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const engine = fs.readFileSync(path.join(__dirname, '../lib/engine.js'), 'utf8');
const definitions = fs.readFileSync(path.join(__dirname, '../lib/tools/definitions.js'), 'utf8');

test('the mail safety rules sit outside the Mac Bridge block', () => {
  const start = engine.indexOf('if (ctx.bridgeConnected) {\n    prompt += `\nMAC BRIDGE:');
  assert.ok(start > 0, 'the Bridge block exists');
  const end = engine.indexOf('`;\n  }\n', start);
  const rules = engine.indexOf('EMAIL SAFETY RULES:');
  assert.ok(rules > end, 'the rules come after the Bridge block closes');
  assert.equal(engine.split('EMAIL SAFETY RULES:').length, 2, 'stated once');
  assert.match(engine.slice(end, rules + 400), /NEVER guess or construct email addresses[\s\S]*NEVER send when the user asks for a draft/);
});

// What the model reads: code comments never reach it.
const spoken = (src) => src.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');

test('no tool, code name or old name that does not exist here', () => {
  for (const stale of ['Sentinel', 'Save a note to remind yourself', "_last-thread-nudge", 'cloud workspace']) {
    assert.ok(!spoken(engine).includes(stale), `engine.js: ${stale}`);
    assert.ok(!spoken(definitions).includes(stale), `definitions.js: ${stale}`);
  }
  assert.match(engine, /Email comes ONLY from connected mail accounts \(Gmail, Outlook or IMAP\)/);
});
