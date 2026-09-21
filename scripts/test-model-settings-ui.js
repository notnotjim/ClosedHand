const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../webapp/public/model-settings.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
// Small DOM fixture for asynchronous state tests. Layout and native controls
// are reviewed in the browser against the real setup page.
async function mount(respond = () => ({ config: null, runtime: 'docker' })) {
  const elements = new Map(), listeners = {}, timers = new Map(), calls = [];
  let timerId = 0;
  function element(selector = '') {
    if (elements.has(selector)) return elements.get(selector);
    const node = { value: '', dataset: {}, children: [], hidden: false,
      classList: { toggle() {} }, setAttribute() {}, removeAttribute() {}, focus() {}, after() {},
      append(...children) { this.children.push(...children); }, replaceChildren() { this.children = []; },
      querySelector(s) { return element(selector + ' ' + s); },
    };
    node.parentElement = { after() {} };
    const attr = selector.match(/^\[data-(\w+)="(.*)"\]$/);
    if (attr) node.dataset[attr[1]] = attr[2];
    elements.set(selector, node); return node;
  }
  const root = element('root');
  root.querySelector = element;
  root.querySelectorAll = () => [...elements.values()];
  root.addEventListener = (event, fn) => { listeners[event] = fn; };
  const field = name => element('[data-field="' + name + '"]');
  field('visionMode').value = 'same';
  const context = { window: {}, document: { createElement: () => {
    const node = element('created-' + elements.size);
    node.dataset = new Proxy({}, { set(target, key, value) { target[key] = value; if (key === 'modelId') elements.set('[data-model-id="' + value + '"]', node); return true; } });
    return node;
  } }, URL,
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => {
      const call = { path: url.replace('/api/model-config', ''), body: options.body ? JSON.parse(options.body) : null };
      calls.push(call); const response = await respond(call, calls);
      return { ok: !response.error, json: async () => response };
    },
  };
  vm.runInNewContext(source, context); context.window.ClosedHandModels.mount(root); await tick();
  return { field, calls, result: element('.model-result'), region: name => element('[data-region="' + name + '"]'),
    action: name => element('[data-action="' + name + '"]'),
    choose(name, value) { field(name).value = value; listeners.change({ target: field(name) }); },
    type(name, value) { field(name).value = value; listeners.input({ target: field(name) }); },
    pick(name, value) { const picker = element('[data-picker="' + name + '"]'); picker.value = value; listeners.change({ target: picker }); },
    async timers() { const tasks = [...timers.values()]; timers.clear(); for (const fn of tasks) await fn(); await tick(); },
  };
}
const catalog = { models: [{ id: 'chat', capabilities: { tools: true, vision: true } }] };
function checked() { return { ticket: 'checked-ticket', config: { connections: { primary: { provider: 'openai' } }, roles: { chat: { model: 'chat', connection: 'primary' }, background: { model: 'chat', connection: 'primary' }, vision: null } } }; }
test('a failed initial load can be retried without leaving a stale error', async () => {
  const ui = await mount((_, calls) => calls.length === 1 ? { error: 'fetch failed' } : { config: null });
  assert.equal(ui.field('provider').disabled, true);
  assert.equal(ui.action('reload').hidden, false);
  assert.doesNotMatch(ui.result.textContent, /fetch failed/);
  await ui.action('reload').onclick();
  assert.equal(ui.field('provider').disabled, false);
  assert.equal(ui.action('reload').hidden, true);
  assert.equal(ui.result.textContent, '');
});
for (const [runtime, url] of [['docker', 'http://host.docker.internal:11434/v1'], ['desktop', 'http://localhost:11434/v1'], ['hosted', '']]) {
  test(runtime + ' local model connections use the correct host', async () => {
    const ui = await mount(() => ({ config: null, runtime })); ui.choose('provider', 'ollama');
    assert.equal(ui.field('baseUrl').value, url); assert.equal(ui.region('key').hidden, true);
  });
}
test('entering a key waits for Load models, including input blur', async () => {
  const ui = await mount(call => call.path === '/models' ? catalog : { config: null });
  ui.choose('provider', 'openai'); ui.type('apiKey', 'fixture'); ui.choose('apiKey', 'fixture'); await ui.timers();
  assert.equal(ui.calls.length, 1);
  await ui.action('load').onclick(); await tick();
  assert.equal(ui.calls[1].path, '/models'); assert.equal(ui.region('selection').hidden, false);
});
test('provider changes discard late model lists and clear old selections', async () => {
  let finish;
  const ui = await mount(call => call.path === '/models' ? new Promise(resolve => { finish = resolve; }) : { config: null });
  ui.choose('provider', 'openai'); ui.type('apiKey', 'fixture'); ui.action('load').onclick(); await tick();
  ui.choose('provider', 'ollama'); finish(catalog); await tick();
  assert.equal(ui.region('selection').hidden, true); assert.equal(ui.field('apiKey').value, '');
  assert.equal(ui.field('model').value, ''); assert.equal(ui.result.textContent, '');
});
test('failed catalogs leave manual model entry available', async () => {
  const ui = await mount(call => call.path === '/models' ? { error: 'fetch failed' } : { config: null });
  ui.choose('provider', 'openai'); ui.type('apiKey', 'fixture'); await ui.action('load').onclick(); await tick();
  assert.equal(ui.region('selection').hidden, false); assert.equal(ui.action('load').hidden, false);
  assert.match(ui.result.textContent, /selected model service/);
  ui.pick('model', '__manual__'); assert.equal(ui.field('model').value, '');
});
test('editing a checked connection immediately removes save, and late checks cannot restore it', async () => {
  let finish, delayed = false;
  const ui = await mount(call => call.path === '/models' ? catalog : call.path === '/check' ? (delayed ? new Promise(resolve => { finish = resolve; }) : checked()) : { config: null });
  ui.choose('provider', 'openai'); ui.type('apiKey', 'fixture'); await ui.action('load').onclick(); await tick();
  ui.choose('visionMode', 'off'); ui.pick('model', 'chat'); await ui.timers();
  assert.equal(ui.action('save').hidden, false);
  ui.type('apiKey', 'changed'); assert.equal(ui.action('save').hidden, true);
  delayed = true; ui.action('recheck').onclick(); await tick();
  ui.choose('provider', 'ollama'); finish(checked()); await tick();
  assert.equal(ui.action('save').hidden, true); assert.equal(ui.region('check').hidden, true);
});

test('saved hosted connections can be changed without entering the key again', async () => {
  let config = null;
  const verified = checked();
  verified.config.connections.primary = { provider: 'openai', baseUrl: 'https://api.openai.com/v1', hasKey: true };
  const ui = await mount(call => {
    if (call.path === '/models') return catalog;
    if (call.path === '/check') return verified;
    if (call.path === '/save') { config = verified.config; return { success: true }; }
    return { config };
  });
  ui.choose('provider', 'openai'); ui.type('apiKey', 'fixture'); ui.choose('visionMode', 'off'); ui.pick('model', 'chat'); await ui.timers();
  ui.action('save').onclick(); await tick();
  assert.equal(ui.field('apiKey').value, '');
  ui.pick('backgroundModel', 'small'); await ui.timers();
  assert.equal(ui.calls.at(-1).path, '/check'); assert.equal(ui.calls.at(-1).body.primary.useSavedKey, true);
  assert.equal(ui.action('save').hidden, false);
});
