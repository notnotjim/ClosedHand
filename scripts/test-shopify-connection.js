const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { storeDomain, exchangeCredentials, inspectShop } = require('../lib/shopify-auth');
const root = path.join(__dirname, '..');

test('store addresses accept mobile-pasted domains and reject paths, credentials and lookalikes', () => {
  assert.equal(storeDomain(' HTTPS://Example.myshopify.com/ '), 'example.myshopify.com');
  assert.equal(storeDomain('example'), 'example.myshopify.com');
  for (const value of ['', null, {}, 'example.myshopify.com.evil.test', 'example.myshopify.com/admin', 'me@example.myshopify.com', 'localhost:3000', 'example.myshopify.com?x=1']) assert.throws(() => storeDomain(value));
});
test('Shopify credentials exchange has bounded lifetime, no redirects and never echoes secrets on failure', async () => {
  let calls = 0;
  const tokens = await exchangeCredentials('example', 'client', 'secret', async (url, options) => {
    calls++;
    assert.equal(url, 'https://example.myshopify.com/admin/oauth/access_token');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal);
    assert.equal(new URLSearchParams(options.body).get('grant_type'), 'client_credentials');
    return { ok: true, json: async () => ({access_token:'token',expires_in:86400,scope:'read_orders'}) };
  });
  assert.equal(calls, 1); assert.ok(tokens.expires_at > Date.now() + 86000000);
  await assert.rejects(exchangeCredentials('example', 'client', 'secret', async () => ({ok:false,status:401,json:async()=>({error:'secret'})})), e => !e.message.includes('secret'));
  await assert.rejects(exchangeCredentials('example', 'client', 'secret', async () => ({ok:true,json:async()=>({access_token:'token'})})), /usable connection/);
});
test('connection records only Shopify-confirmed scopes, not assumed access', async () => {
  const shop = await inspectShop('example','token', async () => ({ok:true,json:async()=>({data:{shop:{name:'Fixture shop'},currentAppInstallation:{accessScopes:[{handle:'read_products'}]}}})}));
  assert.deepEqual(shop.scopes,['read_products']);
  await assert.rejects(inspectShop('example','token',async()=>({ok:true,json:async()=>({errors:[{message:'denied'}]})})), /permissions/);
});
test('Shopify dialog opens against the actual form and selects the available connection flow', () => {
  const html=fs.readFileSync(path.join(root,'webapp/views/dashboard.html'),'utf8');
  const elements=Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],{style:{},hidden:false,value:'',reset(){this.resets=(this.resets||0)+1},showModal(){this.open=true},close(){this.open=false}}]));
  for (const oauthReady of [false,true]) {
    const scope={document:{getElementById:id=>elements[id]||null},window:{_allServices:{shopify:{oauthReady}}}};
    vm.runInNewContext(html.slice(html.indexOf('    function openShopifyModal()'),html.indexOf('    function shopifyDomain()')),scope);
    scope.openShopifyModal();
    assert.equal(elements['shopify-modal'].open,true);
    assert.equal(elements['shopify-own-app'].hidden,oauthReady);
    assert.equal(elements['shopify-oauth'].hidden,!oauthReady);
    scope.closeShopifyModal();assert.equal(elements['shopify-modal'].open,false);
  }
});
test('expiring Shopify access renews once for concurrent reads and leaves other users untouched', async () => {
  let exchanges=0,saves=0;
  const auth={...require('../lib/shopify-auth'),exchangeCredentials:async()=>{exchanges++;return {access_token:'renewed',client_secret:'secret',client_id:'id',expires_at:Date.now()+86400000}}};
  const db={supabase:{from:()=>({update:()=>({eq:(key,id)=>{assert.equal(key,'user_id');assert.equal(id,'fixture-user');return {eq:async()=>{saves++;return {error:null}}}}})})}};
  const mod={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(root,'lib/services/shopify.js'),'utf8'),{module:mod,Date,URL,Buffer,require:n=>n==='../context'?{}:n==='../shopify-auth'?auth:n==='../db'?db:n==='../../crypto-tokens'?{encryptTokens:t=>t}:require(n)});
  const conn={tokens:{access_token:'expired',client_secret:'secret',client_id:'id',expires_at:1},metadata:{shopDomain:'example.myshopify.com'}};
  const store={userId:'fixture-user',connections:{shopify:conn},getConnection:()=>conn,saveConnectionTokens:async(_,t)=>{saves++;conn.tokens=t}};
  assert.deepEqual(Array.from(await Promise.all([mod.exports.freshShopifyToken(store),mod.exports.freshShopifyToken(store)])),['renewed','renewed']);
  assert.equal(exchanges,1);assert.equal(saves,1);
  const other={getConnection:()=>({tokens:{access_token:'other'}})};
  assert.equal(await mod.exports.freshShopifyToken(other),'other');assert.equal(exchanges,1);
});
test('Shopify app secret is encrypted in both service copies', () => {
  process.env.TOKEN_ENCRYPTION_KEY=require('node:crypto').randomBytes(32).toString('base64');
  for (const file of ['crypto-tokens.js','webapp/crypto-tokens.js']) {
    const crypto=require(path.join(root,file));const encoded=crypto.encryptTokens({client_secret:'fixture-secret',access_token:'token'});
    assert.ok(encoded.client_secret.startsWith('enc:v1:'));assert.equal(crypto.decryptTokens(encoded).client_secret,'fixture-secret');
  }
});
test('Shopify connection endpoint authenticates, persists encrypted data, and does not claim success on failed writes', async () => {
  const src=fs.readFileSync(path.join(root,'webapp/server.js'),'utf8');const start=src.indexOf('app.post("/api/connect-shopify-token",');
  let handler,code=200,payload,row,user='fixture-user',fail=false;
  const auth={storeDomain,exchangeCredentials:async()=>({access_token:'new',client_secret:'secret'}),inspectShop:async()=>({name:'Fixture',scopes:['read_orders']})};
  vm.runInNewContext(src.slice(start,src.indexOf('\n});',start)+4),{Date,app:{post:(_,fn)=>{handler=fn}},getUserIdFromRequest:()=>user,
    supabase:{from:()=>({upsert:async r=>{row=r;return {error:fail?{message:'failed'}:null}}})},mustWrite:async(_,q)=>{if((await q).error)throw Error('write failed')},
    require:n=>n==='./shopify-auth'?auth:{encryptTokens:t=>({access_token:'encrypted',client_secret:'encrypted'})}});
  const res={status(c){code=c;return this},json(v){payload=v}};
  await handler({body:{storeDomain:'example',clientId:'client',clientSecret:'secret'}},res);
  assert.equal(payload.success,true);assert.equal(row.user_id,user);assert.equal(row.tokens.client_secret,'encrypted');
  fail=true;await handler({body:{storeDomain:'example',accessToken:'token'}},res);assert.equal(code,400);assert.equal(payload.success,undefined);
  row=null;user=null;await handler({body:{}},res);assert.equal(code,401);assert.equal(row,null);
});
