-- 030_hybrid_lexical_search.sql — a real lexical retriever alongside the vector one.
--
-- Why data_cache and not data_vectors: data_vectors.content is the LLM's
-- two-or-three sentence summary, or the first 500 characters when un-enriched.
-- An invoice number in the body of a long email is usually not in that table at
-- all, so indexing it would miss exactly the queries this exists to serve.
-- data_cache holds the full row.
--
-- 'simple' rather than 'english': stemming helps neither identifiers nor the
-- Japanese and Turkish mail in real mailboxes, and it would mangle both.
--
-- Runner-managed, so every statement is idempotent (see lib/migrations.js).

-- One IMMUTABLE function used by BOTH the index and the query. Inlining the
-- expression in two places invites them to drift, at which point the planner
-- silently stops using the index and every search becomes a sequential scan.
-- Changing this body requires REINDEX: existing index entries were built with
-- the old definition and Postgres will not notice.
CREATE OR REPLACE FUNCTION data_cache_fts(d jsonb) RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fts$
  SELECT to_tsvector('simple',
    coalesce(d->>'subject', '')     || ' ' ||
    coalesce(d->>'summary', '')     || ' ' ||
    coalesce(d->>'from', '')        || ' ' ||
    coalesce(d->>'to', '')          || ' ' ||
    coalesce(d->>'location', '')    || ' ' ||
    coalesce(d->>'description', '') || ' ' ||
    coalesce(d->>'snippet', '')     || ' ' ||
    coalesce(d->>'body', '')
  )
$fts$;

-- CONCURRENTLY so an existing install with a full cache is not locked out of
-- its own mail while this builds. This is why the runner executes statements
-- outside a transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_data_cache_fts
  ON data_cache USING gin (data_cache_fts(data));

-- Tokens arrive already cleaned from the caller. Each is passed through
-- plainto_tsquery individually and the results are OR-ed, which is the only
-- construction that handles identifiers correctly: 'INV-2024-8837' lexes to
-- 'inv' & '-2024' & '-8837', so the parts must be ANDed within a token while
-- distinct tokens are ORed. Handing the raw sentence to websearch_to_tsquery
-- would AND every word and return nothing.
CREATE OR REPLACE FUNCTION search_data_cache_lexical(
  match_user_id uuid,
  query_tokens text[],
  match_count int DEFAULT 20,
  filter_type text DEFAULT NULL
) RETURNS TABLE (
  external_id text,
  source text,
  type text,
  data jsonb,
  rank real
) LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  q tsquery := NULL;
  tok text;
  part tsquery;
BEGIN
  IF query_tokens IS NULL OR array_length(query_tokens, 1) IS NULL THEN
    RETURN;
  END IF;

  FOREACH tok IN ARRAY query_tokens LOOP
    part := plainto_tsquery('simple', tok);
    IF part IS NOT NULL AND numnode(part) > 0 THEN
      q := CASE WHEN q IS NULL THEN part ELSE q || part END;
    END IF;
  END LOOP;

  -- Every token was punctuation or noise: no query, no rows. Returning
  -- everything would hand the fusion step a slab of unranked cache.
  IF q IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT dc.external_id, dc.source, dc.type, dc.data,
         ts_rank_cd(data_cache_fts(dc.data), q) AS rank
  FROM data_cache dc
  WHERE dc.user_id = match_user_id
    AND (filter_type IS NULL OR dc.type = filter_type)
    AND data_cache_fts(dc.data) @@ q
  ORDER BY rank DESC, dc.received_at DESC NULLS LAST
  LIMIT match_count;
END
$fn$;
