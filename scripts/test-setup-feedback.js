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
 const context={$,_gKey:'fixture',gStep:5,gSave:()=>saved++,gRender(){},gApplyProject(){}};
 vm.runInNewContext(html.slice(start,end),context);
 context.reflectGoogle({googleCreds:true,googleRedirectUri:'http://localhost:3000/auth/google/callback',steps:[{key:'google',done:true}],googleAccount:{email:'alex@example.com'}});
 assert.equal($('#g-connected').style.display,'');assert.equal($('#g-flow').style.display,'none');
 assert.equal($('#g-account').textContent,'Connected as alex@example.com.');assert.equal(saved,1);
 assert.match(html, /id="g-connect"[^>]+href="\/auth\/google\?return=setup"[^>]+target="_blank"/);
 const server=fs.readFileSync(require.resolve('../webapp/server.js'),'utf8');
 assert.match(server,/returnTo: req.query.return === "setup" \? "\/setup"/);
 assert.match(server,/res.redirect\(stateData\?\.returnTo \|\| "\/"\)/);
});
