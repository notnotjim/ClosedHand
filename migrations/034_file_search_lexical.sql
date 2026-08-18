-- 034_file_search_lexical.sql — a lexical arm for File Search, and the
-- filename in the search space at all.
--
-- File Search was vector-only. What that could not do, measured against a real
-- 71-document library rather than assumed:
--
--   1. Find a document by its own name. This was the outright failure. The
--      filename is stored (on the document row, and on every chunk as
--      metadata.source_file) and was searched by nothing: it is not in
--      rag_chunks.content and not in the text that gets embedded, which is
--      "[About: <summary>]\n\n<raw chunk>". Searching for a photo by its own
--      filename put it at rank 9 behind eight other photos, scored below the
--      display confidence bar. It now comes back first.
--
--   2. Find an exact term reliably as the library grows. This one is weaker
--      than it first looks and the note is here so nobody re-derives it: the
--      RAW chunk text IS part of what gets embedded, so an identifier is in
--      the vector space, not missing from it. On a small index the vector arm
--      finds it unaided (a part number 240 characters into an inspection
--      report came back at rank 1 with no lexical arm at all). What a dense
--      vector does not give is a GUARANTEE: a rare token contributes little to
--      1536 dimensions summarising 800 tokens, and the top-N cosine cut that
--      is generous on a hundred chunks is not on a hundred thousand. The
--      lexical arm makes exact-term recall independent of index size. That
--      claim is reasoned, not yet measured at scale.
--
-- Both are the same fix as migration 030 made for mail: a real lexical
-- retriever next to the vector one, fused by the caller.
--
-- 'simple' rather than 'english', as in 030: stemming helps neither
-- identifiers nor filenames, and it mangles non-English documents.
--
-- Runner-managed, so every statement is idempotent (see lib/migrations.js).

