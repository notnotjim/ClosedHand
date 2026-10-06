// Someone waiting on an answer goes ahead of background indexing: the local
// models' worker gets one call at a time, a query or rerank jumps every
// background batch, background batches go one document at a time, and they
// hold off for a moment after a call someone is waiting on, so a reply's next
// step (the rerank after the query) never waits behind indexing.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

process.env.LOCAL_EMBED_MODEL_ID = "test-embed";
process.env.LOCAL_RERANK_MODEL_ID = "test-rerank";

const posted = [];
let worker = null;
class FakeWorker extends EventEmitter {
  constructor() { super(); worker = this; }
  postMessage(msg) { posted.push(msg); }
  unref() {}
}
const load = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === "worker_threads" && parent && /local-models\.js$/.test(parent.filename)) return { Worker: FakeWorker };
  return load.call(this, request, parent, ...rest);
};
const lm = require("../lib/local-models");
Module._load = load;

const tick = () => new Promise((r) => setImmediate(r));
// The worker answers the call in flight; each embedded text comes back as [its length].
function answer() {
  const msg = posted[posted.length - 1];
  const result = msg.op === "embed" ? msg.args.framed.map((t) => [t.length]) : msg.op === "rerank" ? msg.args.docs.map(() => 0.5) : true;
  worker.emit("message", { id: msg.id, ok: true, result });
}

test("a query jumps the background work, which goes one document at a time and holds off while someone waits", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const docs = ["a", "bb", "ccc", "dddd"];
  const background = lm.localEmbed(docs, { dims: 1 });
  await tick();
  assert.equal(posted.length, 1, "one call at a time");
  assert.equal(posted[0].args.framed.length, 1, "background goes one document at a time");

  const query = lm.localEmbed(["when do I leave?"], { query: true, dims: 1 });
  const rerank = lm.localRerankScores("q", ["x", "y"]);
  await tick();
  assert.equal(posted.length, 1, "nothing else while a call is running");

  answer(); await tick();
  assert.match(posted[1].args.framed[0], /^task: search result \| query: when do I leave\?/, "the query goes next, ahead of the background pieces");
  answer(); await tick();
  assert.equal(posted[2].op, "rerank", "then the rerank");
  answer(); await tick();
  assert.equal(posted.length, 3, "background holds off right after a call someone waited on");
  t.mock.timers.tick(2500); await tick();
  assert.equal(posted.length, 4, "and carries on after the pause");
  for (let i = 0; i < 3; i++) { assert.equal(posted[3 + i].args.framed.length, 1); answer(); await tick(); }

  assert.equal((await query).length, 1);
  assert.deepEqual(await rerank, [0.5, 0.5]);
  const rows = await background;
  assert.deepEqual(rows.map((r) => r[0]), docs.map((d) => `title: none | text: ${d}`.length), "pieces come back in order");
});

test("a failed call does not stall the queue", async () => {
  const start = posted.length;
  const first = lm.localEmbed(["one"], { query: true, dims: 1 });
  const second = lm.localEmbed(["two"], { query: true, dims: 1 });
  await tick();
  worker.emit("message", { id: posted[start].id, ok: false, error: "boom" });
  await assert.rejects(first, /boom/);
  await tick();
  assert.equal(posted.length, start + 2, "the next call still goes");
  answer();
  assert.equal((await second).length, 1);
});
