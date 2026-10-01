const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../webapp/public/keep.js'), 'utf8');
async function mount({device = 'desktop', origin = 'https://alex.closedhand.ai', permanent = true, standalone = false, copyFails = false} = {}) {
  const nodes = new Map(), events = {}, copied = [];
  const get = id => { if (!nodes.has(id)) nodes.set(id, { hidden: true, classList: { toggle() {} } }); return nodes.get(id); };
  const data = { permanent, url: permanent ? 'https://alex.closedhand.ai/' : null, local: true, canSend: true };
  const context = { URL, setTimeout, clearTimeout, location: { origin }, navigator: {
    userAgent: device === 'iphone' ? 'iPhone' : device === 'android' ? 'Android' : 'Macintosh',
    platform: 'MacIntel', maxTouchPoints: device === 'ipad' ? 5 : 0,
    clipboard: { writeText: async value => { if (copyFails) throw new Error('Denied'); copied.push(value); } },
  }, document: { getElementById: get, querySelectorAll: () => [] }, window: {
    addEventListener: (name, fn) => events[name] = fn, matchMedia: () => ({ matches: standalone }),
  }, fetch: async () => ({ ok: true, json: async () => data }) };
  vm.runInNewContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  return { get, events, copied };
}
test('desktop highlights the URL with secondary QR and truthful bookmark guidance', async () => {
 const ui = await mount(); assert.equal(ui.get('address').textContent, 'alex.closedhand.ai');
 assert.equal(ui.get('address').href, 'https://alex.closedhand.ai/');
 assert.equal(ui.get('desktop').hidden, false); assert.equal(ui.get('qr').hidden, false);
 await ui.get('copy').onclick(); assert.deepEqual(ui.copied, ['https://alex.closedhand.ai/']);
});
for (const device of ['iphone','ipad','android']) test(device + ' shows only its own saving instructions and no self-scanning QR', async () => {
 const ui = await mount({ device });
 assert.equal(ui.get(device === 'android' ? 'android' : 'iphone').hidden, false);
 assert.equal(ui.get('desktop').hidden, true); assert.equal(ui.get('qr').hidden, true);
});
test('install action is only offered on the personal URL origin, with a browser-provided prompt', async () => {
 for (const origin of ['https://alex.closedhand.ai', 'http://localhost:3000']) {
  const ui = await mount({ origin });
  assert.equal(ui.get('install').hidden, true);
  ui.events.beforeinstallprompt({ preventDefault() {}, prompt() {}, userChoice: Promise.resolve({ outcome: 'accepted' }) });
  assert.equal(ui.get('install').hidden, origin !== 'https://alex.closedhand.ai');
 }
});
test('already installed and newly installed apps hide further install instructions', async () => {
 for (const standalone of [true,false]) {
  const ui = await mount({ standalone }); if (!standalone) ui.events.appinstalled();
  assert.equal(ui.get('installed').hidden, false); assert.equal(ui.get('desktop').hidden, true); assert.equal(ui.get('install').hidden,true);
 }
});
test('missing personal URL offers setup; clipboard denial never reports success', async () => {
 const missing = await mount({ permanent:false }); assert.equal(missing.get('ready').hidden,true); assert.equal(missing.get('setup').hidden,false);
 const denied = await mount({copyFails:true});await denied.get('copy').onclick();assert.match(denied.get('status').textContent,/Select and copy/);
});
