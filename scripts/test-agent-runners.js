// Exercise the real executor entry points with captured tools, models and transport.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
function database(initial = {}) {
  const tables = structuredClone(initial);
  return { tables, async rpc(name, input) {
    if (name === "acknowledge_agent_notes") {
      const row = tables.agent_tasks.find(r => r.id === input.p_task_id && r.user_id === input.p_user_id);
      row.pending_notes = row.pending_notes.filter(n => !(input.p_ids.ids || input.p_ids).includes(n.id || n.at));
    }
    return { data: null, error: null };
  }, from(table) {
    tables[table] ||= []; let operation = "select", value, options, single = false, filters = [], count;
    const q = { select() { return q; }, eq(k,v) { filters.push(r => r[k] === v); return q; },
      in(k,v) { filters.push(r => v.includes(r[k])); return q; },
      lt(k,v) { filters.push(r => r[k] < v); return q; },
      or() { filters.push(r => !r.lease_until || new Date(r.lease_until).getTime() < Date.now()); return q; },
      order() { return q; }, limit(n) { count=n; return q; }, single() { single=true; return q; },
      insert(v) { operation="insert";value=v;return q; }, update(v) { operation="update";value=v;return q; },
      upsert(v,o) { operation="upsert";value=v;options=o;return q; },
      then(resolve,reject) { return Promise.resolve().then(() => {
        let rows=tables[table].filter(r => filters.every(f => f(r)));
        const fresh = () => ({ id: randomUUID(), created_at: new Date().toISOString(), runtime: {}, pending_notes: [], messages: [], status: "pending", ...structuredClone(value) });
        if(operation==="insert") {
          if(table==="task_deliveries" && tables[table].some(r=>["task_table","task_id","destination"].every(k=>r[k]===value[k]))) return {data:null,error:{code:"23505"}};
          rows=[fresh()];tables[table].push(...rows);
        }
        if(operation==="update") rows.forEach(r => Object.assign(r,structuredClone(value)));
        if(operation==="upsert") {
          const keys=options.onConflict.split(","); let row=tables[table].find(r => keys.every(k => r[k]===value[k]));
          if(!row) tables[table].push(row=fresh()); else if(!options.ignoreDuplicates) Object.assign(row,structuredClone(value)); rows=[row];
        }
        if(count) rows=rows.slice(0,count);
        return { data: structuredClone(single ? rows[0] || null : rows), error:null };
      }).then(resolve,reject); }
    };return q;
  } };
}
function harness(options = {}) {
  const db=database(options.tables), calls=[], sends=[], modules=new Map(), intervals=[];
  const store={ profile:{ settings:{llm_provider:"custom"},display_name:"Fixture" }, notes:{},connections:[], save:async()=>{}, markDirty(){} };
  const ctx={ store:{}, runWithInheritedContext:fn=>fn(), activeUserId:"user", pendingConfirmations:{} };
  const tools=["get_tool_details","search_cache","sandbox_file_download","web_search"].map(name=>({name,description:name,input_schema:{type:"object",properties:{}}}));
  const llm={ getUserLLMClient:()=>({client:{messages:{create:async p=>{calls.push(p);return options.model ? options.model(p,calls.length,db) : {stop_reason:"end_turn",content:[{type:"text",text:"The confirmed time is 20:00."}],usage:{input_tokens:100,output_tokens:20}};}}},model:"fixture"}),
    resolveUserModel:()=>"fixture", getInternalClient:()=>llm.getUserLLMClient() };
  const stubs={ "context":ctx,"db":{supabase:db},"../user-store":{UserStore:{load:async()=>structuredCloneStore()},supabase:db},
    "user-mutex":{acquireUserMutex:async(id,fn)=>fn()},"storage":{swapToCloudStore:s=>{ctx.activeUserStore=s;ctx.store=s;},syncAdapterBack(){},cleanupUserContext(){}},
    "tools/handlers":{isInternalTool:()=>true,handleInternalTool:async(name,input)=>{sends.push({name,input});return {success:true,source:"fixture",time:"20:00"};}},
    "mcp":{getMcpToolDefsFor:()=>[],warmUserMcp:async()=>{},callMCPTool:async()=>({})},
    "tools/definitions":{INTERNAL_TOOLS:tools},"messaging":{sendToPlatform:async(...args)=>sends.push(args)},
    "skills":{getSkillsForPrompt:()=>""},"llm":llm,"spend-guard":{spendIntent:()=>null},"outbound-guard":{outboundIntent:()=>null},"claims-check":{},
    "verification":{prepareTask:async(...args)=> options.prepare ? options.prepare(...args) : {tier:"default",criteria:["Correct time"]},verifyCompletion:async()=> options.verdict || {passed:true,status:"passed"}},
    "task-delivery":{deliverFinished:async()=>{}},"response-presentation":{responsePresentation:()=>""},
    "token-tracker":{getContextWindow:()=>200000,estimateContextTokens:(m,s,t)=>({total:JSON.stringify([m,s,t]).length/4})},
    "config":{getConf:async()=>null},"dashboard-links":{agentLinkNotice:async()=>"Report: https://fixture.test/dashboard#agents"}
  };
  function structuredCloneStore(){return {...store,profile:structuredClone(store.profile)};}
  function load(name, actual = false) {
    if(!actual && stubs[name]) return stubs[name];
    if(modules.has(name)) return modules.get(name).exports;
    const file=path.join(__dirname,"../lib",name+".js"); const module={exports:{}};modules.set(name,module);
    vm.runInNewContext(fs.readFileSync(file,"utf8"),{module,exports:module.exports,console:{log(){},warn(){},error(){}},process:{env:{}},
      Date,JSON,Set,Map,Promise,AbortController,structuredClone,Buffer,setTimeout,clearTimeout,
      setInterval:fn=>{intervals.push(fn);return {unref(){}};},clearInterval(){},
      require(request) {
        if(request==="../user-store")return stubs[request];
        if(request==="@supabase/supabase-js")return {createClient:()=>db};
        if(request==="node-cron")return {schedule:()=>({stop(){}})};
        if(request.startsWith("./"))return load(path.posix.normalize(path.posix.join(path.posix.dirname(name),request)));
        return require(request);
      }},{filename:file});return module.exports;
  }
  return {db,calls,sends,ctx,load,intervals};
}
async function until(predicate){for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,2));}throw Error("Fixture did not finish");}
const row=(extra={})=>({id:"task",user_id:"user",platform:"dashboard",chat_id:"dashboard",goal:"Read departure",status:"pending",model:"fixture",runtime:{},messages:[],tools_used:[],pending_notes:[],created_at:new Date().toISOString(),...extra});
test("chat agent acknowledgement returns before preparation finishes",async()=>{
  let release;const h=harness({prepare:()=>new Promise(r=>release=r)});const agents=h.load("agents");
  const ack=await agents.startAgent("user","dashboard","dashboard","Read departure");
  assert.ok(ack.taskId);await until(()=>release);assert.equal(h.calls.length,0);
  release({tier:"default",criteria:["Correct time"]});await until(()=>h.db.tables.agent_tasks[0].status==="completed");
});
for(const status of ["pending","running"])test("dashboard atomically picks up a "+status+" task once",async()=>{
  const h=harness({tables:{agent_tasks:[row({status,lease_until:"2000-01-01T00:00:00Z"})]}});const a=h.load("agents");
  await Promise.all([a.processPendingTasks(),a.processPendingTasks()]);await until(()=>h.db.tables.agent_tasks[0].status==="completed");
  assert.equal(h.calls.length,1);assert.equal(h.db.tables.agent_tasks[0].delivery_status,"pending");
});
test("cancellation during a model call prevents tool execution and status overwrite",async()=>{
  const h=harness({tables:{agent_tasks:[row()]},model:async(p,n,db)=>{
    db.tables.agent_tasks[0].status="cancelled";
    return {stop_reason:"tool_use",content:[{type:"tool_use",id:"send",name:"sandbox_file_download",input:{path:"report.pdf"}}]};
  }});await h.load("agents").processPendingTasks();await until(()=>h.db.tables.agent_tasks[0].lease_owner===null);
  assert.equal(h.db.tables.agent_tasks[0].status,"cancelled");assert.equal(h.sends.length,0);
});
test("a correction received during generation changes the next answer",async()=>{
  const h=harness({tables:{agent_tasks:[row()]},model:async(p,n,db)=>{
    if(n===1)db.tables.agent_tasks[0].pending_notes=[{id:"note",note:"Use local time 20:00"}];
    return {stop_reason:"end_turn",content:[{type:"text",text:n===1?"Wrong old answer":"20:00 local time"}]};
  }});await h.load("agents").processPendingTasks();await until(()=>h.db.tables.agent_tasks[0].status==="completed");
  assert.equal(h.calls.length,2);assert.ok(JSON.stringify(h.calls[1].messages).includes("Use local time"));assert.equal(h.db.tables.agent_tasks[0].result,"20:00 local time");
});
for(const verdict of [{passed:false,status:"failed",feedback:"Source missing"},{passed:false,status:"unavailable",feedback:"Checker offline"}])test("one-off preserves partial output when verification is "+verdict.status,async()=>{
  const h=harness({tables:{agent_tasks:[row()]},verdict});await h.load("agents").processPendingTasks();await until(()=>h.db.tables.agent_tasks[0].status==="partial");
  assert.equal(h.calls.length,verdict.status==="failed"?2:1);assert.ok(h.db.tables.agent_tasks[0].result.includes("20:00"));
});
test("saved successful file receipt prevents a duplicate send after restart",async()=>{
  const prior=[{role:"assistant",content:[{type:"tool_use",id:"first",name:"sandbox_file_download",input:{path:"report.pdf"}}]},{role:"user",content:[{type:"tool_result",tool_use_id:"first",content:'{"success":true}'}]}];
  const h=harness({tables:{agent_tasks:[row({status:"running",messages:prior})]},model:async(p,n)=>n===1?{stop_reason:"tool_use",content:[{type:"tool_use",id:"again",name:"sandbox_file_download",input:{path:"report.pdf"}}]}:{stop_reason:"end_turn",content:[{type:"text",text:"The report was delivered."}]}});
  await h.load("agents").processPendingTasks();await until(()=>h.db.tables.agent_tasks[0].status==="completed");assert.equal(h.sends.length,0);assert.ok(JSON.stringify(h.calls[1]).includes("already_delivered"));
});
for(const status of ["pending","running"])test("automation "+status+" pickup verifies results and does not duplicate dispatch",async()=>{
  const auto=row({status,lease_until:"2000-01-01T00:00:00Z",runtime:{config:{task_prompt:"Read departure",task_max_duration:900}},started_at:new Date().toISOString()});
  const h=harness({tables:{automation_runs:[auto]},verdict:{passed:false,status:"unavailable",feedback:"Checker offline"}});
  const a=h.load("automations");await Promise.all([a.processPendingAutomationRuns(),a.processPendingAutomationRuns()]);
  await until(()=>h.db.tables.automation_runs[0].status==="partial");assert.equal(h.calls.length,1);assert.ok(h.db.tables.automation_runs[0].full_report);
});
test("completion notice is sent at most once, including after a failed transport",async()=>{
  for(const fail of [false,true]){
    const h=harness(), delivery=h.load("task-delivery",true);let sent=0;
    const info={table:"agent_tasks",id:"task",userId:"user",platform:"telegram",chatId:"phone",message:"A result"};
    const send=async()=>{sent++;if(fail)throw Error("Network uncertain");return "receipt";};
    await Promise.all([delivery.deliverOnce(h.db,info,send),delivery.deliverOnce(h.db,info,send)]);
    await delivery.deliverOnce(h.db,info,send);assert.equal(sent,1);assert.equal(h.db.tables.task_deliveries[0].status,fail?"uncertain":"sent");
  }
});
test("an old worker lease cannot overwrite the new worker's result",async()=>{
  const h=harness({tables:{agent_tasks:[row()]}});const lease=h.load("task-lease");const scope=h.load("task-model");
  const first=await lease.claim(h.db,"agent_tasks","task","user");h.db.tables.agent_tasks[0].lease_until="2000-01-01T00:00:00Z";
  const second=await lease.claim(h.db,"agent_tasks","task","user");assert.notEqual(first.lease_owner,second.lease_owner);
  await assert.rejects(scope.withTaskRun({taskId:"task",leaseOwner:first.lease_owner},()=>lease.update(h.db,"agent_tasks","task",{status:"completed"})),/stopped/);
  assert.equal(h.db.tables.agent_tasks[0].status,"running");
});
