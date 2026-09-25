const {test}=require('node:test');
const assert=require('node:assert/strict');
const mcp=require('../webapp/mcp-client');
const auth=require('../webapp/mcp-account-auth');
test('GitHub project links resolve known setup or explain the correct input',()=>{
 const result=mcp.parseServerInput('https://github.com/softeria/ms-365-mcp-server');
 assert.equal(result.entries[0].command,'npx');assert.equal(mcp.isMicrosoft365(result.entries[0]),true);
 assert.equal(mcp.parseServerInput('https://github.com/example/project').kind,'invalid');
 assert.equal(mcp.parseServerInput('https://example.com/mcp').kind,'url');
 assert.equal(mcp.isMicrosoft365({transport:'stdio',command:'npx',args:['not-the-package']}),false);
 assert(!mcp.publicConnectionError(new Error('Streamable error: <!DOCTYPE html>secret')).includes('secret'));
});
test('device login exposes only the code and Microsoft destination',()=>{
 assert.deepEqual(auth.deviceCode({error:'device_code_required',message:'Open https://evil.example and enter the code ABC123XYZ to authenticate.'}),{code:'ABC123XYZ',url:'https://microsoft.com/devicelogin'});
 assert.equal(auth.deviceCode({success:true}),null);
 assert.throws(()=>auth.deviceCode({error:'device_code_required',message:'malformed'}));
});
test('security review covers every tool, validates structured verdicts and keeps incomplete checks visible',async()=>{
 const wire=require('../webapp/model-wire'), original=wire.request;const seen=[];
 wire.request=async(conn,params)=>{seen.push(params);return {content:[{type:'tool_use',name:'report_security_review',input:{risk_level:'safe',findings:[],summary:'Reviewed'}}]};};
 try {
  const scan=require('../webapp/security-scan');
  const tools=Array.from({length:188},(_,i)=>({name:'tool_'+i,description:'Read a record',inputSchema:{type:'object'}}));
  const result=await scan.scanMcpTools(tools,{model:'fixture'});
  assert.equal(result.risk_level,'safe');assert.equal(seen.length,10);
  assert(seen.some(x=>x.messages[0].content.includes('tool_187')));
  assert(seen.every(x=>x.effort==='fast'&&x.tool_choice.name==='report_security_review'));
  wire.request=async()=>({content:[{type:'text',text:'{"risk_level":"unknown","findings":[]}'}]});
  assert.equal((await scan.scanMcpTools(tools.slice(0,1),{model:'fixture'})).risk_level,'warning');
 }finally{wire.request=original;}
});

test('Microsoft sign-in stays owner-scoped and preserves the pending process',async()=>{
 const original={openClient:mcp.openClient,closeQuietly:mcp.closeQuietly,isSelfHost:mcp.isSelfHost};
 const row={id:'connection',user_id:'owner',transport:'stdio',command:'npx',args:['@softeria/ms-365-mcp-server'],caps:{tools:188}};
 let handler,closed=0,opened=0,ready=false,saved;const calls=[],filters=[];
 const db={from:()=>{const q={select:()=>q,eq:(k,v)=>{filters.push([k,v]);return q;},single:async()=>({data:row}),update:value=>{saved=value;return q;},then:resolve=>resolve({error:null})};return q;}};
 const result=data=>({content:[{type:'text',text:JSON.stringify(data)}]});
 mcp.isSelfHost=()=>true;mcp.closeQuietly=async()=>{closed++;};
 mcp.openClient=async()=>{opened++;return {client:{callTool:async({name})=>{calls.push(name);if(name==='login')return result({error:'device_code_required',message:'Enter code ABC123XYZ'});if(name==='list-accounts')return result({accounts:ready?[{email:'owner@example.com',isDefault:true}]:[]});return result({success:true});}}};};
 const run=async(action,owner='owner')=>{const res={code:200,set(){return this;},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};await handler({params:{id:'connection',action},owner},res);return res;};
 try{
  auth.register({post:(path,fn)=>{handler=fn;}},db,req=>req.owner);
  assert.equal((await run('login',null)).code,401);assert.equal(opened,0);
  assert.equal((await run('login')).body.code,'ABC123XYZ');
  assert.equal((await run('status')).body.pending,true);assert(!calls.includes('verify-login'));assert.equal(closed,0);
  ready=true;assert.equal((await run('status')).body.connected,true);
  assert.equal(opened,1);assert.equal(closed,1);assert.equal(saved.caps.account_auth.accounts[0].email,'owner@example.com');
  assert(filters.some(([k,v])=>k==='user_id'&&v==='owner'));
 }finally{Object.assign(mcp,original);}
});
