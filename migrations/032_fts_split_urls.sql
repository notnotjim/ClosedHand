-- 032_fts_split_urls.sql — find identifiers that live inside URLs.
--
-- Measured against a real 8,000-message account: searching for the booking
-- reference 783760395 returned 7 of the 8 messages containing it. The missed
-- one held the reference only here:
--
--   https://kiwi.com/trips/783760395/disruption-protection/?affilid=crm
--
-- Postgres's text-search parser treats a URL as a single token, so the number
-- never became a lexeme of its own and no query for it could ever match. That
-- matters more than one missed row suggests: travel, delivery and receipt mail
-- routinely puts the reference in a tracking link and nowhere else, which is
-- exactly the mail people search by reference.
--
-- Splitting only [/?&=#] is deliberate. It breaks URL paths and query strings
-- apart while leaving hyphens and dots alone, so INV-000012 and B686W2 keep
-- lexing exactly as before and the query side needs no matching change. A
-- normalisation that touched hyphens would have to be mirrored in the query
-- construction, and a normalisation applied in only one of the two places is
-- silently wrong.
--
-- Runner-managed: idempotent.

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
    coalesce(d->>'body', ''),
    '[/?&=#]+', ' ', 'g'))
$fts$;

-- Existing rows were indexed with the old definition, and Postgres will not
-- notice: the column just quietly holds stale lexemes. Rebuild every row in
-- committed batches, walking by id so the loop makes progress without needing
-- a marker column.
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
