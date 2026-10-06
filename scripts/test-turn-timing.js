// Every reply logs where its time went, so a slow one explains itself.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { start } = require('../lib/turn-timing');

test('the line groups repeated steps and puts the biggest first', async () => {
  const t = start();
  t.add('model', 1600); t.add('recall', 4800); t.add('model', 900);
  assert.equal(await t.time('tool search_cache', Promise.resolve(7)), 7);
  const line = t.line();
  assert.match(line, /^\[Turn\] \d+\.\ds: recall 4\.8s, model 2x 2\.5s \(1\.6 0\.9\), tool search_cache 0\.\ds$/);
  assert.match(start().line('(asking to confirm)'), /^\[Turn\] 0\.0s \(asking to confirm\): no timed steps$/);
});

test('the reply loop times recall, model calls, tools and checks, and queues log their wait', () => {
  const engine = fs.readFileSync(path.join(__dirname, '..', 'lib', 'engine.js'), 'utf8');
  for (const label of ['"recall"', '"model"', '"tool " + block.name', '"check: asked for"', '"check: figures"', '"compress"']) assert.ok(engine.includes('timing.time(' + label), label);
  assert.match(engine, /saveStore\(\);\n\s*console\.log\(timing\.line\(\)\);/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'lib', 'context.js'), 'utf8'), /\[Queue\] waited/);
});
