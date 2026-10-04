// Per-task accounting includes workers, preparation, retries and verification.
const { AsyncLocalStorage } = require("async_hooks");
const scope = new AsyncLocalStorage();
function makeBudget(saved = {}, limits = {}) {
  return { input: saved.input || 0, output: saved.output || 0, calls: saved.calls || 0,
    cachedRead: saved.cachedRead || 0, cachedWrite: saved.cachedWrite || 0, toolCalls: saved.toolCalls || 0,
    maxToolCalls: limits.tool_calls || 200, reservedInput: 0, reservedOutput: 0, startedAt: saved.startedAt || Date.now(),
    maxInput: limits.input_tokens || 2000000, maxOutput: limits.output_tokens || 100000,
    durationMs: limits.duration_ms || 15 * 60 * 1000 };
}
function withTaskRun(meta, fn) {
  const parent = scope.getStore();
  return scope.run({ ...parent, ...meta, budget: meta.budget || parent?.budget || makeBudget() }, fn);
}
function budgetSnapshot() {
  const b = scope.getStore()?.budget;
  return b ? { input: b.input, output: b.output, calls: b.calls, cachedRead: b.cachedRead, cachedWrite: b.cachedWrite, toolCalls: b.toolCalls, startedAt: b.startedAt } : {};
}
// A reply the output limit cut off is not an answer. Thinking models can spend
// the whole allowance before writing a word, and a long tool call loses the
// end of its arguments. Ask again with twice the room, up to twice. Anything
// else that goes wrong asking again (a provider refusing the larger limit)
// keeps the reply already given; a stopped task or a spent allowance still
// stops the work.
const ROOM_CEILING = 32768;
async function moreRoom(response, params, call) {
  let room = params.max_tokens || 4096;
  for (let tries = 0; response?.stop_reason === "max_tokens" && tries < 2 && room < ROOM_CEILING; tries++) {
    room = Math.min(ROOM_CEILING, room * 2);
    console.log(`[model] Reply cut off at the output limit, asking again with room for ${room} tokens.`);
    try { response = await call({ ...params, max_tokens: room }); }
    catch (error) {
      if (["TASK_STOPPED", "TASK_BUDGET_EXCEEDED"].includes(error.code)) throw error;
      console.error(`[model] Asking again with more room failed: ${error.message}`);
      break;
    }
  }
  return response;
}
async function modelCall(client, params, options = {}) {
  return moreRoom(await callOnce(client, params, options), params, (roomier) => callOnce(client, roomier, options));
}
async function callOnce(client, params, options = {}) {
  const active = scope.getStore(); const b = active?.budget;
  const estimated = Math.ceil(JSON.stringify([params.system, params.messages, params.tools]).length / 4);
  const reservedOutput = params.max_tokens || 4096;
  const remaining = b ? b.durationMs - (Date.now() - b.startedAt) : Infinity;
  if (b && (remaining <= 0 || b.input + b.reservedInput + estimated > b.maxInput || b.output + b.reservedOutput + reservedOutput > b.maxOutput)) {
    const error = new Error("This task reached its work allowance. Keep the findings gathered so far.");
    error.code = "TASK_BUDGET_EXCEEDED"; throw error;
  }
  if (b) { b.reservedInput += estimated; b.reservedOutput += reservedOutput; }
  const controller = new AbortController();
  let cancelRequest;
  const abort = () => { controller.abort(); cancelRequest?.(Object.assign(new Error("Task was stopped"), { code: "TASK_STOPPED" })); };
  if (active?.signal?.aborted) controller.abort();
  active?.signal?.addEventListener("abort", abort, { once: true });
  const started = Date.now(); let timer; let response; let failed = false;
  try {
    return response = await Promise.race([
      new Promise((_, reject) => { cancelRequest = reject; if (active?.signal?.aborted) abort(); }),
      client.messages.create(params, { signal: controller.signal }),
      new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort(); const error = new Error("Model request timed out"); error.code = "MODEL_TIMEOUT"; reject(error);
      }, Math.max(1, Math.min(options.timeoutMs || 180000, remaining))); }),
    ]);
  } catch (error) {
    // A network failure gets two more tries before the task gives up; a
    // stopped task or a request that already ran out of time does not.
    if (active?.signal?.aborted || error.code === "TASK_STOPPED" || error.code === "MODEL_TIMEOUT") { failed = true; throw error; }
    try { return response = await require("./sleep-watch").retryNetwork(error, () => client.messages.create(params, { signal: controller.signal }), { pauses: [3000, 10000] }); }
    catch (again) { failed = true; throw again; }
  }
  finally {
    clearTimeout(timer);
    active?.signal?.removeEventListener("abort", abort);
    const u = response?.usage || {};
    if (b) {
      b.reservedInput -= estimated; b.reservedOutput -= reservedOutput; b.calls++;
      // An interrupted request can still cost money. Reserve its estimated
      // input against the task allowance; do not pretend it was billed usage.
      b.cachedRead += u.cache_read_input_tokens || u.prompt_tokens_details?.cached_tokens || 0;
      b.cachedWrite += u.cache_creation_input_tokens || 0;
      b.input += u.input_tokens ?? u.prompt_tokens ?? estimated;
      b.output += u.output_tokens ?? u.completion_tokens ?? (failed ? reservedOutput : 0);
    }
    if (active?.userId) {
      try {
        const { supabase } = require("./db");
        const { error } = await supabase.from("task_model_calls").insert({
          user_id: active.userId, task_id: active.taskId || null, kind: active.kind || "agent",
          purpose: options.purpose || active.purpose || "work", model: response?.model || params.model,
          input_tokens: u.input_tokens || u.prompt_tokens || 0, output_tokens: u.output_tokens || u.completion_tokens || 0,
          cache_read_tokens: u.cache_read_input_tokens || u.prompt_tokens_details?.cached_tokens || 0,
          cache_write_tokens: u.cache_creation_input_tokens || 0,
          reasoning_tokens: u.reasoning_tokens || 0, cost_usd_ticks: u.cost_in_usd_ticks ?? null, duration_ms: Date.now() - started,
          status: failed ? "failed_usage_unknown" : response?.usage ? "success" : "success_usage_unknown",
        });
        if (error) console.error("[task-metrics] write failed:", error.message);
        if (active.leaseOwner) {
          const { error: checkpointError } = await supabase.rpc("checkpoint_task_budget", {
            p_table: active.kind === "automation" ? "automation_runs" : "agent_tasks", p_id: active.taskId,
            p_owner: active.leaseOwner, p_budget: budgetSnapshot() });
          if (checkpointError) console.error("[task-metrics] checkpoint failed:", checkpointError.message);
        }
      } catch (error) { console.error("[task-metrics] unavailable:", error.message); }
    }
  }
}
function countToolCall() {
  const active = scope.getStore(); const b = active?.budget;
  if (active?.signal?.aborted) throw Object.assign(new Error("Task was stopped"), { code: "TASK_STOPPED" });
  if (b && (++b.toolCalls > b.maxToolCalls || Date.now() - b.startedAt > b.durationMs)) {
    throw Object.assign(new Error("This task reached its tool allowance."), { code: "TASK_BUDGET_EXCEEDED" });
  }
}
// A turn that ends without a usable answer, cut off by the output limit even
// after more room or with nothing written, is not the end of the work. The
// loop asks for the step again with this note instead of passing nothing to
// the quality check as if it were a finished answer.
function unfinishedTurn(response, finalText) {
  if (response?.stop_reason === "max_tokens") return "Your last reply was cut off by the length limit before it was finished, so none of it was kept. Do that step again in smaller pieces: shorter code, fewer things in one tool call, or a long document written in parts.";
  if (!String(finalText || "").trim()) return "You stopped without writing anything. Write the complete answer now from what you have found.";
  return null;
}
// Adds a note for the model as the next user turn, joining the tool results
// already there rather than sending two user turns in a row.
function addNote(messages, text) {
  const last = messages[messages.length - 1];
  if (last?.role === "user" && Array.isArray(last.content)) last.content.push({ type: "text", text });
  else messages.push({ role: "user", content: [{ type: "text", text }] });
}
module.exports = { countToolCall, makeBudget, withTaskRun, budgetSnapshot, modelCall, moreRoom, unfinishedTurn, addNote, currentTask: () => scope.getStore() };
