// lib/services/lexical.js — query tokenising and match windows for the lexical
// arm of hybrid retrieval.
//
// Vendored into webapp/lexical.js: the dashboard is a separate service that
// cannot import from lib/, and File Search runs the same lexical arm over
// rag_chunks that passive recall runs over data_cache. Two copies of the
// tokeniser that drift are two different searches wearing one name, so
// scripts/check-vendored-identical.js holds them together.

// Grammar and filler that carries no retrieval signal in any corpus. Kept
// deliberately short: over-filtering costs recall, and ts_rank_cd already
// discounts terms that appear everywhere.
const LEX_STOP_FILLER = new Set(["the","and","or","from","for","about","with","that","this","has","was","are","did","does","what","when","where","which","who","whom","why","how","any","all","some","said","say","says","tell","find","show","get","give","please","can","you","your","my","me","our","their","his","her","its","have","had","been","were","will","would","should","could","there","here","them","they","she","not","but","out","see","look","need","want","know"]);

// Corpus words, not language words: in a mailbox every row is a message, so
// these separate nothing. In a file library they are ordinary content, and a
// document actually called "Email templates" has to stay findable by its name,
// so this set is applied only where it earns its place.
const LEX_STOP_CORPUS_MAIL = new Set(["email","emails","mail","message","messages"]);

/**
 * Distinctive tokens for the lexical arm. Internal punctuation is kept because
 * that is what identifiers are made of: INV-2024-8837, ABC/123, a.b@c.com.
 *
 * @param {string} query
 * @param {{corpus?: "mail"|"files"}} opts  which corpus-specific stop words apply
 */
function lexicalTokens(query, opts = {}) {
  const corpusStop = opts.corpus === "files" ? null : LEX_STOP_CORPUS_MAIL;
  return String(query || "")
    .split(/\s+/)
    .map(w => w.replace(/^[^\w@]+/, "").replace(/[^\w@]+$/, ""))
    .filter(w => {
      if (w.length <= 2) return false;
      const lower = w.toLowerCase();
      if (LEX_STOP_FILLER.has(lower)) return false;
      return !(corpusStop && corpusStop.has(lower));
    })
    .slice(0, 12);
}

/**
 * A window of text centred on the first matching token, so the thing that
 * caused the match is visible in the snippet. Callers truncate un-enriched
 * content, so a full body handed over raw would routinely cut off the
 * identifier that made the row match at all.
 */
function matchWindow(text, tokens, cap = 360) {
  const body = String(text || "").replace(/\s+/g, " ").trim();
  if (body.length <= cap) return body;
  const lower = body.toLowerCase();
  let at = -1;
  for (const t of tokens) {
    const i = lower.indexOf(t.toLowerCase());
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) return body.substring(0, cap);
  const start = Math.max(0, at - Math.floor(cap / 3));
  const slice = body.substring(start, start + cap);
  return (start > 0 ? "…" : "") + slice + (start + cap < body.length ? "…" : "");
}

module.exports = { lexicalTokens, matchWindow, LEX_STOP_FILLER, LEX_STOP_CORPUS_MAIL };
