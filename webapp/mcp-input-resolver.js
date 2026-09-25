// Read public connection instructions as data. Never execute documentation.
const mcp = require('./mcp-client');
const MAX_BYTES = 262144;
function candidates(text) {
  const found = new Map();
  const add = input => {
    const parsed = mcp.parseServerInput(input);
    for (const entry of parsed.entries || []) {
      if (entry.transport === 'stdio' && !['npx','uvx','uv','node','python','python3','docker','bunx'].includes(entry.command)) continue;
      const key = JSON.stringify([entry.server_url, entry.env, entry.headers]);
      if (!found.has(key)) found.set(key, { name: (entry.name || 'Connection') + (entry.transport === 'stdio' ? ' · Runs here with ' + entry.command : ' · Online at ' + entry.server_url), input: JSON.stringify(entry.transport === 'stdio'
        ? {command:entry.command,args:entry.args,env:entry.env} : {url:entry.server_url,headers:entry.headers,type:entry.transport}) });
    }
  };
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) add(trimmed);
  for (const match of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    const block = match[1].trim();
    if (block.startsWith('{') || block.startsWith('"')) add(block);
    else for (const line of block.replace(/\\\r?\n\s*/g,' ').split('\n')) {
      const command = line.trim().replace(/^\$\s+/,'');
      if (/^(?:npx\s+(?:-y\s+)?(?:@[\w.-]+\/)?[\w.-]*mcp[\w.-]*|uvx\s+[\w.-]*mcp[\w.-]*)\b/i.test(command) && !/[;&|`<>]/.test(command)) add(command);
    }
  }
  return [...found.values()].slice(0,12);
}
async function readPublic(url, fetcher) {
  const response = await fetcher(url, {redirect:'error',signal:AbortSignal.timeout(15000),headers:{Accept:'application/vnd.github.raw+json','User-Agent':'ClosedHand'}});
  if (!response.ok) throw new Error(response.status === 429 || response.status === 403
    ? 'GitHub is limiting requests. Try again shortly, or paste the connection configuration.'
    : 'Could not read this public GitHub file. Check the link, or paste its connection configuration.');
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('This file is too large. Paste just its connection configuration.');
  let content='',size=0; const decoder=new TextDecoder();
  for await (const part of response.body) {
    size+=part.length;
    if(size>MAX_BYTES) throw new Error('This file is too large. Paste just its connection configuration.');
    content+=decoder.decode(part,{stream:true});
  }
  return content+decoder.decode();
}
async function resolveInput(input, fetcher=fetch) {
  let raw=String(input||'').trim();
  const link=raw.match(/^\[[^\]]*\]\((https?:\/\/[^\s)]+)\)$/);if(link)raw=link[1];
  if (/^github\.com\//i.test(raw)) raw='https://'+raw;
  let url;try{url=new URL(raw);}catch{return null;}
  if(!['github.com','www.github.com','raw.githubusercontent.com'].includes(url.hostname))return null;
  if(url.username||url.password||url.port||!['https:','http:'].includes(url.protocol))throw new Error('Use a public HTTPS GitHub link.');
  if (/\/SKILL\.md$/i.test(url.pathname)) return null;
  const parts=url.pathname.split('/').filter(Boolean);
  if(parts.length<2 || !parts.slice(0,2).every(x=>/^[\w.-]+$/.test(x)))throw new Error('Paste a link to a GitHub repository or its configuration file.');
  const [owner,repo]=parts;
  if(owner.toLowerCase()==='softeria'&&repo.toLowerCase()==='ms-365-mcp-server'&&parts.length===2)return null;
  let api='https://api.github.com/repos/'+owner+'/'+repo.replace(/\.git$/,'');
  if(url.hostname==='raw.githubusercontent.com'){
    if(parts.length<4)throw new Error('This GitHub file link is incomplete.');
    api+='/contents/'+parts.slice(3).map(encodeURIComponent).join('/')+'?ref='+encodeURIComponent(parts[2]);
  }else if(parts[2]==='blob'||parts[2]==='tree'){
    const ref=parts[3];if(!ref)throw new Error('This GitHub link is incomplete.');
    const file=parts.slice(4);
    if(parts[2]==='tree')file.push('README.md');
    api+='/contents/'+file.map(encodeURIComponent).join('/')+'?ref='+encodeURIComponent(ref);
  }else if(parts.length===2)api+='/readme';
  else throw new Error('Use the repository link or a README/configuration file link.');
  let text;
  try{text=await readPublic(api,fetcher);}catch(e){
    if(e.name==='TimeoutError'||e.name==='AbortError')throw new Error('GitHub took too long to respond. Try again.');
    throw e;
  }
  const choices=candidates(text);
  if(!choices.length)throw new Error('No runnable MCP configuration was found on this page. Paste its MCP URL, JSON configuration, or installation command. A source repository may require building first.');
  return {source:'https://github.com/'+owner+'/'+repo,choices};
}
module.exports={resolveInput,candidates};

