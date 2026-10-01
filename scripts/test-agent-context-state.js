const { test } = require("node:test");
const assert = require("node:assert/strict");
const { prepareAgentMessages, createAgentResponse } = require("../lib/agent-context");
const { estimateContextTokens } = require("../lib/token-tracker");
const { agentStateForPrompt } = require("../lib/agent-state");
function request(n = 30) {
  const messages = [{ role: "user", content: "Find the answer, but do not send anything." }];
  for (let i = 0; i < n; i++) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: "call-" + i, name: "search_cache", input: { query: "specific source" } }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "call-" + i, content: JSON.stringify({ id: "source-" + i, body: "evidence ".repeat(40000), count: 50 }) }] });
  }
  messages.push({ role: "user", content: "Use the correction I just gave you." });
  return { model: "test", max_tokens: 4096, system: "Read sources carefully.", tools: [], messages };
}
test("large research results are bounded without modifying the saved evidence or tool pairing", () => {
  const params = request();
  const before = JSON.stringify(params);
  const messages = prepareAgentMessages(params, "openai");
  assert.ok(estimateContextTokens(messages, params.system, params.tools, "openai").total <= 64000);
  assert.equal(messages[0].content, params.messages[0].content);
  assert.equal(messages.at(-1).content, params.messages.at(-1).content);
  assert.equal(JSON.stringify(params), before);
  for (let i = 1; i < messages.length - 1; i += 2) {
    assert.equal(messages[i].content[0].id, messages[i + 1].content[0].tool_use_id);
    assert.match(messages[i + 1].content[0].content, /Omitted text is not evidence of absence/);
  }
});
test("small tool results pass through intact", async () => {
  const params = { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: '{"complete":true}' }] }], system: "task" };
  assert.deepEqual(prepareAgentMessages(params, "openai"), params.messages);
});
test("a provider context rejection retries once with a smaller request", async () => {
  const sent = [];
  const client = { messages: { create: async params => {
    sent.push(params);
    if (sent.length === 1) throw new Error("This model's maximum prompt length is 500000 but the request contains 514571 tokens");
    return { content: [{ type: "text", text: "answer" }] };
  } } };
  await createAgentResponse(client, request(), "openai");
  assert.equal(sent.length, 2);
  assert.ok(JSON.stringify(sent[1]).length < JSON.stringify(sent[0]).length);
});
test("unrelated provider errors are not retried, and a second overflow is surfaced", async () => {
  let calls = 0;
  const client = { messages: { create: async () => { calls++; throw new Error("Authentication failed"); } } };
  await assert.rejects(createAgentResponse(client, request(1), "openai"), /Authentication/);
  assert.equal(calls, 1);
  calls = 0;
  client.messages.create = async () => { calls++; throw new Error("maximum prompt length exceeded"); };
  await assert.rejects(createAgentResponse(client, request(), "openai"), /maximum prompt/);
  assert.equal(calls, 2);
});
function database() {
  const rows = [
    { user_id: "owner", id: "task", title: "Shipping question", status: "running", result: null },
    { user_id: "other", id: "private", title: "Other person's task", status: "running" },
  ];
  let failed = false;
  return { rows, setFailed() { failed = true; }, from(table) {
    assert.equal(table, "agent_tasks"); let user;
    const q = { select() { return q; }, eq(key, value) { assert.equal(key, "user_id"); user = value; return q; },
      order() { return q; }, limit() { return q; }, then(resolve, reject) {
        return Promise.resolve(failed ? { error: Error("Database offline") } : { data: rows.filter(r => r.user_id === user) }).then(resolve, reject);
      } };
    return q;
  } };
}
test("chat sees a task changing from running to failed on its next model call", async () => {
  const db = database();
  assert.match(await agentStateForPrompt(db, "owner"), /"status":"running"/);
  db.rows[0].status = "failed";
  db.rows[0].error = "request too large";
  const state = await agentStateForPrompt(db, "owner");
  assert.match(state, /"status":"failed"/);
  assert.match(state, /do not promise a result later/);
  assert.doesNotMatch(state, /Other person's task|"status":"running"/);
});
test("task state errors remain unknown and missing user context never queries", async () => {
  const db = database(); db.setFailed();
  const state = await agentStateForPrompt(db, "owner");
  assert.match(state, /could not be checked/);
  assert.doesNotMatch(state, /no recent task/);
  assert.equal(await agentStateForPrompt({from() { throw Error("must not query"); }}, null), "");
});
test("completed and paused tasks keep their actual status and a bounded result excerpt", async () => {
  const db = database();
  db.rows[0].status = "awaiting_confirmation";
  assert.match(await agentStateForPrompt(db, "owner"), /"status":"awaiting_confirmation"/);
  db.rows[0].status = "completed"; db.rows[0].result = "answer ".repeat(10000);
  const state = await agentStateForPrompt(db, "owner");
  assert.match(state, /"status":"completed"/);
  assert.ok(state.length < 3500);
});
