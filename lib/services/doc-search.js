// lib/services/doc-search.js — hybrid retrieval over the File Search index
// (rag_chunks), one implementation for every caller.
//
// Vendored into webapp/doc-search.js and held byte-identical by
// scripts/check-vendored-identical.js: the dashboard's File Search endpoint,
// the bot's search_documents tool and rag_retrieve all answer "which document
// is this about" and there is no version of that question that deserves a
// worse retriever depending on which door it came in through. Dependencies
// are injected, which is what lets the two copies stay identical across the
// service boundary: the bot embeds through services/usi and the webapp
// through rag-processor, and each brings its own supabase client.
//
// Two retrievers over the same library, as passive recall does over mail.
//
// The filename is the case the vector arm cannot cover. It is not in
// rag_chunks.content and not in the embedded text, so a photo searched by its
// own name came back at rank 9 behind eight other photos, below the
// confidence bar. Only the lexical arm reads it.
//
// Exact terms in the body are a weaker case than they look, and the note is
// here so nobody removes that arm on the strength of a small index: the raw
// chunk IS part of what gets embedded, so a dense vector alone already finds
// an identifier when there are a hundred chunks to choose from. What it does
// not give is a guarantee that survives the top-N cut on a library a thousand
// times bigger.

const { lexicalTokens } = require("./lexical");

// A 0.25 recall threshold is right for feeding the reranker, but wrong as a
// display bar: with a small index the nearest neighbour is returned no matter
// how unrelated, so "picture with blue eyes" surfaced a credit-card
// spreadsheet at 30% as though it were an answer. Weak hits are flagged so a
// caller can say "nothing really matched" instead of presenting noise as a
// result. Relevance comes from the reranker, not cosine. Measured on a real
// index for "blue eyes": cosine spans 0.350-0.399 for BOTH the seven correct
// photos and an empty timetable document, so no cosine threshold can separate
// them. The cross-encoder reads query and document together and returns
// 4.2e-1 down to 9.6e-2 for the genuine matches, then falls off a cliff to
// 8.0e-4 and below for everything else: a ~120x gap.
const RELEVANT = 0.05;   // clearly about the query
const PLAUSIBLE = 0.005; // worth offering, below the cliff
const RRF_K = 60;

// Reported once: a missing lexical index degrades search rather than breaking
// it, but it should not do so silently.
let _lexUnavailableReported = false;

/**
 * @param {object} deps
 * @param {object} deps.supabase  client for the database holding rag_chunks
 * @param {(text: string) => Promise<number[]|null>} deps.embed  1536-dim query embedder
 * @param {(query: string, docs: object[], topK: number) => Promise<object[]>} deps.rerank
 */
