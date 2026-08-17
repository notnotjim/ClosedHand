// lib/rag.js -- Query embedding helper for the data_cache email path.
// data_cache.embedding is vector(768), unlike data_vectors (1536), so Matryoshka-truncate
// the shared Qwen embedding to 768 + renormalise. Used for both writes (data-sync) and
// queries (match_cached_emails), so both sides stay consistent.

const CACHE_EMBED_DIMS = 768;

/** Embed a query at data_cache dimensions. Returns vector array or null.
 * quick mode: a user is usually waiting on this (search paths); background
 * writes that also route through here just skip the embedding on failure. */
async function embedQuery(text) {
  if (!text) return null;
  const { embedText } = require("./services/usi");
  const full = await embedText(text, { quick: true });
  if (!full) return null;
  const truncated = full.slice(0, CACHE_EMBED_DIMS);
  const norm = Math.sqrt(truncated.reduce((sum, v) => sum + v * v, 0)) || 1;
  return truncated.map(v => v / norm);
}

module.exports = { embedQuery };
