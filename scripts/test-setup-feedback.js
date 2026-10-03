const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require.resolve('../webapp/views/setup.html'), 'utf8');
function nodes() {
 const map = new Map();
 return selector => { if (!map.has(selector)) { const n = { textContent:'',style:{},hidden:false,classes:{} }; n.classList={toggle:(k,v)=>n.classes[k]=v};map.set(selector,n); }return map.get(selector); };
}
test('recall is quiet when idle or ready, and only displays progress, errors or missing configuration inside models', () => {
 const code=html.slice(html.indexOf('    // Setup only shows recall'),html.indexOf('    $("#done-count")'));
 for(const status of ['idle','ready','downloading','error','missing']) {
  const $=nodes(), state={steps:[{key:'model',done:true}],memory:status!=='missing',memoryMode:status==='missing'?'off':'local',localModels:{embedder:{state:status,pct:42}}};
  vm.runInNewContext(code,{$,state});
  assert.equal($('#memory-note').classes['is-on'],['downloading','error','missing'].includes(status));
  assert.equal($('#memory-form').hidden,status!=='missing');
  assert.equal($('#dl-bar').hidden,status!=='downloading');
  if(status==='downloading')assert.match($('#memory-note-lead').textContent,/42%/);
 }
 const start=html.indexOf('id="step-model"'),end=html.indexOf('id="step-admin_password"');
 assert.ok(html.slice(start,end).includes('id="memory-note"'));
});
test('a successful Google connection on the next status check replaces setup with the connected account', () => {
 const start=html.indexOf('  function reflectGoogle('),end=html.indexOf('  // The chooser:',start);
 const $=nodes();let saved=0;
 const context={$,_gKey:'fixture',gStep:5,_gQuick:false,_gDone:false,gSave:()=>saved++,gRender(){},gApplyProject(){},againNote(){}};
 vm.runInNewContext(html.slice(start,end),context);
 context.reflectGoogle({googleCreds:true,googleRedirectUri:'http://localhost:3000/auth/google/callback',googleConnected:true,googleAccount:{email:'alex@example.com'}});
 assert.equal($('#g-connected').style.display,'');assert.equal($('#g-flow').style.display,'none');
 assert.equal($('#g-account').textContent,'Connected as alex@example.com.');assert.equal(saved,1);
 // A build with ClosedHand's Google app: the quick route shows until connected.
 const $q=nodes();let rendered=0;
 const quick={$:$q,_gKey:'fixture',gStep:0,_gQuick:false,_gDone:false,gSave(){},gRender:()=>rendered++,gApplyProject(){},againNote(){}};
 vm.runInNewContext(html.slice(start,end),quick);
 quick.reflectGoogle({googleQuick:true,googleConnected:false});
 assert.equal(quick._gQuick,true);assert.equal(rendered,1);
 quick.reflectGoogle({googleQuick:true,googleConnected:true,googleAccount:{email:'alex@example.com'}});
 assert.equal(quick._gDone,true);
 assert.match(html, /id="g-connect"[^>]+href="\/auth\/google\?return=setup"[^>]+target="_blank"/);
 const server=fs.readFileSync(require.resolve('../webapp/server.js'),'utf8');
 assert.match(server,/returnTo: req.query.return === "setup" \? "\/setup"/);
 assert.match(server,/res.redirect\(stateData\?\.returnTo \|\| "\/"\)/);
});

test('Microsoft shows a sign-in code, then who is connected', async () => {
 const start=html.indexOf('  // Microsoft signs in by code'),end=html.indexOf('  // --- Connect to Google, six steps inside the card ---');
 const $=nodes();const listeners={};const polls=[];let replies=[];
 const node=$;const q=sel=>{const n=node(sel);n.addEventListener=(ev,fn)=>listeners[sel+':'+ev]=fn;return n;};
 const context={$:q,poll:()=>polls.push(1),setInterval:()=>7,clearInterval(){},window:{open(){}},navigator:{},
  document:{addEventListener(){},hidden:false},
  fetch:async url=>{const r=replies.shift();return {ok:r.ok!==false,json:async()=>r.body};}};
 vm.runInNewContext(html.slice(start,end),context);
 context.reflectMicrosoft({microsoftCode:true,microsoftConnected:false});
 assert.equal($('#m-start').textContent,'Sign in with Microsoft');assert.equal($('#m-connected').style.display,'none');
 replies=[{body:{code:'ABCD1234',url:'https://microsoft.com/devicelogin'}}];
 context.msStart();await new Promise(r=>setTimeout(r,0));await new Promise(r=>setTimeout(r,0));
 assert.equal($('#m-code').textContent,'ABCD1234');assert.equal($('#m-code-wrap').style.display,'');assert.equal($('#m-intro').style.display,'none');
 replies=[{body:{connected:true,email:'person@outlook.com'}}];
 context.msCheck();await new Promise(r=>setTimeout(r,0));await new Promise(r=>setTimeout(r,0));
 assert.equal(polls.length,1);
 context.reflectMicrosoft({microsoftCode:true,microsoftConnected:true,microsoftAccount:{email:'person@outlook.com'}});
 assert.equal($('#m-account').textContent,'Connected as person@outlook.com.');
 assert.equal($('#m-start').textContent,'Connect another Microsoft account');assert.equal($('#m-done').style.display,'');
 replies=[{ok:false,body:{error:'That code ran out. Get a new one.'}}];
 context.msStart();await new Promise(r=>setTimeout(r,0));await new Promise(r=>setTimeout(r,0));
 assert.equal($('#m-msg').textContent,'That code ran out. Get a new one.');assert.equal($('#m-intro').style.display,'');
});

test('owning the Microsoft connection happens inside setup, not behind the dashboard it cannot reach yet', () => {
 const card=html.slice(html.indexOf('<div class="fb-block chooser" id="m-block">'),html.indexOf('<div class="fb-block chooser" id="m-block">')+6000);
 const intro=card.slice(card.indexOf('id="m-own-intro"'),card.indexOf('id="m-own"'));
 assert.doesNotMatch(intro,/\/dashboard/,'the dashboard sends people back to setup until email is connected');
 assert.match(card,/id="m-redirect"/); assert.match(card,/id="m-client-id"/); assert.match(card,/id="m-client-secret"/);
 assert.match(html,/fetch\("\/api\/connection-catalogue\/microsoft\/client", \{ method: "PUT"/);
 assert.match(html,/location\.href = "\/auth\/microsoft\?return=setup"/,'the sign-in comes back to setup as the main account, not an extra one');
 assert.match(html,/\.code pre \{[^}]*white-space: pre-wrap/,'long addresses wrap clear of the Copy button');
});
