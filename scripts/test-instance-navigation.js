const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const read = name => fs.readFileSync(require.resolve('../webapp/' + name), 'utf8');
test('plain dashboard bookmarks open the app and specific section links retain their destination', () => {
  const html = read('views/dashboard.html');
  const source = html.slice(html.indexOf('  if (window.self === window.top)'), html.indexOf('</script>', html.indexOf('  if (window.self === window.top)')));
  for (const [search, hash, expected] of [['', '', '/'], ['', '#agents', '/?dash=%23agents'], ['?task=123', '#agents', '/?dash=%3Ftask%3D123%23agents']]) {
    let result; const top = {}, window = { self: top, top, location: { search, hash, replace(value) { result = value; } } };
    vm.runInNewContext(source, { window }); assert.equal(result, expected);
  }
  vm.runInNewContext(source, { window: { self: {}, top: {}, location: { replace() { assert.fail('An embedded panel must not redirect'); } } } });
});
test('incomplete setup retains the requested app destination; completion opens only a local app route', async () => {
  const server = read('server.js'); let handler, destination, ready = false, served, claimed = false, available = true;
  const start = server.indexOf('async function setupComplete');
  vm.runInNewContext(server.slice(start, server.indexOf('// WhatsApp magic link', start)), {
    app: { get: (_, fn) => { handler = fn; } },
    require: name => name === './phone-registration' ? { status: () => ({}), serviceAvailable: async () => available } : { getSetupState: async () => ({ ready }) },
    getRuntimeConf: async key => key === 'PHONE_ADDRESS_NAME' && claimed ? 'amber-fox-42' : null,
    assets: { sendPage: (_, name) => { served = name; } },
  });
  await handler({ originalUrl: '/?dash=%23agents' }, { redirect: value => { destination = value; } });
  assert.equal(destination, '/setup?next=%2F%3Fdash%3D%2523agents');
  // Ready but no personal URL: still setup, unless closedhand.com can't give one out.
  ready = true; destination = null; served = null;
  await handler({ originalUrl: '/' }, { redirect: value => { destination = value; } });
  assert.equal(destination, '/setup'); assert.equal(served, null);
  available = false; await handler({}, {}); assert.equal(served, 'index.html', 'an outage never locks anyone out');
  available = true; claimed = true; served = null; await handler({}, {}); assert.equal(served, 'index.html');
  const setup = read('views/setup.html'); const begin = setup.indexOf('  function setupDestination()');
  const source = setup.slice(begin, setup.indexOf('  document.querySelectorAll', begin));
  for (const [next, expected] of [['/?dash=%23agents', '/?dash=%23agents'], ['//evil.example/', '/'], ['/setup', '/'], ['/\\evil.example/', '/'], ['/', '/']]) {
    const context = vm.createContext({ URL, URLSearchParams, location: { origin: 'https://instance.example', search: '?next=' + encodeURIComponent(next) } });
    vm.runInContext(source, context); assert.equal(context.setupDestination(), expected);
  }
});
