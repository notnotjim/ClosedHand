const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const {INTERNAL_TOOLS}=require('../lib/tools/definitions');

test('OneDrive has the same four chat tools as Google Drive, offered only with Microsoft',()=>{
 const names=['search','list_recent','read','send_file'];
 for(const n of names){
  const drive=INTERNAL_TOOLS.find(t=>t.name==='drive_'+n), one=INTERNAL_TOOLS.find(t=>t.name==='onedrive_'+n);
  assert.ok(drive&&one,n);
  assert.deepEqual(one.groups,['onedrive']);
  assert.deepEqual(one.input_schema.required||[],drive.input_schema.required||[]);
  assert.ok(one.input_schema.properties.account,'every OneDrive tool can name an account');
 }
 const engine=read('lib/engine.js');
 assert.match(engine,/\(g === "outlook" \|\| g === "onedrive"\) && !hasMicrosoft/);
 assert.match(engine,/"onedrive_search", "onedrive_list_recent"/);
 assert.match(read('webapp/security-scan.js'),/"onedrive_search","onedrive_list_recent","onedrive_read","onedrive_send_file"/);
 assert.match(read('lib/agents.js'),/case "onedrive_send_file": return input\.file_id \? "odrv:"/);
});

test('the tool handlers load the Word and Excel readers they call',()=>{
 const src=read('lib/tools/handlers.js');
 assert.match(src,/^const mammoth = require\("mammoth"\);$/m);
 assert.match(src,/^const XLSX = require\("xlsx"\);$/m);
 for(const n of ['onedrive_search','onedrive_list_recent','onedrive_read','onedrive_send_file'])assert.match(src,new RegExp('case "'+n+'": \\{'));
 // A quote in a search must not end Microsoft's search expression early.
 assert.match(src,/replace\(\/'\/g, "''"\)/);
});

test('File Search walks every OneDrive subfolder and page, like Google Drive',()=>{
 const src=read('webapp/rag-processor.js');
 const branch=src.slice(src.indexOf('} else if (origin === "onedrive") {'),src.indexOf('} else if (origin === "dropbox") {'));
 assert.match(branch,/data\["@odata\.nextLink"\]/);
 assert.match(branch,/"\/items\/" \+ encodeURIComponent\(f\.id\) \+ "\/children"/);
 assert.match(branch,/split\("\/"\)\.map\(encodeURIComponent\)/);
 assert.match(branch,/if \(opts\.recursive\) byRecency\(out, origin, MAX_FILES\)/);
});
