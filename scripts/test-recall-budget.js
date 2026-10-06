// Recall never holds a reply for long. It and the matter pick run together
// under one time budget, the message is embedded once between them, matters
// someone is waiting on go ahead of background indexing in one batch, and in
// Docker the bot comes before the sandbox's browser for processor and memory.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

test("recall that runs late is set aside, and the reply carries on", async () => {
  const engine = read("lib/engine.js");
  const start = engine.indexOf("const RECALL_BUDGET_MS");
  const end = engine.indexOf("\n}\n", engine.indexOf("function withinRecallBudget")) + 2;
  const box = { setTimeout, clearTimeout, console: { log() {} }, Promise };
  vm.runInNewContext(engine.slice(start, end).replace(/= 6000;/, "= 30;") + "\nthis.f = withinRecallBudget;", box);
  assert.equal(await box.f(new Promise(() => {})), null, "late recall resolves to nothing");
  assert.deepEqual(await box.f(Promise.resolve(["context", "matter"])), ["context", "matter"], "a quick one is untouched");
});

test("the engine runs recall and the matter pick together, under the budget, sharing one embedding", () => {
  const engine = read("lib/engine.js");
  assert.match(engine, /const RECALL_BUDGET_MS = 6000;/);
  assert.match(engine, /const recalled = fetchRelevantContext\(userId, userMessage, conversation\.slice\(-5, -1\), \{\n\s*shareEmbedding: \(text, embedding\) => \{ shared = \{ text, embedding \}; \},/);
  assert.match(engine, /matters\.pickTouched\(userId, userMessage, \{\n\s*messageVector: shared\?\.text === userMessage \? shared\.embedding : null,/);
  assert.match(engine, /contextInjection = \(await timing\.time\("recall", withinRecallBudget\(Promise\.all\(\[recalled, picked\]\)\)\)\)\?\.\[0\] \|\| "";/);
  assert.doesNotMatch(engine, /await matters\.pickTouched/, "the pick no longer waits for recall to finish");
});

test("recall hands over its query embedding before it waits on anything", async () => {
  let embeds = 0;
  const deps = {
    "../user-store": { supabase: { from() { const q = { select: () => q, eq: () => q, in: () => q, then: (r) => r({ data: [] }) }; return q; } } },
    "./services/usi": { embedText: async () => { embeds++; return [1]; }, search: async () => ({ results: [] }) },
    "./services/doc-search": { docSearch: () => ({ searchDocuments: async () => ({ results: [] }) }) },
    "./services/reranker": { rerank: async (q, docs) => docs },
    "./services/usi-connector": { activeSources: async () => new Set() },
  };
  const box = { module: { exports: {} }, console: { log() {}, error() {} }, require: (n) => deps[n] };
  vm.runInNewContext(read("lib/brain.js"), box);
  const message = "Is the flight delay going to affect my plans next week at all?";
  const handed = [];
  const run = box.module.exports.fetchRelevantContext("user-a", message, [], { shareEmbedding: (text, p) => handed.push({ text, p }) });
  assert.equal(handed.length, 1, "handed over synchronously, so the matter pick can start at once");
  assert.equal(handed[0].text, message, "a message with no follow-up anchor is searched as written");
  assert.deepEqual(await handed[0].p, [1]);
  await run;
  assert.equal(embeds, 1, "embedded once");
});

function loadMatters(embedLog) {
  const usi = {
    embedText: async (text) => { embedLog.push({ one: text }); return [1, 0]; },
    embedBatch: async (texts, opts) => { embedLog.push({ batch: texts.length, opts }); return texts.map((t) => (/Flat move/.test(t) ? [1, 0] : [0, 1])); },
  };
  const fakes = {
    "./model-wire": { responseText: () => "" },
    "./db": { supabase: { from() { const q = { select: () => q, eq: () => q, order: () => q, delete: () => q, lt: async () => ({}), limit: async () => ({ data: [
      { id: "m-move", title: "Flat move", summary: "Moving flat on the 20th", state: {}, status: "open", last_touched: new Date().toISOString() },
      { id: "m-tax", title: "Tax return", summary: "Self assessment due", state: {}, status: "open", last_touched: new Date().toISOString() },
    ] }) }; return q; } } },
    "./llm": { getInternalClient: () => null },
    "./services/usi": usi,
  };
  // Left in place: matters.js requires the embedder lazily, inside the pick.
  const load = Module._load;
  Module._load = function (request, parent, ...rest) {
    if (parent && /lib[\\/]matters\.js$/.test(parent.filename) && fakes[request]) return fakes[request];
    return load.call(this, request, parent, ...rest);
  };
  delete require.cache[require.resolve("../lib/matters")];
  return require("../lib/matters");
}

test("the matter pick reuses recall's embedding and embeds matters once, in one urgent batch", async () => {
  const log = [];
  const matters = loadMatters(log);
  await matters.warmMatters("user-a");
  const picked = await matters.pickTouched("user-a", "when is the van coming for the move?", { messageVector: Promise.resolve([1, 0]) });
  assert.equal(picked, "m-move");
  assert.equal(log.filter((e) => e.one).length, 0, "the message is not embedded a second time");
  assert.deepEqual(log, [{ batch: 2, opts: { urgent: true } }], "both matters in one call, ahead of background indexing");

  log.length = 0;
  await matters.pickTouched("user-a", "and the tax form?", { messageVector: Promise.resolve([0, 1]) });
  assert.equal(log.length, 0, "unchanged matters are not embedded again");

  await matters.pickTouched("user-a", "anything new on the move?");
  assert.deepEqual(log, [{ one: "anything new on the move?" }], "without recall's vector it embeds the message itself");
});

test("a document someone is waiting on goes ahead of background indexing, framed as a document", () => {
  const src = read("lib/local-models.js");
  assert.match(src, /async function localEmbed\(texts, \{ query = false, urgent = query, dims = 1536 \} = \{\}\)/);
  assert.match(src, /_call\("embed", \{ framed \}, \{ urgent \}\)/);
  assert.match(read("lib/services/usi.js"), /query: !!opts\.quick, urgent: !!\(opts\.quick \|\| opts\.urgent\)/);
});

test("in Docker, the bot comes before the sandbox's browser", () => {
  const compose = read("docker-compose.yml");
  const service = (name) => compose.slice(compose.indexOf(`\n  ${name}:\n`), compose.indexOf("\n\n", compose.indexOf(`\n  ${name}:\n`)));
  assert.match(service("bot"), /\n    mem_reservation: 1536m\n/, "the bot's memory is protected from being swapped out");
  assert.match(service("sandbox"), /\n    cpu_shares: 256\n/, "the sandbox gets a quarter share when the processor is busy");
  assert.doesNotMatch(service("sandbox"), /mem_limit|cpus:/, "no hard cap: the browser still uses an idle computer fully");
});
