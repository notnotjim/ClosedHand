// Web search through the person's own AI provider. Each adapter is checked
// against the request and answer its provider documents (read 2026-10-17):
// the right address, the person's key, and titles, links and snippets out.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ADAPTERS, forProvider } = require("../lib/provider-search");

// A stand-in for one provider: records the request, answers as documented.
function provider(answer, status = 200) {
  const seen = [];
  const request = async (url, init) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: status === 200, status, text: async () => JSON.stringify(answer) };
  };
  return { seen, request };
}
const base = { apiKey: "sk-kestrel-test", query: "kestrel point ferry times", count: 3 };

test("DeepSeek's search endpoint, no model involved", async () => {
  const p = provider({ results: [{ title: "Kestrel Ferries", url: "https://ferries.example.net/kestrel", snippet: "short", summary: "Crossings every 40 minutes, last at 22:10.", date: "2026-10-01" }] });
  const out = await ADAPTERS.deepseek.search({ ...base, baseUrl: "https://api.deepseek.com/v1", query: "x".repeat(200), request: p.request });
  assert.equal(p.seen[0].url, "https://api.deepseek.com/v1/tools/search");
  assert.equal(p.seen[0].headers.Authorization, "Bearer sk-kestrel-test");
  assert.equal(p.seen[0].body.query.length, 128, "DeepSeek takes queries of up to 128 characters");
  assert.deepEqual(out.results, [{ title: "Kestrel Ferries", url: "https://ferries.example.net/kestrel", snippet: "Crossings every 40 minutes, last at 22:10.", date: "2026-10-01" }]);
});

test("Moonshot's search endpoint, no model involved", async () => {
  const p = provider({ search_results: [{ title: "Kestrel Ferries", url: "https://ferries.example.net/kestrel", snippet: "Every 40 minutes." }] });
  const out = await ADAPTERS.moonshot.search({ ...base, baseUrl: "https://api.moonshot.ai/v1", request: p.request });
  assert.equal(p.seen[0].url, "https://api.moonshot.ai/v1/tools/search");
  assert.deepEqual(p.seen[0].body, { text_query: "kestrel point ferry times", limit: 3, timeout_seconds: 10 });
  assert.equal(out.results[0].snippet, "Every 40 minutes.");
});

test("OpenRouter's search tool, with the cited text as snippets", async () => {
  const p = provider({ choices: [{ message: { content: "Every 40 minutes [1].", annotations: [
    { type: "url_citation", url_citation: { url: "https://ferries.example.net/kestrel", title: "Kestrel Ferries", content: "Crossings every 40 minutes." } },
    { type: "url_citation", url_citation: { url: "https://ferries.example.net/kestrel", title: "Kestrel Ferries", content: "again" } }] } }] });
  const out = await ADAPTERS.openrouter.search({ ...base, baseUrl: "https://openrouter.ai/api/v1", request: p.request });
  assert.equal(p.seen[0].url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(p.seen[0].body.tools[0].type, "openrouter:web_search");
  assert.deepEqual(out.results, [{ title: "Kestrel Ferries", url: "https://ferries.example.net/kestrel", snippet: "Crossings every 40 minutes." }], "each source once");
  assert.equal(out.summary, "Every 40 minutes [1].");
});

test("xAI's search tool on the person's own model, with page names for numbered citations", async () => {
  const p = provider({ citations: ["https://www.harbour.example.org/times"], output: [{ type: "message", content: [{ type: "output_text", text: "Every 40 minutes.", annotations: [{ type: "url_citation", url: "https://ferries.example.net/kestrel", title: "1" }] }] }] });
  const out = await ADAPTERS.xai.search({ ...base, baseUrl: "https://api.x.ai/v1", model: "grok-harbour", request: p.request });
  assert.equal(p.seen[0].url, "https://api.x.ai/v1/responses");
  assert.equal(p.seen[0].body.model, "grok-harbour");
  assert.deepEqual(out.results.map((r) => [r.title, r.url]), [["ferries.example.net", "https://ferries.example.net/kestrel"], ["harbour.example.org", "https://www.harbour.example.org/times"]]);
  assert.equal(out.summary, "Every 40 minutes.");
});

test("OpenAI's search tool, cited sources first, then the rest it read", async () => {
  const p = provider({ output: [
    { type: "web_search_call", action: { sources: [{ type: "url", url: "https://ferries.example.net/kestrel" }, { type: "url", url: "https://timetables.example.com/k" }] } },
    { type: "message", content: [{ type: "output_text", text: "Every 40 minutes.", annotations: [{ type: "url_citation", url: "https://ferries.example.net/kestrel", title: "Kestrel Ferries" }] }] }] });
  const out = await ADAPTERS.openai.search({ ...base, baseUrl: "https://api.openai.com/v1", request: p.request });
  assert.equal(p.seen[0].url, "https://api.openai.com/v1/responses");
  assert.equal(p.seen[0].body.tool_choice, "required");
  assert.deepEqual(out.results.map((r) => r.title), ["Kestrel Ferries", "timetables.example.com"]);
  assert.equal(ADAPTERS.openai.citeSources, true);
});

test("Anthropic's search tool, with each source's cited text", async () => {
  const p = provider({ content: [
    { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "kestrel point ferry times" } },
    { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://ferries.example.net/kestrel", title: "Kestrel Ferries", encrypted_content: "x" }, { type: "web_search_result", url: "https://timetables.example.com/k", title: "Timetables", encrypted_content: "y" }] },
    { type: "text", text: "Every 40 minutes.", citations: [{ type: "web_search_result_location", url: "https://ferries.example.net/kestrel", title: "Kestrel Ferries", cited_text: "Crossings every 40 minutes." }] }] });
  const out = await ADAPTERS.anthropic.search({ ...base, baseUrl: "https://api.anthropic.com/v1", request: p.request });
  assert.equal(p.seen[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(p.seen[0].headers["x-api-key"], "sk-kestrel-test");
  assert.deepEqual(out.results, [
    { title: "Kestrel Ferries", url: "https://ferries.example.net/kestrel", snippet: "Crossings every 40 minutes." },
    { title: "Timetables", url: "https://timetables.example.com/k", snippet: "" }]);
  assert.equal(ADAPTERS.anthropic.citeSources, true);
});

test("a model that cited nothing, or a refused request, is a failure, so free search takes over", async () => {
  await assert.rejects(ADAPTERS.openai.search({ ...base, baseUrl: "https://api.openai.com/v1", request: provider({ output: [{ type: "message", content: [{ type: "output_text", text: "I can't search." }] }] }).request }), /no search ran/);
  await assert.rejects(ADAPTERS.deepseek.search({ ...base, baseUrl: "https://api.deepseek.com/v1", request: provider({ error: "quota" }, 402).request }), /HTTP 402/);
});

test("providers with no documented search, or terms against this use, have none", () => {
  for (const p of ["gemini", "groq", "deepinfra", "ollama", "custom"]) assert.equal(forProvider(p), null, p);
});
