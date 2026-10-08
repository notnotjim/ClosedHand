// Models on the person's own computer through Ollama: offered by what they
// can do, and given room to work. Ollama's model list says nothing about
// abilities and its default window is 4,096 tokens, so ClosedHand asks
// Ollama what each model does and shrinks a video's frames to fit.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const wire = require('../lib/model-wire');
const policy = require('../lib/model-policy');

test("Ollama models are listed with the abilities Ollama reports, so image models show for images", async () => {
  const realFetch = global.fetch; const asked = [];
  global.fetch = async (url, options) => {
    if (url.endsWith('/v1/models')) return { ok: true, json: async () => ({ data: [{ id: 'local-vl:2b' }, { id: 'local-text:7b' }] }) };
    asked.push(JSON.parse(options.body).model);
    return { ok: true, json: async () => ({ capabilities: JSON.parse(options.body).model === 'local-vl:2b' ? ['completion', 'vision', 'tools'] : ['completion'] }) };
  };
  try {
    const conn = policy.connection({ provider: 'ollama', baseUrl: 'http://host.docker.internal:11434/v1' });
    const models = await wire.listModels(conn);
    const cap = (id) => policy.capabilities(conn, id, models.find((m) => m.id === id).metadata);
    assert.deepEqual(asked.sort(), ['local-text:7b', 'local-vl:2b']);
    assert.equal(cap('local-vl:2b').vision, true); assert.equal(cap('local-vl:2b').tools, true);
    assert.equal(cap('local-text:7b').vision, false); assert.equal(cap('local-text:7b').tools, false);
    assert.equal(cap('local-vl:2b').video, false, 'Ollama takes pictures, not whole video');
  } finally { global.fetch = realFetch; }
});

test("a window that is too small is recognised in Ollama's wording, with its size", async () => {
  const realFetch = global.fetch, realWarn = console.warn; console.warn = () => {};
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 400, type: 'exceed_context_size_error', n_ctx: 4096, n_prompt_tokens: 4447,
    message: 'request (4447 tokens) exceeds the available context size (4096 tokens), try increasing it' } }) });
  try {
    await assert.rejects(wire.request({ backend: 'custom', provider: 'ollama', baseUrl: 'http://host.docker.internal:11434/v1', apiKey: '' }, { model: 'local-vl:2b', messages: [{ role: 'user', content: 'hi' }] }),
      (e) => e.code === 'context_length_exceeded' && e.limit === 4096 && e.used === 4447);
  } finally { global.fetch = realFetch; console.warn = realWarn; }
});

test('frames are thinned evenly, keeping the first and last', () => {
  const { spread } = require('../lib/video');
  assert.deepEqual(spread([...Array(14).keys()], 7), [0, 2, 4, 7, 9, 11, 13]);
  assert.deepEqual(spread([...Array(14).keys()], 3), [0, 7, 13]);
  assert.deepEqual(spread([1, 2], 5), [1, 2]);
});

test('a local model gets nearly five minutes and the task stays alive while it works', () => {
  const src = fs.readFileSync(path.join(__dirname, '../lib/video.js'), 'utf8');
  assert.match(src, /AbortSignal\.timeout\(isLocal\(target\.conn\) \? 290000 : 180000\)/);
  assert.match(src, /const beat = setInterval\(\(\) => progressed\(userId\), 60000\);/);
  assert.match(src, /if \(e\.code !== "context_length_exceeded"/, 'a too-small window is retried with fewer frames');
  assert.match(fs.readFileSync(path.join(__dirname, '../webapp/public/model-settings.js'), 'utf8'), /Set its context length to at least 32,000/);
});
