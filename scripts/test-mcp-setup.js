const {test}=require('node:test');
const assert=require('node:assert/strict');
const mcp=require('../webapp/mcp-client');
test('GitHub project links explain the correct input',()=>{
 assert.equal(mcp.parseServerInput('https://github.com/example/project').kind,'invalid');
 assert.equal(mcp.parseServerInput('https://example.com/mcp').kind,'url');
 assert(!mcp.publicConnectionError(new Error('Streamable error: <!DOCTYPE html>secret')).includes('secret'));
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
