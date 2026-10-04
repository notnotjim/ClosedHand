const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const evidence = require("../lib/task-evidence");
const { createToolScope, prefetchReads } = require("../lib/task-tools");
const { makeBudget, withTaskRun, modelCall } = require("../lib/task-model");
const lease = require("../lib/task-lease");
function fakeDb(tables = {}) {
  return { tables, from(name) {
    tables[name] ||= []; let action = "select", values, conflict, filters = [];
    const q = { limit() { return q; }, select() { return q; }, update(v) { action = "update"; values = v; return q; },
      insert(v) { action = "insert"; values = v; return q; }, upsert(v, o) { action = "upsert"; values = v; conflict = o.onConflict.split(","); return q; },
      eq(k, v) { filters.push(r => r[k] === v); return q; }, in(k, vs) { filters.push(r => vs.includes(r[k])); return q; },
      or() { filters.push(r => !r.lease_until || new Date(r.lease_until) < new Date()); return q; },
      then(resolve, reject) { return Promise.resolve().then(() => {
        let rows = tables[name].filter(r => filters.every(f => f(r)));
        if (action === "insert") { rows = [structuredClone(values)]; tables[name].push(...rows); }
        if (action === "upsert") {
          let row = tables[name].find(r => conflict.every(k => r[k] === values[k]));
          if (row) Object.assign(row, structuredClone(values)); else tables[name].push(row = structuredClone(values)); rows = [row];
        }
        if (action === "update") rows.forEach(r => Object.assign(r, structuredClone(values)));
        return { data: structuredClone(rows), error: null };
      }).then(resolve, reject); },
    }; return q;
  } };
}
const metrics = fakeDb();
require.cache[require.resolve("../lib/db")] = { exports: { supabase: metrics } };
function exchange(id, name, input, output, failed = false) { return [
  { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: JSON.stringify(output), is_error: failed }] },
]; }
for (const [question, value] of [["And London?", "London"], ["Find the shipping reference", "REFERENCE-123"], ["Flight departure time", "20:00+07:00"], ["Compare weather", "humidity now 72%"], ["Find my report", "report-456"]]) {
  test("handover preserves current evidence and isolates old work: " + question, () => {
    const boundary = { role: "user", content: question };
    const messages = [{ role: "user", content: "Earlier unrelated question" }, ...exchange("old", "search_cache", {}, { text: "UNRELATED" }), boundary,
      ...exchange("new", "search_cache", { query: question }, { id: "source-1", value }), { role: "user", content: "Correction: use the latest source." }];
    const snapshot = evidence.captureRequest(messages, question, boundary, { userId: "one", threadId: "thread" });
    assert.equal(evidence.evidenceFrom(snapshot.messages).length, 1);
    const handed = JSON.stringify(evidence.handoverMessages(snapshot));
    assert.ok(handed.includes(value)); assert.ok(handed.includes("Correction"));
    assert.ok(!JSON.stringify(snapshot.messages).includes("UNRELATED"));
    assert.deepEqual(messages.at(-1), { role: "user", content: "Correction: use the latest source." });
  });
}
test("a missing compressed boundary never imports old tool evidence", () => {
  const s = evidence.captureRequest(exchange("old", "search_cache", {}, { data: "old" }), "new question", {});
  assert.equal(evidence.evidenceFrom(s.messages).length, 0);
});
for (const [result, failed, expected] of [[{ success: true }, false, 1], [{ error: "network" }, false, 0], [{ success: false }, false, 0], [{ ok: true }, true, 0]]) {
  test("restart delivery receipt: " + JSON.stringify(result) + failed, () => {
    const keys = evidence.successfulDeliveryKeys(exchange("send", "file_send", { id: "file" }, result, failed), (name, input) => input.id);
    assert.equal(keys.size, expected);
  });
}
function verifier(client) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../lib/verification.js"), "utf8"), {
    module, exports: module.exports, console, require(name) {
      if (name === "./llm") return { getInternalClient: () => ({ client, model: "fixture" }) };
      return require("../lib/" + name.slice(2));
    },
  }); return module.exports;
}
for (const payload of [{ passed: true, criteria_results: [{ criterion: "Correct time", met: true }] }, { passed: false, criteria_results: [{ criterion: "Correct time", met: false }] }, { passed: "true", criteria_results: [] }, { passed: true, criteria_results: [] }, { nonsense: true }]) {
  test("completion evidence and strict verdict: " + JSON.stringify(payload), async () => {
    let request;
    const v = verifier({ messages: { create: async p => { request = p; return { content: [{ type: "text", text: JSON.stringify(payload) }] }; } } });
    const result = await v.verifyCompletion("Read departure", ["Correct time"], "20:00", ["search_cache"], "owner", exchange("x", "search_cache", {}, { departure: "20:00+07:00", source_id: "booking" }));
    assert.equal(result.passed, payload.passed === true && payload.criteria_results?.length > 0 && payload.criteria_results.every(x => x.met));
    assert.ok(request.messages[0].content.includes("20:00+07:00")); assert.ok(request.messages[0].content.includes("booking"));
  });
}
test("a failed checker stays unavailable", async () => {
  const v = verifier({ messages: { create: async () => { throw Error("offline"); } } });
  const result = await v.verifyCompletion("Goal", ["Outcome"], "Answer", [], "owner");
  assert.equal(result.passed, false); assert.equal(result.status, "unavailable");
});
test("caller criteria avoid an unnecessary preparation call", async () => {
  const v = verifier({ messages: { create: () => { throw Error("must not call"); } } });
  const result = await v.prepareTask("Goal", "owner", {}, ["Requested outcome"]);
  assert.equal(result.criteria[0], "Requested outcome");
});
test("parallel requests share an aggregate allowance", async () => {
  const budget = makeBudget({}, { input_tokens: 100, output_tokens: 20 });
  let release; const client = { messages: { create: () => new Promise(r => release = r) } };
  await withTaskRun({ budget }, async () => {
    const first = modelCall(client, { messages: [], max_tokens: 15 });
    await assert.rejects(modelCall(client, { messages: [], max_tokens: 15 }), e => e.code === "TASK_BUDGET_EXCEEDED");
    release({ usage: { input_tokens: 4, output_tokens: 3 } }); await first;
  });
  assert.equal(budget.output, 3); assert.equal(budget.reservedOutput, 0);
});
test("a timeout aborts the underlying request and preserves failure accounting", async () => {
  let signal; const budget = makeBudget();
  await withTaskRun({ userId: "owner", taskId: "task", budget }, async () => {
    await assert.rejects(modelCall({ messages: { create: (_, opts) => { signal = opts.signal; return new Promise(() => {}); } } }, { messages: [], max_tokens: 8 }, { timeoutMs: 5 }), /timed out/);
  });
  assert.equal(signal.aborted, true); assert.equal(budget.calls, 1);
  assert.equal(metrics.tables.task_model_calls.at(-1).status, "failed_usage_unknown");
});
test("usage separates cached reads and writes with task identity", async () => {
  await withTaskRun({ userId: "owner", taskId: "task", kind: "agent" }, () => modelCall({ messages: { create: async () => ({ usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 12, cache_creation_input_tokens: 4 } }) } }, { messages: [], model: "fixture" }));
  const row = metrics.tables.task_model_calls.at(-1);
  assert.equal(row.task_id, "task"); assert.equal(row.cache_read_tokens, 12); assert.equal(row.cache_write_tokens, 4);
});
test("two workers cannot claim the same task", async () => {
  const db = fakeDb({ agent_tasks: [{ id: "task", user_id: "owner", status: "pending" }] });
  const results = await Promise.all([lease.claim(db, "agent_tasks", "task", "owner"), lease.claim(db, "agent_tasks", "task", "owner")]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await lease.claim(db, "agent_tasks", "task", "other"), null);
});
test("a stopped task cannot renew its execution lease", async () => {
  const db = fakeDb({ agent_tasks: [{ id: "task", user_id: "owner", status: "pending" }] });
  await lease.claim(db, "agent_tasks", "task", "owner"); db.tables.agent_tasks[0].status = "cancelled";
  await assert.rejects(lease.renew(db, "agent_tasks", "task"), /stopped/);
});
test("tool discovery stays within worker permissions and preserves names", () => {
  const tools = ["get_tool_details", "search_cache", "rare_service"].map(name => ({ name, description: name, input_schema: {} }));
  const scope = createToolScope(tools, "mail");
  assert.ok(!scope.definitions().some(t => t.name === "rare_service"));
  assert.ok(scope.definitions(exchange("d", "get_tool_details", { tool_name: "rare_service" }, {})).some(t => t.name === "rare_service"));
  assert.ok(scope.describe("agent_start").error);
});
test("independent reads run concurrently within a bound", async () => {
  let active = 0, peak = 0;
  const blocks = Array.from({ length: 7 }, (_, i) => ({ type: "tool_use", name: "web_search", id: String(i) }));
  const pending = prefetchReads(blocks, async b => { peak = Math.max(peak, ++active); await new Promise(r => setTimeout(r, 3)); active--; return b.id; });
  assert.deepEqual(await Promise.all(pending.values()), blocks.map(b => b.id)); assert.equal(peak, 3);
  assert.equal(prefetchReads([{ type: "tool_use", name: "gmail_send" }], () => { throw Error("must not run"); }).size, 0);
});
for (const scenario of ["superseded", "other-thread", "replacement-during-call", "deliver"]) {
  test("deferred reply: " + scenario, async () => {
    const { deferReply, finishReply } = require("../lib/deferred-reply");
    const db = fakeDb();
    const info = { userId: "owner", platform: "whatsapp_linked", chatId: "phone", threadId: "thread", requestId: "request", goal: "London", messages: exchange("x", "web_search", {}, { city: "London", value: 12 }) };
    await deferReply(db, info); const row = structuredClone(db.tables.task_followups[0]); let sent = 0;
    await finishReply(db, row, { current: async () => ({ threadId: scenario === "other-thread" ? "different" : "thread", recent: [], model: "fixture", client: { messages: { create: async () => {
      if (scenario === "replacement-during-call") await deferReply(db, { ...info, requestId: "new" });
      return { content: [{ type: "text", text: JSON.stringify({ send: scenario !== "superseded", answer: "On London: 12." }) }] };
    } } } }), deliver: async () => { sent++; } });
    assert.equal(sent, scenario === "deliver" ? 1 : 0);
    await finishReply(db, row, { current: () => { throw Error("duplicate"); }, deliver: () => { throw Error("duplicate"); } });
  });
}

