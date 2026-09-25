const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const APP='00000000-0000-0000-0000-00000000c105';
process.env.CLOSEDHAND_MICROSOFT_APP_ID=APP;
const app=require('../lib/microsoft-app');
const idToken=tid=>'x.'+Buffer.from(JSON.stringify({tid})).toString('base64url')+'.y';

test('a sign-in renews at the directory it came from',()=>{
 assert.equal(app.authorityFor(idToken(app.PERSONAL_ACCOUNTS_TENANT)),'consumers');
 assert.equal(app.authorityFor(idToken('11111111-2222-4333-8444-555555555555')),'11111111-2222-4333-8444-555555555555');
 assert.equal(app.authorityFor(idToken('../evil')),'common');
 assert.equal(app.authorityFor('not a token'),'common');
 assert.equal(app.authorityFor(undefined),'common');
});

test('public sign-ins renew without a secret; own-app sign-ins keep theirs',()=>{
 process.env.MICROSOFT_CLIENT_ID='env-app';process.env.MICROSOFT_CLIENT_SECRET='env-secret';
 const pub=app.refreshRequest({refresh_token:'r',client_id:APP,public_client:true,authority:'consumers'},'Mail.Send');
 assert.deepEqual(pub,{authority:'consumers',body:{grant_type:'refresh_token',refresh_token:'r',scope:'Mail.Send',client_id:APP}});
 const own=app.refreshRequest({refresh_token:'r',client_id:'mine',client_secret:'s'});
 assert.equal(own.body.client_secret,'s');assert.equal(own.body.client_id,'mine');assert.equal(own.authority,'common');
 const old=app.refreshRequest({refresh_token:'r'});
 assert.equal(old.body.client_id,'env-app');assert.equal(old.body.client_secret,'env-secret');
 delete process.env.MICROSOFT_CLIENT_ID;delete process.env.MICROSOFT_CLIENT_SECRET;
 assert.equal(app.refreshRequest({refresh_token:'r'}),null);
});

function harness(tokenReplies,{allow=true}={}){
 const calls=[];let connected=null;
 global.fetch=async(url,opts)=>{
  const body=Object.fromEntries(new URLSearchParams(opts.body));calls.push({url,body});
  if(url.endsWith('/devicecode'))return new Response(JSON.stringify({device_code:'dc-1',user_code:'ABCD1234',verification_uri:'https://microsoft.com/devicelogin',interval:5,expires_in:900}));
  const next=tokenReplies.shift();
  if(next instanceof Error)throw next;
  return new Response(JSON.stringify(next));
 };
 const routes={};
 delete require.cache[require.resolve('../webapp/microsoft-device')];
 require('../webapp/microsoft-device').register({post:(p,f)=>routes[p]=f},{
  requireAccess:async(req,res)=>{if(!allow){res.status(401).json({error:'Login required'});return false;}return true;},
  connect:async tokens=>{connected=tokens;return {email:'person@outlook.com'};},
 });
 async function call(p){let code=200,data;const res={set(){},status(c){code=c;return this;},json(v){data=v;return this;}};await routes[p]({},res);return {code,data};}
 return {calls,call,connected:()=>connected};
}

test('code sign-in hands back the code, waits, then saves a public sign-in',async()=>{
 const h=harness([{access_token:'a',refresh_token:'r',expires_in:3600,id_token:idToken(app.PERSONAL_ACCOUNTS_TENANT)}]);
 const start=await h.call('/api/setup/microsoft/start');
 assert.deepEqual(start.data,{code:'ABCD1234',url:'https://microsoft.com/devicelogin'});
 assert.equal(h.calls[0].body.client_id,APP);assert.match(h.calls[0].body.scope,/offline_access/);assert.equal(h.calls[0].body.client_secret,undefined);
 const again=await h.call('/api/setup/microsoft/start');
 assert.equal(again.data.code,'ABCD1234');assert.equal(h.calls.length,1,'a second click shows the same code');
 const done=await h.call('/api/setup/microsoft/check');
 assert.deepEqual(done.data,{connected:true,email:'person@outlook.com'});
 const t=h.connected();
 assert.equal(t.public_client,true);assert.equal(t.client_id,APP);assert.equal(t.authority,'consumers');assert.equal(t.client_secret,undefined);
 assert.equal((await h.call('/api/setup/microsoft/check')).data.idle,true);
});

test('a waiting sign-in is checked no faster than Microsoft allows',async()=>{
 const h=harness([{error:'authorization_pending'}]);
 await h.call('/api/setup/microsoft/start');
 assert.deepEqual((await h.call('/api/setup/microsoft/check')).data,{pending:true});
 assert.deepEqual((await h.call('/api/setup/microsoft/check')).data,{pending:true},'too soon: no second request');
 assert.equal(h.calls.length,2);
});

test('a cancelled sign-in is reported and clears the code; an offline check keeps it',async()=>{
 const h=harness([new Error('offline'),{error:'authorization_declined'}]);
 await h.call('/api/setup/microsoft/start');
 assert.deepEqual((await h.call('/api/setup/microsoft/check')).data,{pending:true});
 const started=Date.now;Date.now=()=>started()+6000;
 try{
  const declined=await h.call('/api/setup/microsoft/check');
  assert.equal(declined.code,400);assert.match(declined.data.error,/cancelled/);
  assert.equal((await h.call('/api/setup/microsoft/check')).data.idle,true);
 }finally{Date.now=started;}
 assert.equal(h.connected(),null);
});

test('the sign-in routes are closed without the dashboard password',async()=>{
 const h=harness([],{allow:false});
 assert.equal((await h.call('/api/setup/microsoft/start')).code,401);
 assert.equal((await h.call('/api/setup/microsoft/check')).code,401);
 assert.equal(h.calls.length,0);
});

test('Microsoft without an own app goes to the setup page, and setup accepts Google or Microsoft',()=>{
 const server=fs.readFileSync(path.join(__dirname,'../webapp/server.js'),'utf8');
 assert.match(server,/serviceKey === "microsoft" && !\(svc\?\.clientId && svc\?\.clientSecret\) && require\("\.\/microsoft-app"\)\.appId\(\)\) \{\n\s+return res\.redirect\("\/setup#step-accounts=microsoft"\)/);
 assert.match(server,/public_client: true, authority: tokens\.authority/);
 const state=fs.readFileSync(path.join(__dirname,'../webapp/setup-state.js'),'utf8');
 assert.match(state,/ready: db && model && adminPassword && \(google \|\| microsoft\)/);
 assert.match(state,/key: "accounts", label: "Email and calendar", done: google \|\| microsoft, required: true/);
});
