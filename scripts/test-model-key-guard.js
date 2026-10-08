// An API key typed where a model ID goes must never reach a provider as the
// model name: providers repeat the name in their error, so the key would land
// with the wrong company and in ClosedHand's own log. The form refuses it, the
// code that talks to providers refuses it again, and anything key-shaped in a
// provider's error is hidden before it is logged.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const wire = require('../lib/model-wire');

// Invented keys in each provider's format; none is real.
const KEYS = ['xai-' + 'Ab3'.repeat(28), 'sk-proj-' + 'a1B_'.repeat(12), 'sk-ant-api03-' + 'x9Y'.repeat(30), 'gsk_' + 'Zz9'.repeat(17), 'AIzaSy' + 'q1W-'.repeat(9), 'Qx7'.repeat(11)];
const MODEL_IDS = ['deepseek-v4-pro', 'grok-4-0709', 'claude-opus-5-5', 'gpt-4o-2024-08-06', 'gemini-2.5-pro', 'llama3.1:8b',
  'meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-VL-72B-Instruct', 'hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M',
  'ft:gpt-4o-mini-2024-07-18:my-org:custom:9a8b7c6d', 'anthropic.claude-3-5-sonnet-20241022-v2:0', 'accounts/fireworks/models/llama-v3p1-405b-instruct'];

function formLooksLikeKey() {
  const src = fs.readFileSync(path.join(__dirname, '../webapp/public/model-settings.js'), 'utf8');
  const fn = src.slice(src.indexOf('function looksLikeKey(text) {'), src.indexOf('var KEY_AS_MODEL'));
  const box = {};
  vm.runInNewContext(fn + '\nthis.looksLikeKey = looksLikeKey;', box);
  return box.looksLikeKey;
}

test('keys in every common format are caught, and real model IDs are not', () => {
  const form = formLooksLikeKey();
  for (const id of MODEL_IDS) {
    assert.equal(wire.looksLikeKey(id), false, id);
    assert.equal(form(id), false, 'form: ' + id);
  }
  for (const key of KEYS) {
    assert.equal(wire.looksLikeKey(key), true, key.slice(0, 8));
    assert.equal(form(key), true, 'form: ' + key.slice(0, 8));
  }
});

test('a key given as the model is refused before anything is sent', async () => {
  const realFetch = global.fetch; let sent = 0;
  global.fetch = async () => { sent++; throw new Error('should not be called'); };
  try {
    await assert.rejects(wire.request({ backend: 'openai', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k' }, { model: KEYS[0], messages: [{ role: 'user', content: 'hi' }] }),
      (e) => e.code === 'model_id_is_key' && /didn't send it anywhere/.test(e.message));
    assert.equal(sent, 0);
  } finally { global.fetch = realFetch; }
});

test("a provider error that repeats a key is logged with the key hidden", async () => {
  const realFetch = global.fetch, realWarn = console.warn; const logged = [];
  const own = 'own-' + 'Rk4'.repeat(12);
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: `you passed ${KEYS[1]} with ${own} (request_id: 154e6055-eebc-4095)` } }) });
  console.warn = (line) => logged.push(String(line));
  try {
    await assert.rejects(wire.request({ backend: 'openai', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: own }, { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }] }));
  } finally { global.fetch = realFetch; console.warn = realWarn; }
  assert.equal(logged.length, 1);
  assert.doesNotMatch(logged[0], /Ab3|a1B_|Rk4/);
  assert.match(logged[0], /request_id: 154e6055-eebc-4095/, 'what diagnoses the error is kept');
});

test('a model ID the provider does not list gets a plain explanation, not a bare status', async () => {
  const wirePath = require.resolve('../webapp/model-wire');
  const realWire = require(wirePath);
  require.cache[wirePath].exports = { ...realWire,
    listModels: async () => [{ id: 'deepseek-v4-pro' }],
    request: async () => { throw Object.assign(new Error('The model provider returned HTTP 400. Check the model, access and balance.'), { status: 400 }); } };
  delete require.cache[require.resolve('../webapp/model-config')];
  try {
    const { prepare } = require('../webapp/model-config');
    await assert.rejects(prepare({ primary: { provider: 'deepseek', apiKey: 'k' }, model: 'deepseek-v9' }, {}),
      /doesn't list a model with that ID/);
  } finally { require.cache[wirePath].exports = realWire; delete require.cache[require.resolve('../webapp/model-config')]; }
});

test('the form stops a key in the image model ID before checking, and says where keys go', async () => {
  const src = fs.readFileSync(path.join(__dirname, 'test-model-settings-ui.js'), 'utf8');
  const mountSrc = src.slice(src.indexOf('const source ='), src.indexOf("const catalog ="));
  const box = { require, fs, vm, URL, setImmediate, Promise, JSON, Map, Proxy, console };
  vm.runInNewContext(mountSrc + '\nthis.mount = mount;', box);
  const ui = await box.mount((call) => call.path === '/models' ? { models: [{ id: 'chat', capabilities: { tools: true, vision: true } }] } : { config: null });
  ui.choose('provider', 'deepseek'); ui.type('apiKey', 'chat-key'); await ui.timers();
  ui.pick('model', 'chat');
  ui.choose('visionMode', 'separate');
  ui.pick('visionModel', '__manual__'); ui.type('visionModel', KEYS[0]); await ui.timers();
  assert.equal(ui.calls.filter((c) => c.path === '/check').length, 0, 'nothing was checked, so nothing was sent');
  const rows = ui.region('check-rows').children.map((n) => n.textContent);
  const images = rows[rows.indexOf('Images') + 1];
  assert.match(images, /looks like an API key/);
  assert.match(images, /choose it under Provider/);
  assert.ok(!rows.join(' ').includes(KEYS[0]), 'the key is not repeated back');
});

test("a model the saved setup already checked with an image is listed as reading images", async () => {
  const wirePath = require.resolve('../webapp/model-wire');
  const realWire = require(wirePath);
  require.cache[wirePath].exports = { ...realWire, listModels: async () => [{ id: 'flash-chat', metadata: {} }, { id: 'other-chat', metadata: {} }] };
  delete require.cache[require.resolve('../webapp/model-config')];
  const settings = { model_config: { version: 1, connections: { primary: { provider: 'deepseek', backend: 'custom', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k' } },
    roles: { chat: { connection: 'primary', model: 'flash-chat', capabilities: { tools: true, vision: true } }, background: { connection: 'primary', model: 'flash-chat' }, vision: { connection: 'primary', model: 'flash-chat', capabilities: { vision: true } } } } };
  try {
    const routes = {};
    require('../webapp/model-config').install({ get() {}, post: (p, h) => { routes[p] = h; } }, {
      authorize: async () => 'u1',
      supabase: { from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { settings }, error: null }) }) }) }) } });
    let body;
    await routes['/api/model-config/models']({ body: { connection: 'primary', primary: { provider: 'deepseek', useSavedKey: true } } }, { json: (b) => { body = b; }, status() { return this; }, set() { return this; } });
    assert.ok(body.models, JSON.stringify(body));
    const vision = Object.fromEntries(body.models.map((m) => [m.id, m.capabilities.vision]));
    assert.equal(vision['flash-chat'], true);
    assert.equal(vision['other-chat'], null, 'an unchecked model stays unknown');
  } finally { require.cache[wirePath].exports = realWire; delete require.cache[require.resolve('../webapp/model-config')]; }
});