test("full source pages preserve exact details and isolate user/source identity", async () => {
  const { readCachedRecord } = require("../lib/task-retrieval");
  const db = fakeDb({data_cache:[
    {user_id:"owner",external_id:"record",source:"gmail",data:{subject:"Invoice",body:"Intro ".repeat(2000)+"Exact reference ZQ-104729-B, GBP 417.08"}},
    {user_id:"other",external_id:"record",source:"gmail",data:{body:"OTHER_USER_PRIVATE"}}
  ]});
  const first=await readCachedRecord(db,"owner",{id:"record",source:"gmail",limit:8000});
  assert.equal(first.complete,false);assert.equal(first.next_offset,8000);
  const second=await readCachedRecord(db,"owner",{id:"record",source:"gmail",offset:first.next_offset});
  assert.ok(second.content.includes("ZQ-104729-B"));assert.ok(!JSON.stringify([first,second]).includes("OTHER_USER_PRIVATE"));
  assert.ok((await readCachedRecord(db,"owner",{id:"record",source:"outlook"})).error);
});
test("a missing action receipt is retained as uncertainty, not permission to repeat", () => {
  const { prepareAgentMessages }=require("../lib/agent-context");
  const original=[{role:"assistant",content:[{type:"tool_use",id:"send",name:"send_file",input:{id:"file"}}]}];
  const request=prepareAgentMessages({messages:original},"custom");
  assert.equal(request[1].content[0].is_error,true);assert.match(request[1].content[0].content,/may or may not have happened/);
  assert.equal(original.length,1);
});
test("an external stop aborts even a provider adapter that ignores the signal", async () => {
  const controller=new AbortController();
  const p=withTaskRun({signal:controller.signal},()=>modelCall({messages:{create:()=>new Promise(()=>{})}},{messages:[],max_tokens:10},{timeoutMs:1000}));
  controller.abort();await assert.rejects(p,/stopped/);
});

