// lib/web-search.js -- how the web_search tool searches the web.
//
// In order: a search service the person connected, with its "Closedhand's
// search" switch on (lib/connection-jobs.js), since connecting one is the
// sign they want it used; then their AI provider's own search, when the
// provider has one and they left it on (Settings, Models;
// lib/provider-search.js); then free search (lib/web-search-fallback.js),
// which every Closedhand has and nobody pays for. Each that fails goes on to
// the next, so an outage or a spent balance never ends a search.

// The chat model's connection, when model settings name one. A "custom"
// connection at a known provider's address is that provider.
function chatConnection(settings) {
  let conn = null;
  try { conn = require("./model-policy").getRole(settings, "chat") || null; } catch (_) { return null; }
  if (!conn) return null;
  const { BASES } = require("./model-policy");
  const base = String(conn.baseUrl || "").replace(/\/+$/, "");
  const provider = conn.provider === "custom" ? Object.keys(BASES).find((k) => BASES[k] === base) || "custom" : conn.provider;
  return { ...conn, provider, baseUrl: base || BASES[provider] || "" };
}

// What a connected search service sent back, as a list of results where it
// has one.
function asResults(text) {
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j)) return j;
    for (const k of ["results", "organic", "organic_results", "items", "data", "web"]) {
      if (Array.isArray(j?.[k])) return j[k];
      if (Array.isArray(j?.[k]?.results)) return j[k].results;
    }
    return [j];
  } catch { return [{ text }]; }
}

async function webSearch(query, count = 5, {
  settings = {}, userId = null,
  connected = require("./connection-jobs"),
  providerSearch = require("./provider-search"), freeSearch = require("./web-search-fallback").freeSearch,
} = {}) {
  count = Math.max(1, Math.min(Number(count) || 5, 10));
  const own = userId ? await connected.run(userId, "search", { query }).catch(() => null) : null;
  if (own) return { results: asResults(own.text).slice(0, Math.max(count, 10)), source: own.source };
  const conn = chatConnection(settings);
  const adapter = conn && settings.web_search_provider !== false ? providerSearch.forProvider(conn.provider) : null;
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
