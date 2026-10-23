// lib/web-search.js -- how the web_search tool searches the web.
//
// A search service the person connected, with its "Closedhand's search"
// switch on, goes before all of this (lib/connection-jobs.js takeOver, run
// before every tool). Then, in order: their LLM provider's own search, when
// the provider has one (lib/provider-search.js), as part of the LLM they
// chose; then free search (lib/web-search-fallback.js), which every
// Closedhand has and nobody pays for. A provider search that
// fails goes on to free search, so an outage or a spent balance never ends a
// search.

// The chat model's connection, when model settings name one. A "custom"
// connection at a known provider's address is that provider.
function chatConnection(settings) {
  let conn = null;
  try { conn = require("./model-policy").getRole(settings, "chat") || null; } catch (_) { return null; }
  // Chat run on the computer running Closedhand searches through the
  // provider it falls back to (webapp/run-here.js); the runner has no search.
  if (conn?.provider === "here") conn = conn.fallback || null;
  if (!conn) return null;
  const { BASES } = require("./model-policy");
  const base = String(conn.baseUrl || "").replace(/\/+$/, "");
  const provider = conn.provider === "custom" ? Object.keys(BASES).find((k) => BASES[k] === base) || "custom" : conn.provider;
  return { ...conn, provider, baseUrl: base || BASES[provider] || "" };
}

async function webSearch(query, count = 5, {
  settings = {},
  providerSearch = require("./provider-search"), freeSearch = require("./web-search-fallback").freeSearch,
} = {}) {
  count = Math.max(1, Math.min(Number(count) || 5, 10));
  const conn = chatConnection(settings);
  const adapter = conn ? providerSearch.forProvider(conn.provider) : null;
  if (adapter) {
    try {
      const found = await adapter.search({ ...conn, query, count });
      return { results: found.results, source: adapter.label, ...(found.summary ? { summary: found.summary } : {}), ...(adapter.citeSources ? { cite: true } : {}) };
    }
    catch (e) { console.warn(`[web-search] went on to free search: ${adapter.label}: ${e.message}`); }
  }
  const free = await freeSearch(query, count);
  return { results: free.results, source: free.source };
}

module.exports = { webSearch };
