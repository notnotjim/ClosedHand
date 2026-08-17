// lib/services/reranker.js — Post-retrieval reranking with a cross-encoder.
// Hosted (Qwen3-Reranker on DeepInfra) when a key exists; a small local model
// (fetched on first need) when RERANK_MODEL says local:*; passthrough otherwise.

function _rconf(k) { return require("../config").getConfCached(k); }
const DEEPINFRA_API_KEY = () => process.env.DEEPINFRA_API_KEY || _rconf("DEEPINFRA_API_KEY");
const RERANK_URL = process.env.RERANK_API_URL || "https://api.deepinfra.com/v1/inference/Qwen/Qwen3-Reranker-8B";
const RERANK_MODEL = () => process.env.RERANK_MODEL || _rconf("RERANK_MODEL") || "";
const isLocalRerank = () => String(RERANK_MODEL()).startsWith("local:");

/**
 * Rerank documents by relevance to a query.
 * @param {string} query - The search query
 * @param {Array<{content: string, [key: string]: any}>} documents - Objects with at least a 'content' field
 * @param {number} topK - How many to return (default 10)
 * @returns {Array} - Reranked documents, best first. Original objects with added _rerank_score.
 */
function _wordSet(text) {
  return new Set(
    String(text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/).filter(w => w.length > 2).slice(0, 100)
  );
}

function _overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / Math.min(a.size, b.size);
}

async function rerank(query, documents, topK = 10) {
  const hosted = !!DEEPINFRA_API_KEY() && !isLocalRerank();
  if ((!hosted && !isLocalRerank()) || !query || !documents || documents.length === 0) return documents;
  // Reranking REORDERS, it does not only trim. Skipping when the caller wants
  // as many results as it passed in silently left them in raw vector order,
  // which is how paged File Search lost its ranking entirely.
  if (documents.length <= 1) return documents;

  try {
    let scores;
    if (isLocalRerank()) {
      // Local cross-encoder on the interactive search path: shorter texts and
      // a capped candidate set keep the added latency bounded on weak CPUs.
      const docTexts = documents.map(d => (d.content || JSON.stringify(d)).substring(0, 512));
      const cap = Math.min(documents.length, 20);
      const { localRerankScores } = require("../local-models");
      const localScores = await localRerankScores(query, docTexts.slice(0, cap));
      scores = docTexts.map((_, i) => (i < cap ? localScores[i] : -1));
    } else {
      const docTexts = documents.map(d => (d.content || JSON.stringify(d)).substring(0, 2000));
      const resp = await fetch(RERANK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${DEEPINFRA_API_KEY()}` },
        body: JSON.stringify({
          // DeepInfra scores query/document pairs, so the query repeats per document
          queries: docTexts.map(() => query),
          documents: docTexts,
        }),
      });

      if (!resp.ok) {
        console.log(`[Reranker] Error: ${resp.status}`);
        return documents.slice(0, topK);
      }

      const data = await resp.json();
      scores = data.scores || [];
    }
    if (scores.length !== documents.length) {
      console.log(`[Reranker] Score count mismatch (${scores.length} vs ${documents.length})`);
      return documents.slice(0, topK);
    }

    const ranked = documents
      .map((d, i) => ({ ...d, _rerank_score: scores[i] }))
      .sort((a, b) => b._rerank_score - a._rerank_score);

    // MMR-lite: greedy-select top results while skipping near-duplicates
    // (email threads produce many high-scoring copies of the same content,
    // and pointwise scoring can't see redundancy across candidates).
    const picked = [];
    const pickedSets = [];
    const skipped = [];
    for (const doc of ranked) {
      if (picked.length >= topK) break;
      const ws = _wordSet(doc.content);
      if (pickedSets.some(p => _overlap(ws, p) > 0.75)) { skipped.push(doc); continue; }
      picked.push(doc);
      pickedSets.push(ws);
    }
    // Underfilled (heavy duplication): top back up with best skipped docs
    for (const doc of skipped) {
      if (picked.length >= topK) break;
      picked.push(doc);
    }
    return picked;
  } catch (e) {
    console.log(`[Reranker] Failed (${e.message}), returning unranked`);
    return documents.slice(0, topK);
  }
}

module.exports = { rerank };
