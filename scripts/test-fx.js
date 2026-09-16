const { test } = require('node:test');
const assert = require('node:assert/strict');
const fx = require('../lib/fx');
test('amounts convert through the limit currency, and stay put when it is the same', async () => {
  fx._setRatesForTests({ USD: 1, GBP: 0.75, VND: 25000 });
  assert.equal(await fx.convert(20, 'GBP', 'GBP'), 20);
  assert.equal(Math.round(await fx.convert(300000, 'VND', 'GBP')), 9, '300,000 dong is about nine pounds');
  assert.equal(Math.round(await fx.convert(45, 'GBP', 'USD')), 60, 'forty-five pounds is sixty dollars');
  assert.equal(await fx.convert(10, 'XXX', 'GBP'), null, 'an unknown currency cannot be compared');
});
test('no rates means no answer, never a guess', async () => {
  fx._setRatesForTests(null);
  const real = require('../lib/http').httpGet;
  require('../lib/http').httpGet = async () => { throw new Error('offline'); };
  try { assert.equal(await fx.convert(10, 'USD', 'GBP'), null); }
  finally { require('../lib/http').httpGet = real; }
});
