const test = require('node:test');
const assert = require('node:assert/strict');
const { publicAddress, parsePublicURL, serviceURLAllowed, publicLookup } = require('../lib/workspace-network');

test('Workspace internet requests exclude private, metadata, mapped and reserved addresses', () => {
  for (const value of ['127.0.0.1','127.1.2.3','0.0.0.0','10.1.1.1','100.64.0.1','169.254.169.254','172.16.4.1','192.168.64.1','198.18.1.1','192.0.2.1','224.0.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1','2002:7f00:1::']) assert.equal(publicAddress(value), false, value);
  for (const value of ['1.1.1.1','8.8.8.8','2606:4700:4700::1111','2001:4860:4860::8888']) assert.equal(publicAddress(value), true, value);
  for (const value of ['file:///etc/passwd','http://127.1/','http://0x7f000001/','http://[::ffff:7f00:1]/','http://example.com:5432/','https://user:pass@example.com/','https://foo.localhost/']) assert.throws(() => parsePublicURL(value), undefined, value);
});

test('DNS results must all be public before any connection is made', async () => {
  await assert.rejects(publicLookup('fixture.example', async () => [{address:'127.0.0.1',family:4}]), /private/);
  await assert.rejects(publicLookup('fixture.example', async () => [{address:'8.8.8.8',family:4},{address:'192.168.64.1',family:4}]), /private/);
  assert.deepEqual(await publicLookup('fixture.example', async () => [{address:'8.8.8.8',family:4}]), [{address:'8.8.8.8',family:4}]);
});

test('saved service credentials can only be sent to the selected provider', () => {
  for (const [service,url] of [['google','https://gmail.googleapis.com/gmail/v1/users/me/messages'],['slack','https://slack.com/api/conversations.list'],['whatsapp','https://graph.facebook.com/v22.0/messages'],['shopify','https://example.myshopify.com/admin/api/products.json']]) assert.equal(serviceURLAllowed(service,url),true);
  for (const service of ['google','slack','whatsapp','meta','shopify']) {
    assert.equal(serviceURLAllowed(service,'https://attacker.example/'),false,service);
    assert.equal(serviceURLAllowed(service,'https://www.googleapis.com.attacker.example/'),false,service);
  }
  assert.equal(serviceURLAllowed('google','http://www.googleapis.com/'),false);
  assert.equal(serviceURLAllowed('google','https://www.googleapis.com:8443/'),false);
  assert.equal(serviceURLAllowed('google','https://www.googleapis.com@attacker.example/'),false);
});