function docSearch({ supabase, embed, rerank }) {

  async function lexicalArm(userId, tokens) {
    if (!tokens.length) return [];
    try {
      const { data, error } = await supabase.rpc("search_rag_chunks_lexical", {
        match_user_id: userId,
        query_tokens: tokens,
        match_count: 40,
      });
      if (error) {
        if (!_lexUnavailableReported) {
          _lexUnavailableReported = true;
          console.log(`[RAG] Lexical search unavailable (${error.message}); running vector-only. Apply migration 034 to enable it.`);
        }
        return [];
      }
      return data || [];
    } catch (e) {
      if (!_lexUnavailableReported) {
        _lexUnavailableReported = true;
        console.log(`[RAG] Lexical search failed (${e.message}); running vector-only.`);
      }
      return [];
    }
  }

  /**
   * Hybrid search over indexed documents. Returns one row per DOCUMENT (the
   * best chunk carried whole), tiered so an exact name match leads, trimmed of
   * the noise tail, capped at 30.
   *
   * Returns { results, no_strong_matches } or { error }.
   */
  async function searchDocuments(userId, query) {
    const tokens = lexicalTokens(query, { corpus: "files" });

    // Split a filename the way the lexical index does, so "IMG_1038.JPG",
    // "IMG_1038" and "1038" agree here exactly as they do in Postgres. Whole
    // tokens only: matching on substrings would make "report" hit
    // "QualityControlReport20180905" and the tier would stop meaning anything.
    const nameParts = (s) => String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const queryNameParts = [...new Set(tokens.flatMap(nameParts))];
    const isNameMatch = (docName) => {
      if (queryNameParts.length === 0) return false;
      const have = new Set(nameParts(docName));
      return queryNameParts.every(t => have.has(t));
    };

    // Both arms in parallel: the lexical arm is a GIN index scan and the
    // vector arm is dominated by the query embed, so hybrid costs one round
    // trip, not the sum of the two.
    const [embedding, lexRows] = await Promise.all([
      Promise.resolve().then(() => embed(query)).catch(() => null),
      lexicalArm(userId, tokens),
    ]);

    let vecRows = [];
    if (embedding) {
      const { data: matches, error } = await supabase.rpc("match_rag_chunks", {
        query_embedding: JSON.stringify(embedding),
        match_user_id: userId,
        match_threshold: 0.25,
        // Fetch deep once. The expensive parts of a search (embedding the
        // query, the vector scan) happen per request, not per result, so
        // pulling 40 and paging client-side costs the same as pulling 10.
        match_count: 40,
      });
      if (error) return { error: error.message };
      vecRows = matches || [];
    }

    // A dead embedder no longer means a dead search: lexical alone is a
    // genuine result set, not a consolation prize.
    if (!embedding && lexRows.length === 0) {
      return { error: "Embedding failed" };
    }

    // Reciprocal Rank Fusion, keyed on the chunk. Cosine similarity and
    // ts_rank_cd are on incomparable, query-dependent scales, so any fixed
    // blend needs calibration that drifts; RRF reads only ordinal position and
    // degrades to "whatever the other arm found" when one returns nothing.
    // This decides which candidates the cross-encoder sees and nothing more:
    // the reranker below is the only component that reads query and document
    // together, so it is the only one whose ordering is a quality judgement.
    const fused = new Map();
    const contribute = (m, i, arm) => {
      const key = m.id || `${arm}:${i}`;
      const prev = fused.get(key);
      if (!prev) { fused.set(key, { row: m, score: 1 / (RRF_K + i + 1), arms: new Set([arm]) }); return; }
      prev.score += 1 / (RRF_K + i + 1);
      prev.arms.add(arm);
      // The stored row stays the vector one for a hit both arms found: it is
      // contributed first and it is the one carrying the similarity the
      // fallback below reads when the reranker is unavailable.
    };
    vecRows.forEach((m, i) => contribute(m, i, "vec"));
    lexRows.forEach((m, i) => contribute(m, i, "lex"));

    const merged = [...fused.values()].sort((a, b) => b.score - a.score);

    // Enrich with document names + origin/path
    const docIds = [...new Set(merged.map(x => x.row.document_id))];
    let docMap = {};
    if (docIds.length > 0) {
      const { data: docs } = await supabase.from("rag_documents").select("id, name, origin, file_path").in("id", docIds);
      for (const d of docs || []) docMap[d.id] = d;
    }

    let results = merged.map(({ row: m, arms }) => {
      const doc = docMap[m.document_id] || {};
      return {
        document_id: m.document_id,
        document_name: doc.name || "Unknown",
        origin: doc.origin || null,
        file_path: doc.file_path || null,
        content: m.content || "",
        _chunk_content: m.content || "",
        similarity: m.similarity,
        chunk_index: m.chunk_index,
        metadata: m.metadata || {},
        _arms: [...arms].join("+"),
      };
    });

    // Rerank for better relevance (graceful fallback if reranker unavailable).
    try {
      // Judge on the name AND the body. For a search by filename the name is
      // the whole match, and scoring a photo's empty body against its own
      // name would send every filename hit off the cliff below. The body goes
      // back afterwards, because callers show the name separately.
      //
      // Every candidate, not a top slice: the collapse below needs a score for
      // each chunk to pick the one that represents its document, and a chunk
      // trimmed here would take its document with it. This costs nothing
      // extra, the reranker already scores the whole array and topK only
      // decides how much of it comes back.
      const judged = await rerank(query, results.map(r => ({ ...r, content: r.document_name + "\n" + r.content })), results.length);
      results = judged.map(r => ({ ...r, content: r._chunk_content }));
    } catch (e) { /* unranked, in RRF order; the collapse and cap still apply */ }

    // A result is a document, not a chunk. Retrieval works on chunks because
    // that is the unit that gets embedded, but a person searching a library is
    // looking for a file: one inspection report held ranks 1, 3 and 4 of its
    // own result page, which reads as three findings and is one, and pushed
    // the other matching documents off the top.
    //
    // Collapsing AFTER the reranker, not before, is the point: the chunk that
    // represents a document should be chosen by the component that reads the
    // query and the text together. RRF order would have picked by ordinal
    // agreement between two retrievers, which is candidate-set bookkeeping and
    // says nothing about which passage actually answers the question.
    //
    // The winning chunk is carried whole (content, chunk_index, metadata), so
    // callers can show, expand or quote the passage that matched rather than
    // an arbitrary one.
    {
      const byDoc = new Map();
      for (const r of results) {
        const prev = byDoc.get(r.document_id);
        if (!prev) { byDoc.set(r.document_id, { ...r, chunk_matches: 1 }); continue; }
        const matches = prev.chunk_matches + 1;
        // ?? -Infinity: with the reranker unavailable nothing is scored, and
        // the first chunk seen wins, which is RRF order rather than arbitrary.
        const winner = (r._rerank_score ?? -Infinity) > (prev._rerank_score ?? -Infinity) ? { ...r } : prev;
        winner.chunk_matches = matches;
        byDoc.set(r.document_id, winner);
      }
      results = [...byDoc.values()];
    }

    const scored = results.map(r => ({
      ...r,
      relevance: r._rerank_score,
      _name_match: isNameMatch(r.document_name),
      low_confidence: r._rerank_score !== undefined
        ? r._rerank_score < RELEVANT
        // Reranker unavailable. Cosine is the fallback for a vector hit, but a
        // lexical-only hit has no cosine and does not need one: the query term
        // is literally in the text or the filename.
        : r.similarity === undefined ? false : (r.similarity || 0) < 0.35,
    }));

    // Typing a document's name should return that document, and the
    // cross-encoder has no way to say so. It ranks topical relevance, and
    // asked for "EASY IMEX INSPECTION REPORT" it is not wrong about the QC
    // report whose text mentions Easy Imex inspections throughout; it is
    // answering a question about the subject rather than the request for a
    // named file.
    //
    // Measured on the same library both ways, because the gap is not a tuning
    // problem in either: reranking chunk text alone scores the correctly named
    // documents 0.36 and 0.27 against 1.00 for the QC report, and reranking
    // the name with the text lifts them to 0.98 against 0.999. Far apart or
    // nearly equal, the named document loses. So this is a sort tier and not
    // an adjustment to the score, which would need a different magic number
    // for each of those distributions and would still be guessing.
    scored.sort((a, b) => {
      const an = a._name_match && (a.relevance === undefined || a.relevance >= PLAUSIBLE);
      const bn = b._name_match && (b.relevance === undefined || b.relevance >= PLAUSIBLE);
      if (an !== bn) return an ? -1 : 1;
      return (b.relevance ?? -Infinity) - (a.relevance ?? -Infinity);
    });

    // Trim the noise tail rather than padding to a fixed count. Returning a
    // quarter of a small index guarantees junk on page one, which is what put
    // an empty date-grid document among photos of people. Keep a few below the
    // cliff so a poor query still shows its closest content, flagged as weak.
    let out = scored;
    if (scored.some(r => r.relevance !== undefined)) {
      const keep = scored.filter(r => (r.relevance ?? 0) >= PLAUSIBLE);
      out = keep.length >= 3 ? keep : scored.slice(0, 5);
    }
    out = out.slice(0, 30);
    const no_strong_matches = out.length > 0 && out.every(r => r.low_confidence);

    // _chunk_content is scaffolding for the rerank round trip, not payload.
    return {
      results: out.map(({ _chunk_content, ...r }) => r),
      no_strong_matches,
    };
  }

  return { searchDocuments };
}

module.exports = { docSearch };