test("an answer sent back by the quality check is rewritten as the only answer", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "verification.js"), "utf8");
  const start = src.indexOf("function retryNote");
  const box = {};
  vm.runInNewContext(src.slice(start, src.indexOf("\n}\n", start) + 2) + "\nthis.f = retryNote;", box);
  const note = box.f(1, 2, "Prices are weekly totals, not nightly.");
  assert.match(note, /Prices are weekly totals/);
  assert.match(note, /has not seen your previous answer/);
  assert.match(note, /do not mention a correction, an earlier version or this check/);
  for (const f of ["lib/agents.js", "lib/automations.js"]) {
    const caller = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    assert.match(caller, /text: retryNote\(/, `${f} uses the shared note`);
    assert.doesNotMatch(caller, /improved response/, `${f} has no wording of its own`);
  }
});

test("a background model call survives a dropped connection; a stopped task is not retried", async () => {
  let calls = 0;
  const client = { messages: { create: async () => { calls++; if (calls === 1) throw new Error("fetch failed"); return { content: [{ type: "text", text: "ok" }], usage: {} }; } } };
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "task-model.js"), "utf8");
  assert.match(src, /retryNetwork\(error, \(\) => client\.messages\.create\(params, \{ signal: controller\.signal \}\), \{ pauses: \[3000, 10000\] \}\)/);
  assert.match(src, /if \(active\?\.signal\?\.aborted \|\| error\.code === "TASK_STOPPED" \|\| error\.code === "MODEL_TIMEOUT"\) \{ failed = true; throw error; \}/);
  const sw = require("../lib/sleep-watch");
  const original = sw.retryNetwork;
  sw.retryNetwork = (e, fn) => original(e, fn, { pauses: [1] });
  try {
    const res = await modelCall(client, { model: "m", max_tokens: 10, messages: [] }, { timeoutMs: 5000 });
    assert.equal(res.content[0].text, "ok");
    assert.equal(calls, 2);
  } finally { sw.retryNetwork = original; }
});

