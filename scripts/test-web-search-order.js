// Web search goes: the person's AI provider's own search when it has one and
// they left it on, then free search, which every Closedhand has. A provider
// search that fails goes on to free search.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { webSearch } = require("../lib/web-search");
const { sealConfig } = require("../lib/model-policy");

process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY || Buffer.alloc(32, 7).toString("base64");

const found = [{ title: "Kestrel Point crossings", url: "https://ferries.example.net/kestrel-point", snippet: "Every 40 minutes." }];
function settingsFor(provider) {
  return { model_config: sealConfig({ version: 1, connections: { primary: { provider, backend: "custom", baseUrl: "https://models.example.com/v1", apiKey: "sk-kestrel-test" } },
    roles: { chat: { model: "harbour-1", connection: "primary" } } }) };
}
function fakes({ providerFails = false, freeFails = false } = {}) {
  const calls = [];
  return {
    calls,
    providerSearch: { forProvider: (p) => p === "searchco" ? { label: "SearchCo", search: async (a) => { calls.push(["provider", a.apiKey, a.model, a.query]); if (providerFails) throw new Error("quota spent"); return { results: found }; } } : null },
    freeSearch: async (q) => { calls.push(["free", q]); if (freeFails) throw new Error("web search is unavailable"); return { results: found, source: "DuckDuckGo" }; },
  };
}
const quiet = (fn) => async () => { const warn = console.warn; console.warn = () => {}; try { await fn(); } finally { console.warn = warn; } };

test("a provider with its own search answers with the person's key and chat model", async () => {
  const f = fakes();
  const r = await webSearch("kestrel ferry", 5, { settings: settingsFor("searchco"), ...f });
  assert.equal(r.source, "SearchCo");
  assert.deepEqual(f.calls, [["provider", "sk-kestrel-test", "harbour-1", "kestrel ferry"]]);
});

test("a provider without search, or with it switched off, goes straight to free search", async () => {
  for (const settings of [settingsFor("plainco"), { ...settingsFor("searchco"), web_search_provider: false }, {}]) {
    const f = fakes();
    const r = await webSearch("kestrel ferry", 5, { settings, ...f });
    assert.equal(r.source, "DuckDuckGo");
    assert.deepEqual(f.calls, [["free", "kestrel ferry"]]);
  }
});

test("a failed provider search goes on to free search, and only free search's failure is the answer", quiet(async () => {
  const f = fakes({ providerFails: true });
  const r = await webSearch("kestrel ferry", 5, { settings: settingsFor("searchco"), ...f });
  assert.equal(r.source, "DuckDuckGo");
  assert.deepEqual(f.calls.map(c => c[0]), ["provider", "free"]);
  await assert.rejects(webSearch("kestrel ferry", 5, { settings: {}, ...fakes({ freeFails: true }) }), /unavailable/);
}));
