const {test}=require('node:test');
const assert=require('node:assert/strict');
const mcp=require('../webapp/mcp-client');
// The Connect anything box (dashboard.html) takes every kind of paste below;
// each one is read here, with invented names.
test('every kind of paste the box takes is one it reads',()=>{
 for (const [paste, kind] of [["https://mcp.kestrel.example/mcp", "url"], ["npm:@kestrel/mcp-server", "command"], ["pypi:kestrel-mcp", "command"],
  ["https://www.npmjs.com/package/@kestrel/mcp-server", "command"], ["https://pypi.org/project/kestrel-mcp/", "command"],
  ["npx -y @kestrel/mcp-server", "command"], ["uvx kestrel-mcp", "command"], ["docker run -i --rm kestrel/mcp", "command"],
  ['{"mcpServers":{"kestrel":{"command":"npx","args":["-y","@kestrel/mcp-server"]}}}', "json"], ['{"servers":{"kestrel":{"url":"https://mcp.kestrel.example/mcp"}}}', "json"],
  ['{"mcp":{"servers":{"kestrel":{"url":"https://mcp.kestrel.example/mcp"}}}}', "json"], ["claude mcp add kestrel -- npx -y @kestrel/mcp-server", "command"],
  ["https://github.com/kestrel/skills/blob/main/notes/SKILL.md", "skill"]]) assert.equal(mcp.parseServerInput(paste).kind, kind, paste);
});
test('a link to a skill\'s folder installs its SKILL.md, and any other folder reads its README',async()=>{
 const {resolveInput}=require('../webapp/mcp-input-resolver');
 const seen=[];
 const fetcher=async(url)=>{seen.push(url);const ok=/\/skills\/notes\/SKILL\.md\?ref=main$/.test(url);
  return {ok,status:ok?200:404,headers:{get:()=>null},body:(async function*(){yield new TextEncoder().encode(ok?'# Notes skill':'');})()};};
 assert.deepEqual(await resolveInput('https://github.com/kestrel/tools/tree/main/skills/notes',fetcher),{skill:'https://github.com/kestrel/tools/blob/main/skills/notes/SKILL.md'});
 await assert.rejects(resolveInput('https://github.com/kestrel/tools/tree/main/servers/notes',fetcher));
 assert.match(seen.at(-1),/\/contents\/servers\/notes\/README\.md\?ref=main$/,'not a skill: its README, as before');
});
test('a README pasted as text offers the connections it describes',async()=>{
 const {resolveInput}=require('../webapp/mcp-input-resolver');
 const readme='# Kestrel\n\nInstall:\n\n```bash\nnpx -y @kestrel/kestrel-mcp\n```\n\nOr in your config:\n\n```json\n{"mcpServers":{"kestrel":{"url":"https://mcp.kestrel.example/mcp"}}}\n```\n';
 const got=await resolveInput(readme,async()=>{throw new Error('nothing is fetched');});
 assert.equal(got.source,null);
 assert.equal(got.choices.length,2);
 assert.equal(await resolveInput('npx -y @kestrel/kestrel-mcp'),null,'a plain command is left to the parser');
});
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
