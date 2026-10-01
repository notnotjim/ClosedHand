-- 031_data_cache_fts_column.sql — stop recomputing the tsvector per matched row.
--
-- 030 indexed an expression, which made lookups fast but left ranking slow:
-- ts_rank_cd has to hold the actual tsvector for every row it scores, and with
-- an expression index that means re-parsing the full email body out of jsonb,
-- once per match. Measured on a real 7,993-row account: 0.41ms to find the
-- candidates, 180ms to rank them. The cost scales with the number of MATCHES,
-- not with LIMIT, so it is a common word on a big mailbox that hurts:
-- ~0.8ms per matched row is ~2s on a 100k archive and ~11s on 500k, which is
-- an ordinary Gmail account.
--
-- The column is filled by trigger and backfilled in committed batches rather
-- than added as GENERATED, because a generated column rewrites the whole table
-- under an ACCESS EXCLUSIVE lock. On a large mailbox that is minutes of a
-- locked table on someone's only assistant.
--
-- Runner-managed: every statement is idempotent.

ALTER TABLE data_cache ADD COLUMN IF NOT EXISTS fts tsvector;

-- Keep it current from here on. Writers do not know about this column and must
-- not have to: data_cache is written by every sync path.
CREATE OR REPLACE FUNCTION data_cache_fts_trigger() RETURNS trigger
LANGUAGE plpgsql AS $trg$
BEGIN
  NEW.fts := data_cache_fts(NEW.data);
  RETURN NEW;
END
$trg$;

DROP TRIGGER IF EXISTS trg_data_cache_fts ON data_cache;
CREATE TRIGGER trg_data_cache_fts
  BEFORE INSERT OR UPDATE OF data ON data_cache
  FOR EACH ROW EXECUTE FUNCTION data_cache_fts_trigger();

-- Backfill existing rows in committed batches. A procedure rather than a DO
-- block because only a procedure may COMMIT, and committing per batch is what
-- keeps this from being one long transaction holding row locks across an
-- entire mailbox. Re-running is safe and resumes: it only touches NULLs.
CREATE OR REPLACE PROCEDURE data_cache_fts_backfill()
LANGUAGE plpgsql AS $proc$
DECLARE
  touched int;
BEGIN
  LOOP
    UPDATE data_cache SET fts = data_cache_fts(data)
    WHERE id IN (SELECT id FROM data_cache WHERE fts IS NULL LIMIT 2000);
    GET DIAGNOSTICS touched = ROW_COUNT;
    EXIT WHEN touched = 0;
    COMMIT;
  END LOOP;
END
$proc$;

CALL data_cache_fts_backfill();

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_data_cache_fts_col
  ON data_cache USING gin (fts);

-- Rank against the stored column. Same tokens, same OR-of-plainto_tsquery
-- construction as 030; the only change is where the tsvector comes from.
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

  IF q IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT dc.external_id, dc.source, dc.type, dc.data,
         ts_rank_cd(dc.fts, q) AS rank
  FROM data_cache dc
  WHERE dc.user_id = match_user_id
    AND (filter_type IS NULL OR dc.type = filter_type)
    AND dc.fts @@ q
  ORDER BY rank DESC, dc.received_at DESC NULLS LAST
  LIMIT match_count;
END
$fn$;

-- The expression index is now dead weight: nothing queries that shape, and it
-- was 65MB on a 118MB table.
DROP INDEX CONCURRENTLY IF EXISTS idx_data_cache_fts;

DROP PROCEDURE IF EXISTS data_cache_fts_backfill();
