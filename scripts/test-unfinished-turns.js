// A reply cut off by the output limit, or one with nothing written, is not an
// answer. A background run once ended "No answer was produced" after a
// thinking model spent its whole 4096-token allowance thinking, then cut a
// long tool call off mid-arguments, and both were treated as finished. Now a
// cut-off reply is asked again with more room, and a turn that still ends
// unfinished is asked for again instead of going to the quality check.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const { moreRoom, unfinishedTurn, addNote } = require("../lib/task-model");
const { convertResponseFromOpenAI } = require("../lib/model-wire");

const quiet = (fn) => async () => {
  const log = console.log, error = console.error;
  console.log = () => {}; console.error = () => {};
  try { await fn(); } finally { console.log = log; console.error = error; }
};

test("a cut-off reply is asked again with twice the room, up to twice", quiet(async () => {
  const asked = [];
  const call = async (p) => { asked.push(p.max_tokens); return { stop_reason: p.max_tokens >= 16384 ? "end_turn" : "max_tokens", content: [{ type: "text", text: "done" }] }; };
  const cut = { stop_reason: "max_tokens", content: [] };
  const answer = await moreRoom(cut, { max_tokens: 4096 }, call);
  assert.deepEqual(asked, [8192, 16384]);
  assert.equal(answer.stop_reason, "end_turn");

  const never = [];
  await moreRoom(cut, { max_tokens: 4096 }, async (p) => { never.push(p.max_tokens); return cut; });
  assert.deepEqual(never, [8192, 16384], "two more tries, then the loop takes over");

  const fine = { stop_reason: "end_turn", content: [] };
  assert.equal(await moreRoom(fine, { max_tokens: 4096 }, async () => { throw new Error("not called"); }), fine);
}));

test("a provider that refuses the larger limit keeps the reply it gave; a stop still stops", quiet(async () => {
  const cut = { stop_reason: "max_tokens", content: [] };
  assert.equal(await moreRoom(cut, { max_tokens: 4096 }, async () => { throw new Error("max_tokens too large"); }), cut);
  await assert.rejects(moreRoom(cut, { max_tokens: 4096 }, async () => { throw Object.assign(new Error("stopped"), { code: "TASK_STOPPED" }); }), /stopped/);
}));

test("tool calls are a tool turn whatever the finish reason, unless the reply was cut off", () => {
  const call = (finish, args) => convertResponseFromOpenAI({ choices: [{ finish_reason: finish, message: { content: null, tool_calls: [{ id: "c1", function: { name: "sandbox_exec", arguments: args } }] } }] }, "id");
  assert.equal(call("tool_calls", '{"code":"print(1)"}').stop_reason, "tool_use");
  assert.equal(call("stop", '{"code":"print(1)"}').stop_reason, "tool_use", "some providers say stop alongside tool calls");
  assert.equal(call("length", '{"code":"import random\\nfor').stop_reason, "max_tokens", "half its arguments: unfinished, never run");
});

test("an unfinished turn asks for the step again, joined to the tool results", () => {
  assert.match(unfinishedTurn({ stop_reason: "max_tokens" }, "half an ans"), /cut off by the length limit/);
  assert.match(unfinishedTurn({ stop_reason: "end_turn" }, "  "), /stopped without writing anything/);
  assert.equal(unfinishedTurn({ stop_reason: "end_turn" }, "The answer."), null);
  const messages = [{ role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "{}" }] }];
  addNote(messages, "Write it now.");
  assert.equal(messages.length, 1, "no second user turn in a row");
  assert.equal(messages[0].content.at(-1).text, "Write it now.");
  const after = [{ role: "assistant", content: [{ type: "text", text: "x" }] }];
  addNote(after, "Write it now.");
  assert.equal(after.at(-1).role, "user");
});

test("every loop uses it: background runs, their sub-tasks, scheduled runs and chat", () => {
  const agents = read("lib/agents.js");
  assert.equal((agents.match(/require\("\.\/task-model"\)\.unfinishedTurn\(response, (finalText|text)\)/g) || []).length, 2, "the run and its sub-tasks");
  assert.match(agents, /if \(unfinished && retakes < 3\) \{[\s\S]{0,200}addNote\(messages, unfinished\);\n\s*continue;/);
  assert.match(read("lib/automations.js"), /if \(unfinished && retakes < 3\) \{[\s\S]{0,200}addNote\(messages, unfinished\);\n\s*continue;/);
  assert.match(read("lib/task-model.js"), /async function modelCall\(client, params, options = \{\}\) \{\n  return moreRoom\(/);
  assert.match(read("lib/engine.js"), /response = await require\("\.\/task-model"\)\.moreRoom\(response, apiParams, \(roomier\) => llmClient\.messages\.create\(roomier\)\);/);
});
