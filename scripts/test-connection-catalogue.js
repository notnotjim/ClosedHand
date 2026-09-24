const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const vm=require('node:vm');
process.env.TOKEN_ENCRYPTION_KEY=crypto.randomBytes(32).toString('base64');
const {createCatalogue}=require('../webapp/connection-catalogue');
function fixture(){
 const rows={connection_clients:[],connections:[],user_mcps:[]};let fail=false;
 const db={from(table){const filters=[];let single=false,write;
   const q={select(){return q},eq(k,v){filters.push([k,v]);return q},maybeSingle(){single=true;return q},upsert(v){write=v;return q},
    then(ok,bad){if(fail)return Promise.resolve({error:{message:'database unavailable'}}).then(ok,bad);
     if(write){const i=rows[table].findIndex(r=>r.user_id===write.user_id&&r.service===write.service);if(i>=0)rows[table][i]=write;else rows[table].push(write);}
     const found=rows[table].filter(r=>filters.every(([k,v])=>r[k]===v));
     return Promise.resolve({data:single?found[0]||null:found,error:null}).then(ok,bad);
    }};return q;}};
 const services={google:{name:'Google',isSignup:true,clientId:'global',clientSecret:'global-secret'},microsoft:{name:'Microsoft',isSignup:true,scopes:['Mail.ReadWrite']},notion:{name:'Notion'},shopify:{name:'Shopify',needsStoreDomain:true},meta_ads:{name:'Meta Ads'},github:{name:'GitHub'},slack:{name:'Slack',isChatPlatform:true}};
 const catalogue=createCatalogue({db,services,userId:r=>r.user,baseUrl:'https://fixture.example'});
 const handlers={};catalogue.register({get:(p,f)=>handlers['GET '+p]=f,put:(p,f)=>handlers['PUT '+p]=f});
 async function call(method,user,body={},service='microsoft'){let code=200,data;const res={set(){},status(c){code=c;return this},json(v){data=v;return this}};await handlers[method]({user,body,params:{service}},res);return {code,data};}
 return {rows,catalogue,call,setFail:v=>fail=v};
}
test('catalogue exposes setup routes without credentials and keeps account state scoped',async()=>{
 const f=fixture();f.rows.connections.push({user_id:'a',service:'microsoft_extra_example'});f.rows.user_mcps.push({user_id:'b',server_url:'https://mcp.notion.com/mcp',status:'connected'});
 const a=(await f.call('GET /api/connection-catalogue','a')).data.services;
 assert.equal(a.find(s=>s.key==='microsoft').connected,true);
 assert.equal(a.find(s=>s.key==='meta_ads').mode,'setup');
 assert.equal(a.find(s=>s.key==='notion').mode,'mcp');
 assert.equal(a.find(s=>s.key==='notion').connected,false);
 assert.equal(a.find(s=>s.key==='shopify').mode,'shopify');
 assert.equal(a.some(s=>s.key==='slack'),false);
 const b=(await f.call('GET /api/connection-catalogue','b')).data.services;
 assert.equal(b.find(s=>s.key==='notion').connected,true);
 assert.equal(b.find(s=>s.key==='microsoft').connected,false);
 assert.equal(JSON.stringify(a).includes('global-secret'),false);
});
test('saving client credentials encrypts them and does not expose them to another owner',async()=>{
 const f=fixture();
 const r=await f.call('PUT /api/connection-catalogue/:service/client','a',{clientId:'client-a',clientSecret:'private-a'});
 assert.equal(r.code,200);assert.equal(r.data.redirectUrl,'/auth/microsoft?extra=1');
 assert.ok(f.rows.connection_clients[0].client_secret.startsWith('enc:v1:'));assert.equal(f.rows.connection_clients[0].client_secret.includes('private-a'),false);
 assert.equal((await f.catalogue.resolve('microsoft','a')).clientSecret,'private-a');
 assert.equal((await f.catalogue.resolve('microsoft','b')).clientSecret,undefined);
 const list=await f.call('GET /api/connection-catalogue','a');assert.equal(list.data.services.find(s=>s.key==='microsoft').mode,'oauth');
 assert.equal(JSON.stringify(list).includes('private-a'),false);assert.equal(JSON.stringify(list).includes('client-a'),false);
});
test('authentication, malformed input and write failures cannot claim a configured connection',async()=>{
 const f=fixture();
 assert.equal((await f.call('GET /api/connection-catalogue',null)).code,401);
 assert.equal((await f.call('PUT /api/connection-catalogue/:service/client',null,{clientId:'c',clientSecret:'s'})).code,401);
 for(const value of ['',{},'bad\nvalue','x'.repeat(4097)]){
  assert.equal((await f.call('PUT /api/connection-catalogue/:service/client','a',{clientId:'client',clientSecret:value})).code,400);
 }
 assert.equal(f.rows.connection_clients.length,0);f.setFail(true);
 const failed=await f.call('PUT /api/connection-catalogue/:service/client','a',{clientId:'c',clientSecret:'s'});
 assert.equal(failed.code,503);assert.equal(failed.data.redirectUrl,undefined);
 await assert.rejects(f.catalogue.resolve('microsoft','a'),/Could not read/);
});
test('OAuth callback rejects a state issued for a different service before exchanging anything',async()=>{
 const src=fs.readFileSync(require.resolve('../webapp/server.js'),'utf8');
 const start=src.indexOf('app.get("/auth/:service/callback"');
 const end=src.indexOf('// Exchange auth code',start);
 let handler,exchanged=false,redirect;
 vm.runInNewContext(src.slice(start,end),{app:{get:(_,fn)=>handler=fn},SERVICES:{github:{}},consumeOAuthState:()=>({service:'gitlab'}),exchangeOAuthCode:()=>{exchanged=true},console});
 await handler({params:{service:'github'},query:{code:'code',state:'state'}},{redirect:x=>redirect=x});
 assert.equal(exchanged,false);assert.equal(redirect,'/dashboard?error=invalid_state');
});