-- ---------------------------------------------------------------------------
-- Filenames need a split the mail corpus does not.
--
-- Postgres's parser reads "IMG_1038.JPG" as ONE lexeme, img_1038.jpg, so
-- searching for 1038, or for IMG_1038, matches nothing. Splitting on
-- [._-] as well as URL punctuation fixes that, but a split applied to the
-- index and not to the query is silently wrong (see 032), so this function is
-- used on BOTH sides: the index stores the filename twice, verbatim and split,
-- and the query ORs each token's verbatim form with its split form.
--
-- ORing rather than replacing is what keeps this purely additive. Every match
-- that worked before still works; the split form can only add rows.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rag_fts_split(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $split$
  SELECT regexp_replace(coalesce(t, ''), '[/?&=#_.-]+', ' ', 'g')
$split$;

-- Chunk body plus the filename, verbatim and split. Body splits only on URL
-- punctuation, exactly as data_cache_fts does, so INV-000012 keeps lexing the
-- way the query side already expects.
--
-- Changing this body requires rebuilding the column: existing rows hold
-- lexemes built with the old definition and Postgres will not notice.
CREATE OR REPLACE FUNCTION rag_chunk_fts(content text, meta jsonb) RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fts$
  SELECT to_tsvector('simple',
    regexp_replace(coalesce(content, ''), '[/?&=#]+', ' ', 'g') || ' ' ||
    coalesce(meta->>'source_file', '')                          || ' ' ||
    rag_fts_split(meta->>'source_file'))
$fts$;

-- A stored column rather than an expression index, for the reason 031 gives:
-- ts_rank_cd needs the actual tsvector for every row it scores, and
-- recomputing it per match costs far more than the lookup does.
ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS fts tsvector;

CREATE OR REPLACE FUNCTION rag_chunks_fts_trigger() RETURNS trigger
LANGUAGE plpgsql AS $trg$
BEGIN
  NEW.fts := rag_chunk_fts(NEW.content, NEW.metadata);
  RETURN NEW;
END
$trg$;

DROP TRIGGER IF EXISTS trg_rag_chunks_fts ON rag_chunks;
CREATE TRIGGER trg_rag_chunks_fts
  BEFORE INSERT OR UPDATE OF content, metadata ON rag_chunks
  FOR EACH ROW EXECUTE FUNCTION rag_chunks_fts_trigger();

-- The indexer has always written metadata.source_file, but a chunk indexed by
-- some older path without it would be unfindable by name forever, and the name
-- is on the document row regardless. Fill the gap before building the vectors.
UPDATE rag_chunks c
   SET metadata = coalesce(c.metadata, '{}'::jsonb) || jsonb_build_object('source_file', d.name)
  FROM rag_documents d
 WHERE d.id = c.document_id
   AND coalesce(c.metadata->>'source_file', '') = ''
   AND coalesce(d.name, '') <> '';

-- Build every row in committed batches, walking by id. Re-running is safe:
-- it rewrites rather than appends, so a half-finished run resumes correctly
-- and a completed run is an expensive no-op rather than a wrong answer.
CREATE OR REPLACE PROCEDURE rag_chunks_fts_rebuild()
LANGUAGE plpgsql AS $proc$
DECLARE
  last_id uuid := '00000000-0000-0000-0000-000000000000';
  batch_max uuid;
  touched int;
BEGIN
  LOOP
    SELECT max(id) INTO batch_max FROM (
      SELECT id FROM rag_chunks WHERE id > last_id ORDER BY id LIMIT 2000
    ) b;
    EXIT WHEN batch_max IS NULL;

    UPDATE rag_chunks SET fts = rag_chunk_fts(content, metadata)
    WHERE id > last_id AND id <= batch_max;
    GET DIAGNOSTICS touched = ROW_COUNT;

    last_id := batch_max;
    COMMIT;
    EXIT WHEN touched = 0;
  END LOOP;
END
$proc$;

CALL rag_chunks_fts_rebuild();

DROP PROCEDURE IF EXISTS rag_chunks_fts_rebuild();

-- CONCURRENTLY so an install with a large library keeps searching while this
-- builds. This is why the runner executes statements outside a transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rag_chunks_fts
  ON rag_chunks USING gin (fts);

-- ---------------------------------------------------------------------------
-- The lexical arm. Same construction as search_data_cache_lexical: tokens
-- arrive already cleaned from the caller, each is passed through
-- plainto_tsquery individually so the parts of an identifier are ANDed within
-- a token, and distinct tokens are ORed. Handing the raw sentence to
-- websearch_to_tsquery would AND every word and return nothing.
--
-- The one addition is the split alternate per token, which is what makes
-- "1038" find IMG_1038.JPG.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION search_rag_chunks_lexical(
  match_user_id uuid,
  query_tokens text[],
  match_count int DEFAULT 20
) RETURNS TABLE (
  id uuid,
  document_id uuid,
  chunk_index integer,
  content text,
  metadata jsonb,
  rank real
) LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  q tsquery := NULL;
  tok text;
  part tsquery;
  alt tsquery;
  tokq tsquery;
BEGIN
  IF query_tokens IS NULL OR array_length(query_tokens, 1) IS NULL THEN
    RETURN;
  END IF;

  FOREACH tok IN ARRAY query_tokens LOOP
    part := plainto_tsquery('simple', tok);
    alt  := plainto_tsquery('simple', rag_fts_split(tok));
    tokq := NULL;
    IF part IS NOT NULL AND numnode(part) > 0 THEN tokq := part; END IF;
    IF alt IS NOT NULL AND numnode(alt) > 0 AND alt IS DISTINCT FROM part THEN
      tokq := CASE WHEN tokq IS NULL THEN alt ELSE tokq || alt END;
    END IF;
    IF tokq IS NOT NULL THEN
      q := CASE WHEN q IS NULL THEN tokq ELSE q || tokq END;
    END IF;
  END LOOP;

  -- Every token was punctuation or noise: no query, no rows. Returning
  -- everything would hand the fusion step a slab of unranked library.
  IF q IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT rc.id, rc.document_id, rc.chunk_index, rc.content, rc.metadata,
         ts_rank_cd(rc.fts, q) AS rank
  FROM rag_chunks rc
  WHERE rc.user_id = match_user_id
    AND rc.fts @@ q
  ORDER BY rank DESC, rc.chunk_index ASC
  LIMIT match_count;
END
$fn$;
