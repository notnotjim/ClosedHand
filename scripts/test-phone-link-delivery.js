const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
function worker(values, linked = true, failed = false) {
  const sends = [];
  const query = { select() { return this; }, eq() { return this; }, then(ok) { return Promise.resolve({ data: linked ? [{}] : [], error: null }).then(ok); } };
  const ctx = { module: { exports: {} }, console: { warn() {} }, require: name => ({
    './config': { getConf: async k => values[k], setConf: async v => Object.assign(values, v) },
    './db': { supabase: { from: () => query } }, './admin': { getAdminUserId: () => 'owner' },
    './platforms/whatsapp-linked': { sendLinkedMessage: async (...args) => { if (failed) throw new Error('offline'); sends.push(args); } },
  })[name] };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../lib/phone-link-delivery.js'),'utf8'),ctx);
  return { deliver:ctx.module.exports.deliver,sends };
}
function initial() { return { PHONE_ACCESS: '1', PHONE_ACCESS_MODE:'managed', PHONE_PERMANENT_URL:'https://ch-fixture.closedhand.com', PHONE_LINK_DELIVERY: {id:'fixture-message',state:'pending',platform:'whatsapp_linked',chatId:'self',url:'https://ch-fixture.closedhand.com'} }; }
test('an explicit request sends its stable dashboard link once, without using a model', async () => {
  const values=initial(), w=worker(values);await w.deliver();await w.deliver();
  assert.equal(w.sends.length,1);assert.equal(w.sends[0][0],'self');assert.match(w.sends[0][1],/https:\/\/ch-fixture.closedhand.com\//);assert.equal(w.sends[0][2],'fixture-message');assert.equal(values.PHONE_LINK_DELIVERY.state,'sent');
});
test('a disconnected chat, stopped phone access, or failed send does not report success', async () => {
  for(const kind of ['unlinked','off','failure']) {
    const values=initial();if(kind==='off')values.PHONE_ACCESS='';
    const w=worker(values,kind!=='unlinked',kind==='failure');await w.deliver();
    assert.equal(w.sends.length,0);assert.equal(values.PHONE_LINK_DELIVERY.state,'error');
  }
});
test('no pending request means no message', async () => {const w=worker({});await w.deliver();assert.equal(w.sends.length,0);});
