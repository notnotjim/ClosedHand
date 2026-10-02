const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const ROOT=path.join(__dirname,'..');
const read=f=>fs.readFileSync(path.join(ROOT,f),'utf8');
const ID='123456789012-example0example0example0example0.apps.googleusercontent.com';

function fresh(env){
 delete process.env.CLOSEDHAND_GOOGLE_CLIENT_ID;delete process.env.CLOSEDHAND_GOOGLE_CLIENT_SECRET;
 Object.assign(process.env,env);
 delete require.cache[require.resolve('../lib/google-app')];
 return require('../lib/google-app');
}

test('ClosedHand\'s Google app exists only when the build carries both parts',()=>{
 assert.equal(fresh({}).app(),null);
 assert.equal(fresh({CLOSEDHAND_GOOGLE_CLIENT_ID:ID}).app(),null);
 assert.equal(fresh({CLOSEDHAND_GOOGLE_CLIENT_ID:'not-a-google-id',CLOSEDHAND_GOOGLE_CLIENT_SECRET:'s'}).app(),null);
 assert.deepEqual(fresh({CLOSEDHAND_GOOGLE_CLIENT_ID:` ${ID} `,CLOSEDHAND_GOOGLE_CLIENT_SECRET:'s'}).app(),{clientId:ID,clientSecret:'s'});
});

test('the quick route is offered only where Google can hand the sign-in back to this computer',()=>{
 const g=fresh({});
 for(const u of ['http://localhost:3000','http://127.0.0.1:4310','http://[::1]:3000']) assert.equal(g.canReturnTo(u),true,u);
 for(const u of ['https://name.closedhand.ai','http://192.168.1.20:3000','not a url',undefined]) assert.equal(g.canReturnTo(u),false,String(u));
});

test('a sign-in renews through the app that made it',()=>{
 const g=fresh({});
 assert.deepEqual(g.clientFor({client_id:'quick',client_secret:'qs'},'own','os'),{client_id:'quick',client_secret:'qs'});
 assert.deepEqual(g.clientFor({refresh_token:'r'},'own','os'),{client_id:'own',client_secret:'os'});
 assert.equal(g.clientFor({refresh_token:'r'},null,null),null);
});

test('every Google renewal asks which app made the sign-in',()=>{
 assert.match(read('lib/services/google.js'),/require\("\.\.\/google-app"\)\.clientFor\(tokens, GOOGLE_CLIENT_ID\(\), GOOGLE_CLIENT_SECRET\(\)\)/);
 assert.match(read('webapp/rag-processor.js'),/require\("\.\/google-app"\)\.clientFor\(tokens, ownGoogleClientId\(\), ownGoogleClientSecret\(\)\)/);
 assert.match(read('webapp/server.js'),/require\("\.\/google-app"\)\.clientFor\(toks, SERVICES\.google\.clientId, SERVICES\.google\.clientSecret\)/);
});

test('sign-in uses ClosedHand\'s app without an own app, or when asked, and keeps it with the sign-in',()=>{
 const server=read('webapp/server.js');
 assert.match(server,/if \(quick && googleApp\.canReturnTo\(BASE_URL\) && \(req\.query\.quick === "1" \|\| !own\)\) \{\n\s+svc = \{ \.\.\.svc, clientId: quick\.clientId, clientSecret: quick\.clientSecret, personalClient: true, usePKCE: true \};/);
 // personalClient is what makes the callback keep the app's ID and secret on the tokens.
 assert.match(server,/if \(svc\.personalClient\) \{ tokens\.client_id = svc\.clientId; tokens\.client_secret = svc\.clientSecret; \}/);
 assert.match(read('webapp/setup-state.js'),/const googleQuick = !!googleApp\.app\(\) && googleApp\.canReturnTo\(/);
});

test('setup offers the quick route first and keeps the own project one link away',()=>{
 const html=read('webapp/views/setup.html');
 assert.match(html,/<div id="g-quick" hidden>/);
 assert.match(html,/href="\/auth\/google\?return=setup&amp;quick=1"/);
 assert.match(html,/id="g-own-open"/);
 // Both routes sign in the usual way now, so neither card carries a "Quick setup" badge.
 assert.doesNotMatch(html,/Quick setup/);
});

test('ClosedHand\'s Google app comes from the build, never from the source',()=>{
 for(const f of ['Dockerfile','webapp/Dockerfile']) assert.match(read(f),/ARG CLOSEDHAND_GOOGLE_CLIENT_ID=""\nARG CLOSEDHAND_GOOGLE_CLIENT_SECRET=""/,f);
 assert.match(read('.github/workflows/build-selfhost-images.yml'),/CLOSEDHAND_GOOGLE_CLIENT_SECRET=\$\{\{ secrets\.CLOSEDHAND_GOOGLE_CLIENT_SECRET \}\}/);
 assert.match(read('desktop/Info.plist'),/__GOOGLE_CLIENT_ID__/);
 const tracked=execFileSync('git',['ls-files','-z'],{cwd:ROOT}).toString().split('\0').filter(Boolean);
 for(const f of tracked){
  if(/\.(png|jpe?g|gif|ico|icns|woff2?|ttf|onnx|bin|zip|gz|mp4|webm|pdf)$/i.test(f)) continue;
  let s; try{ s=fs.readFileSync(path.join(ROOT,f),'utf8'); }catch(_){ continue; }
  assert.ok(!/GOCSPX-[A-Za-z0-9_-]{10,}/.test(s),`${f} contains a Google client secret`);
 }
});
