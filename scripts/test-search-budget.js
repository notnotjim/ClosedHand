// A slow query embedding never holds a search: past its budget the search
// goes ahead on keywords alone.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
test('the query embedding has a budget, and the search uses it', () => {
  const usi = fs.readFileSync(path.join(__dirname, '..', 'lib', 'services', 'usi.js'), 'utf8');
  assert.match(usi, /const QUERY_EMBED_BUDGET_MS = 5000;/);
  assert.match(usi, /opts\.queryEmbedding === undefined \? embedWithinBudget\(query\) : opts\.queryEmbedding/);
  assert.match(usi, /return Promise\.race\(\[work, late\]\)/);
});
