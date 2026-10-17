// lib/provider-search.js -- web search through the person's own AI provider,
// with the key they already gave it, charged by that provider.
//
// One adapter per provider that documents a search the person's key can use,
// each on its own: nothing here is shared between providers, and none is
// preferred. Read from each provider's docs on 2026-10-17:
//   DeepSeek, Moonshot: a search endpoint of its own, no model involved.
//   OpenRouter, xAI, OpenAI, Anthropic: a search tool inside one small model
//   call, whose short answer comes back too, with the sources it cited.
// Left out: Gemini, whose terms forbid passing search results to another model
// or mixing them with other content; Groq and DeepInfra, whose search price or
// answer format is not documented; Ollama, which has no search of its own on
// the person's computer. Any failure here goes on to free search.

const TIMEOUT_MS = 20000;

async function post(url, headers, body, request = fetch) {
  const res = await request(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  try { return JSON.parse(text); } catch (_) { throw new Error("the answer could not be read"); }
}
const bearer = (key) => ({ Authorization: `Bearer ${key}` });
const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch (_) { return url; } };
const ask = (query) => `Search the web for: ${query}\n\nThen say briefly what the sources found, with their figures and dates.`;
// The sources a model-backed search cited, once each, in order.
function cited(list, count) {
  const seen = new Set(), out = [];
  for (const r of list) {
    if (!r || !/^https?:\/\//.test(r.url || "") || seen.has(r.url)) continue;
    seen.add(r.url);
    out.push({ title: r.title && !/^\d+$/.test(r.title) ? r.title : host(r.url), url: r.url, snippet: r.snippet || "" });
    if (out.length >= count) break;
  }
  return out;
}
// A model-backed search that cited nothing did not search.
function done(results, summary) {
  if (!results.length) throw new Error("no search ran");
  return { results, summary: String(summary || "").trim().slice(0, 4000) };
}

const ADAPTERS = {
  deepseek: {
    label: "DeepSeek",
    async search({ baseUrl, apiKey, query, count, request }) {
      const data = await post(`${baseUrl}/tools/search`, bearer(apiKey), { query: query.slice(0, 128), count }, request);
      return { results: (data.results || []).slice(0, count).map((r) => ({ title: r.title || host(r.url), url: r.url, snippet: (r.summary || r.snippet || "").slice(0, 800), ...(r.date ? { date: r.date } : {}) })) };
    },
  },
  moonshot: {
    label: "Moonshot",
    async search({ baseUrl, apiKey, query, count, request }) {
      const data = await post(`${baseUrl}/tools/search`, bearer(apiKey), { text_query: query, limit: count, timeout_seconds: 10 }, request);
      return { results: (data.search_results || []).slice(0, count).map((r) => ({ title: r.title || host(r.url), url: r.url, snippet: (r.snippet || "").slice(0, 800), ...(r.date ? { date: r.date } : {}) })) };
    },
  },
  openrouter: {
    label: "OpenRouter",
    async search({ baseUrl, apiKey, query, count, request }) {
      const data = await post(`${baseUrl}/chat/completions`, bearer(apiKey), {
        model: "deepseek/deepseek-v4-flash", max_tokens: 800,
        messages: [{ role: "user", content: ask(query) }],
        tools: [{ type: "openrouter:web_search", parameters: { engine: "parallel", mode: "turbo", max_results: count, max_uses: 1 } }],
      }, request);
      const message = data.choices?.[0]?.message || {};
      const notes = (message.annotations || []).filter((a) => a.type === "url_citation").map((a) => a.url_citation || a);
      return done(cited(notes.map((n) => ({ title: n.title, url: n.url, snippet: (n.content || "").slice(0, 800) })), count), typeof message.content === "string" ? message.content : "");
    },
  },
  xai: {
    label: "xAI",
    async search({ baseUrl, apiKey, model, query, count, request }) {
      const data = await post(`${baseUrl}/responses`, bearer(apiKey), { model, input: [{ role: "user", content: ask(query) }], tools: [{ type: "web_search" }] }, request);
      const parts = (data.output || []).filter((o) => o.type === "message").flatMap((o) => o.content || []);
      const notes = parts.flatMap((p) => p.annotations || []).filter((a) => a.type === "url_citation");
      const urls = notes.map((a) => ({ url: a.url, title: a.title })).concat((data.citations || []).map((url) => ({ url })));
      return done(cited(urls, count), parts.map((p) => p.text || "").join("\n"));
    },
  },
  openai: {
    label: "OpenAI",
    citeSources: true,
    async search({ baseUrl, apiKey, query, count, request }) {
      const data = await post(`${baseUrl}/responses`, bearer(apiKey), {
        model: "gpt-5-nano", reasoning: { effort: "low" }, tools: [{ type: "web_search" }], tool_choice: "required",
        include: ["web_search_call.action.sources"], input: ask(query),
      }, request);
      const parts = (data.output || []).filter((o) => o.type === "message").flatMap((o) => o.content || []);
      const notes = parts.flatMap((p) => p.annotations || []).filter((a) => a.type === "url_citation").map((a) => ({ url: a.url, title: a.title }));
      const sources = (data.output || []).filter((o) => o.type === "web_search_call").flatMap((o) => o.action?.sources || []).map((s) => ({ url: s.url }));
      return done(cited(notes.concat(sources), count), parts.map((p) => p.text || "").join("\n"));
    },
  },
  anthropic: {
    label: "Anthropic",
    citeSources: true,
    async search({ baseUrl, apiKey, query, count, request }) {
      const data = await post(`${baseUrl}/messages`, { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, {
        model: "claude-haiku-4-5", max_tokens: 1024,
        messages: [{ role: "user", content: ask(query) }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
      }, request);
      const blocks = data.content || [];
      const quotes = new Map();
      for (const b of blocks) for (const c of b.citations || []) if (c.url && c.cited_text && !quotes.has(c.url)) quotes.set(c.url, c.cited_text);
      const found = blocks.filter((b) => b.type === "web_search_tool_result" && Array.isArray(b.content)).flatMap((b) => b.content)
        .filter((r) => r.type === "web_search_result").map((r) => ({ title: r.title, url: r.url, snippet: quotes.get(r.url) || "" }));
      return done(cited(found, count), blocks.filter((b) => b.type === "text").map((b) => b.text).join(""));
    },
  },
};

function forProvider(provider) { return ADAPTERS[provider] || null; }
module.exports = { forProvider, ADAPTERS };