test("a background job that failed with nothing to show says what and why, and how to restart", () => {
  const { failedNote } = require("../lib/task-delivery");
  assert.equal(failedNote({ goal: "can you find me a couple of good coworking spaces in District 1 with day passes, for next week?", error: "fetch failed" }),
    'I couldn\'t finish "can you find me a couple of good coworking spaces in District 1 with day passes, for next…": the connection to the AI provider kept dropping. Say "try again" and I\'ll start it fresh.');
  assert.match(failedNote({ goal: "x", error: "This task reached its work allowance." }), /work allowance/);
  assert.doesNotMatch(failedNote({ goal: "x" }), /dashboard/);
});

test("a background job gets a short name, and until then its first sentence cut at a word", () => {
  const verification = fs.readFileSync(path.join(__dirname, "..", "lib", "verification.js"), "utf8");
  assert.match(verification, /The title names the result as a document would be named, 3 to 7 words/);
  const agents = fs.readFileSync(path.join(__dirname, "..", "lib", "agents.js"), "utf8");
  assert.match(agents, /\.\.\.\(prepared\.title \? \{ title: prepared\.title \} : \{\}\)/);
  const start = agents.indexOf("  // Until preparation names it");
  const body = agents.slice(start, agents.indexOf("\n  const task = await createTask", start));
  const box = { goal: "I need somewhere to stay in Saigon from the 7th for a week. Can you find me a few good options?" };
  vm.runInNewContext(body + "\nthis.out = title;", box);
  assert.equal(box.out, "I need somewhere to stay in Saigon from the 7th for a week");
  const long = { goal: "can you find me a couple of good coworking spaces in District 1 with day passes for the week" };
  vm.runInNewContext(body + "\nthis.out = title;", long);
  assert.equal(long.out, "can you find me a couple of good coworking spaces in District 1 with…");
});
