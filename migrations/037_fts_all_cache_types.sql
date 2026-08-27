-- 037_fts_all_cache_types.sql — the exact-word index covers every cache type.
--
-- data_cache_fts was written when the cache held mail and calendar, and its
-- key list said so: subject, from, to, body and friends. Every writer added
-- since stores different keys, and none of them were indexed. WhatsApp
-- messages (text, sender, chat_name), Slack threads (text) and Notion pages
-- (title, content) were all invisible to the exact-word arm: stored in full,
-- findable by meaning where a vector existed, and unmatchable by the literal
-- words in them. A booking reference in a WhatsApp message could not be found
-- by typing the booking reference.
--
-- Purely additive: the mail and calendar keys keep lexing exactly as before,
-- so every match that worked before still works. Same URL-splitting as 032,
-- for the same reason, applied to the same combined string.
--
-- search_data_cache_lexical also gains synced_at in its return, so callers
-- can report cache freshness without a second query. That changes the
-- function's return shape, which CREATE OR REPLACE refuses, hence the DROP.
-- Existing callers destructure named fields from row objects, so the extra
-- column is invisible to them.
--
-- Runner-managed: every statement is idempotent (see lib/migrations.js).

CREATE OR REPLACE FUNCTION data_cache_fts(d jsonb) RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fts$
  SELECT to_tsvector('simple', regexp_replace(
    coalesce(d->>'subject', '')     || ' ' ||
    coalesce(d->>'summary', '')     || ' ' ||
    coalesce(d->>'from', '')        || ' ' ||
    coalesce(d->>'to', '')          || ' ' ||
    coalesce(d->>'location', '')    || ' ' ||
    coalesce(d->>'description', '') || ' ' ||
    coalesce(d->>'snippet', '')     || ' ' ||
    coalesce(d->>'body', '')        || ' ' ||
    coalesce(d->>'text', '')        || ' ' ||
    coalesce(d->>'sender', '')      || ' ' ||
    coalesce(d->>'chat_name', '')   || ' ' ||
    coalesce(d->>'title', '')       || ' ' ||
    coalesce(d->>'content', ''),
    '[/?&=#]+', ' ', 'g'))
$fts$;

-- Existing rows hold lexemes built with the old definition and Postgres will
-- not notice. Rebuild in committed batches, walking by id, as 032 did.
CREATE OR REPLACE PROCEDURE data_cache_fts_rebuild()
LANGUAGE plpgsql AS $proc$
DECLARE
  last_id uuid := '00000000-0000-0000-0000-000000000000';
  batch_max uuid;
  touched int;
BEGIN
  LOOP
    SELECT max(id) INTO batch_max FROM (
      SELECT id FROM data_cache WHERE id > last_id ORDER BY id LIMIT 2000
    ) b;
    EXIT WHEN batch_max IS NULL;

    UPDATE data_cache SET fts = data_cache_fts(data)
    WHERE id > last_id AND id <= batch_max;
    GET DIAGNOSTICS touched = ROW_COUNT;

    last_id := batch_max;
    COMMIT;
    EXIT WHEN touched = 0;
  END LOOP;
END
$proc$;

CALL data_cache_fts_rebuild();

DROP PROCEDURE IF EXISTS data_cache_fts_rebuild();

DROP FUNCTION IF EXISTS search_data_cache_lexical(uuid, text[], int, text);

CREATE FUNCTION search_data_cache_lexical(
  match_user_id uuid,
  query_tokens text[],
  match_count int DEFAULT 20,
  filter_type text DEFAULT NULL
) RETURNS TABLE (
  external_id text,
  source text,
  type text,
  data jsonb,
  rank real,
  synced_at timestamptz
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
         ts_rank_cd(dc.fts, q) AS rank, dc.synced_at
  FROM data_cache dc
  WHERE dc.user_id = match_user_id
    AND (filter_type IS NULL OR dc.type = filter_type)
    AND dc.fts @@ q
  ORDER BY rank DESC, dc.received_at DESC NULLS LAST
  LIMIT match_count;
END
$fn$;
