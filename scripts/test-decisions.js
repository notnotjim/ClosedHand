const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const provider = require("../lib/decision-provider");
const { triage } = require("../lib/pulse-triage");
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });
const enabled = { typesafe_enabled: true, typesafe_api_key: "fixture-key" };
const items = ["EMAIL from alex@example.test: Please approve today's invoice", "EVENT starting within 3h: Airport transfer"];
const questions = { item_0: { type: "choice", instructions: "Screen state.items[0].", criteria: { flag: "Important", skip: "Not important", uncertain: "Unknown" } } };
function answer(choice, probability = 1, confidence = 1) {
  return { type: "choice", choice, confidence, probabilities: Object.fromEntries(["flag", "skip", "uncertain"].map(c => [c, c === choice ? probability : (1 - probability) / 2])) };
}
function response(answers) { return new Response(JSON.stringify({ model: provider.MODEL, answers })); }
function options(settings = enabled) { return { settings, items, level: "medium", now: "2026-09-23T12:00:00Z" }; }
test("the adapter uses the pinned protocol, fixed origin and only the supplied key", async () => {
  let call;
  const result = await provider.choices(" fixture-key ", { items }, questions, { fetch: async (url, opts) => {
    call = { url, ...opts }; return response({ item_0: answer("flag") });
  } });
  assert.equal(call.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(call.redirect, "error");
  assert.equal(call.headers.Authorization, "Bearer fixture-key");
  assert.equal(call.signal.aborted, false);
  assert.deepEqual(JSON.parse(call.body), { model: provider.MODEL, state: { items }, questions });
  assert.equal(result.item_0.choice, "flag");
});
for (const status of [401, 402, 403, 422, 429, 500, 529]) {
  test("HTTP " + status + " falls back without logging or returning provider secrets", async () => {
    global.fetch = async () => new Response("fixture-key private evidence", { status });
    await assert.rejects(provider.choices("fixture-key", { items }, questions), e => !/fixture-key|private evidence/.test(e.message) && e.status === status);
    let calls = 0;
    const verdict = await triage({ ...options(), fallback: async () => { calls++; return '{"pulse":true,"flagged":["Keep the deadline"]}'; } });
    assert.equal(calls, 1); assert.deepEqual(verdict.flagged, ["Keep the deadline"]);
  });
}
for (const settings of [{}, { typesafe_api_key: "fixture-key" }, { typesafe_enabled: false, typesafe_api_key: "fixture-key" }, { typesafe_enabled: true }]) {
  test("disabled or incomplete connection makes no specialist request: " + JSON.stringify(Object.keys(settings)), async () => {
    let fallbackCalls = 0;
    const verdict = await triage({ ...options(settings), request: () => assert.fail("Jev called while off"),
      fallback: async (system, message, tokens) => {
        fallbackCalls++; assert.match(system, /busy person/);
        assert.equal(message, "New items since last check:\n" + items.join("\n")); assert.equal(tokens, 300);
        return '{"pulse":true,"flagged":["original result"]}';
      } });
    assert.equal(fallbackCalls, 1); assert.deepEqual(verdict, { pulse: true, flagged: ["original result"] });
  });
}
test("confident selections forward original evidence to the composer without a generative triage call", async () => {
  const verdict = await triage({ ...options(), request: async (key, state, qs) => {
    assert.equal(key, enabled.typesafe_api_key); assert.deepEqual(state.items, items);
    assert.match(qs.item_1.instructions, /state.items\[1\]/);
    assert.match(qs.item_0.instructions, /untrusted evidence/);
    return { item_0: answer("flag"), item_1: answer("skip") };
  }, fallback: () => assert.fail("support triage not needed") });
  assert.deepEqual(verdict, { pulse: true, flagged: [items[0]], via: "jev" });
});
test("a confidently unimportant batch bypasses composition", async () => {
  const verdict = await triage({ ...options(), request: async () => ({ item_0: answer("skip"), item_1: answer("skip") }),
    fallback: () => assert.fail("support triage not needed") });
  assert.deepEqual(verdict, { pulse: false, flagged: [], via: "jev" });
});
for (const weak of [answer("uncertain"), answer("skip", 0.97), answer("flag", 0.89), answer("flag", 1, 0.79), answer("skip", 1, 0.89)]) {
  test("uncertainty preserves the entire batch for the configured support LLM: " + JSON.stringify(weak), async () => {
    let calls = 0;
    const verdict = await triage({ ...options(), request: async () => ({ item_0: answer("flag"), item_1: weak }),
      fallback: async (_, message) => { calls++; items.forEach(i => assert.ok(message.includes(i))); return '{"pulse":true,"flagged":["fallback"]}'; } });
    assert.equal(calls, 1); assert.deepEqual(verdict.flagged, ["fallback"]);
  });
}
test("concurrent users keep separate credentials, state and opt-in", async () => {
  const seen = [];
  const request = async (key, state) => { seen.push({ key, items: state.items }); await new Promise(r => setImmediate(r)); return { item_0: answer("flag") }; };
  await Promise.all(["one", "two"].map(id => triage({ ...options({ typesafe_enabled: true, typesafe_api_key: id }), items: [id], request, fallback: () => assert.fail() })));
  assert.deepEqual(seen, [{ key: "one", items: ["one"] }, { key: "two", items: ["two"] }]);
});
test("malformed, missing, foreign and inconsistent answers cannot suppress a pulse", async () => {
  for (const answers of [{}, { wrong: answer("skip") }, { item_0: { ...answer("skip"), confidence: "1" } },
    { item_0: { ...answer("skip"), probabilities: { flag: 1, skip: 1, uncertain: 1 } } },
    { item_0: { ...answer("flag"), choice: "skip" } }, { item_0: answer("skip"), extra: answer("skip") }]) {
    await assert.rejects(provider.choices("fixture-key", { items }, questions, { fetch: async () => response(answers) }));
  }
  await assert.rejects(provider.choices("fixture-key", {}, questions, { fetch: async () => new Response("<html>bad</html>") }));
});
test("oversized inputs stay on the support path without truncating source evidence", async () => {
  const large = ["x".repeat(17000)];
  global.fetch = () => assert.fail("oversized request sent");
  const verdict = await triage({ ...options(), items: large, fallback: async (_, message) => {
    assert.ok(message.includes(large[0])); return '{"pulse":true,"flagged":["full evidence"]}';
  } });
  assert.equal(verdict.flagged[0], "full evidence");
});
test("network errors and exhausted credit produce safe connection errors", async () => {
  global.fetch = async () => { throw new Error("private fixture-key input"); };
  await assert.rejects(provider.validate("fixture-key"), e => !e.message.includes("fixture-key"));
  global.fetch = async () => new Response("balance", { status: 402 });
  await assert.rejects(provider.validate("fixture-key"), /account needs credit/);
});
test("request timeout is bounded and aborts", async () => {
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(provider.choices("fixture-key", {}, questions, { timeoutMs: 5, fetch: async (_, opts) =>
      new Promise((resolve, reject) => opts.signal.addEventListener("abort", () => reject(new Error("timeout")))) }), /could not complete/);
  } finally { clearTimeout(keepAlive); }
});
function fixture() {
  const profiles = { alice: { settings: { marker: "keep" }, updated_at: "2026-09-23T00:00:00.123456Z" }, bob: { settings: { marker: "bob" } } };
  const routes = {};
  let conflict = false, failWrite = false, version = 0;
  const db = { from(table) {
    assert.equal(table, "profiles");
    let id, update, filters = [], reading;
    const query = {
      select() { if (update) return query; reading = true; return query; },
      eq(key, value) { if (key === "id") id = value; else filters.push([key, value]); return query; },
      is(key, value) { filters.push([key, value]); return query; },
      single: async () => ({ data: structuredClone(profiles[id]) }),
      update(values) { update = values; return query; },
      then(resolve, reject) { return Promise.resolve().then(() => {
        if (reading && !update) return { data: [structuredClone(profiles[id])] };
        if (failWrite) return { error: { message: "write failure" } };
        if (conflict || filters.some(([key, value]) => key === "updated_at" ? profiles[id][key] !== value : JSON.stringify(profiles[id][key]) !== value)) return { data: [] };
        profiles[id] = { ...update, updated_at: "revision-" + (++version) };
        return { data: [{ id }] };
      }).then(resolve, reject); },
    };
    return query;
  } };
  require("../webapp/model-config").install({ get: (p, fn) => routes["GET " + p] = fn, post: (p, fn) => routes["POST " + p] = fn },
    { supabase: db, authorize: async req => req.user });
  return { profiles, conflict: () => { conflict = true; }, failWrite: () => { failWrite = true; },
    async invoke(body, user = "alice", method = "POST") {
      const res = { code: 200, status(code) { this.code = code; return this; }, set() { return this; }, json(data) { this.data = data; return this; } };
      await routes[method + " /api/model-config" + (method === "POST" ? "/decisions" : "")]({ body, user }, res);
      return res;
    } };
}
function validateResponse() {
  return response({ connection: { type: "choice", choice: "ready", confidence: 1, probabilities: { ready: 1, other: 0 } } });
}
test("only successful synthetic validation enables Jev, without creating or changing LLM roles", async () => {
  const f = fixture();
  global.fetch = async () => validateResponse();
  const result = await f.invoke({ enabled: true, apiKey: "new-key" });
  assert.equal(result.code, 200); assert.deepEqual(result.data, { decisions: { enabled: true } });
  assert.equal(f.profiles.alice.settings.typesafe_api_key, "new-key");
  assert.equal(f.profiles.alice.settings.model_config, undefined);
  assert.equal(f.profiles.alice.settings.marker, "keep");
  assert.deepEqual(f.profiles.bob.settings, { marker: "bob" });
  const publicSettings = require("../webapp/model-policy").publicSettings(f.profiles.alice.settings);
  assert.ok(!JSON.stringify(publicSettings).includes("new-key"));
  const publicConfig = await f.invoke({}, "alice", "GET");
  assert.equal(publicConfig.data.decisions.enabled, true);
  assert.ok(!JSON.stringify(publicConfig.data).includes("new-key"));
});
test("unfunded or malformed connection leaves all current settings intact", async () => {
  const f = fixture(), before = structuredClone(f.profiles);
  global.fetch = async () => new Response("private", { status: 402 });
  assert.match((await f.invoke({ enabled: true, apiKey: "no-credit" })).data.error, /needs credit/);
  assert.equal((await f.invoke({ enabled: "true", apiKey: "no-credit" })).code, 400);
  assert.deepEqual(f.profiles, before);
});
test("disconnect removes the key without contacting Jev, even with no credit", async () => {
  const f = fixture(); Object.assign(f.profiles.alice.settings, enabled);
  global.fetch = () => assert.fail("disconnect must work offline");
  const result = await f.invoke({ enabled: false });
  assert.equal(result.code, 200); assert.deepEqual(result.data, { decisions: { enabled: false } });
  assert.deepEqual(f.profiles.alice.settings, { marker: "keep" });
});
test("validation preserves unrelated concurrent edits but refuses a newer disconnect", async () => {
  const f = fixture();
  global.fetch = async () => { f.profiles.alice.settings.marker = "changed while checking"; return validateResponse(); };
  assert.equal((await f.invoke({ enabled: true, apiKey: "key-one" })).code, 200);
  assert.equal(f.profiles.alice.settings.marker, "changed while checking");
  global.fetch = async () => { delete f.profiles.alice.settings.typesafe_enabled; delete f.profiles.alice.settings.typesafe_api_key; return validateResponse(); };
  assert.equal((await f.invoke({ enabled: true, apiKey: "key-two" })).code, 400);
  assert.equal(f.profiles.alice.settings.typesafe_enabled, undefined);
});
test("database failures and last-moment conflicts never report an enabled connection", async () => {
  global.fetch = async () => validateResponse();
  for (const failure of ["conflict", "failWrite"]) {
    const f = fixture(); f[failure]();
    assert.equal((await f.invoke({ enabled: true, apiKey: "new-key" })).code, 400);
    assert.deepEqual(f.profiles.alice.settings, { marker: "keep" });
  }
});
