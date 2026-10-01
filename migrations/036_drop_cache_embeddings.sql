-- 036_drop_cache_embeddings.sql — remove the cache-side email embeddings.
--
-- data_cache carried a second, smaller embedding per email: 768 dims, written
-- by the sync loop one API call per message, read by exactly one RPC,
-- match_cached_emails. When explicit email search moved onto the same hybrid
-- retriever passive recall uses (usi.search over data_vectors + the lexical
-- index), that RPC lost its last caller, which made the whole chain dead
-- weight: every sync paid per-message embedding calls, with rate-limit sleeps,
-- to maintain an index nothing read. The real 1536-dim embedding lives in
-- data_vectors via the USI indexer and is unaffected.
--
-- The column goes rather than being left to quietly fill: a vector column
-- nothing reads is a standing invitation for the write side to be
-- reintroduced, and it was costing an ivfflat index's upkeep on every upsert.
--
-- Runner-managed, so every statement is idempotent (see lib/migrations.js).

DROP FUNCTION IF EXISTS public.match_cached_emails(vector, uuid, double precision, integer);

DROP INDEX IF EXISTS data_cache_embedding_idx;

ALTER TABLE data_cache DROP COLUMN IF EXISTS embedding;
