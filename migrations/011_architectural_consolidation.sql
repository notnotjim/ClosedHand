-- Architectural consolidation: rename tables, merge caches, move sync config
-- Run with: supabase db query --linked < migrations/011_architectural_consolidation.sql

-- ============================================================================
-- 1. RENAME service_vectors -> data_vectors
-- ============================================================================

ALTER TABLE IF EXISTS service_vectors RENAME TO data_vectors;

-- Rename indexes to match new table name
ALTER INDEX IF EXISTS idx_sv_embedding RENAME TO idx_dv_embedding;
ALTER INDEX IF EXISTS idx_sv_user RENAME TO idx_dv_user;

-- Drop old RPC function and create new one pointing to data_vectors
DROP FUNCTION IF EXISTS search_service_vectors;

CREATE OR REPLACE FUNCTION search_data_vectors(
  query_embedding vector(768),
  match_user_id uuid,
  match_threshold float DEFAULT 0.3,
  match_count int DEFAULT 15,
  filter_service text DEFAULT NULL
) RETURNS TABLE (
  id uuid,
  service text,
  item_type text,
  external_id text,
  content text,
  source_metadata jsonb,
  enrichment_level text,
  similarity float
) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT
    sv.id,
    sv.service,
    sv.item_type,
    sv.external_id,
    sv.content,
    sv.source_metadata,
    sv.enrichment_level,
    1 - (sv.embedding <=> query_embedding) AS similarity
  FROM data_vectors sv
  WHERE sv.user_id = match_user_id
    AND sv.embedding IS NOT NULL
    AND 1 - (sv.embedding <=> query_embedding) > match_threshold
    AND (filter_service IS NULL OR sv.service = filter_service)
  ORDER BY sv.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- RLS: data_vectors inherits from service_vectors (renamed, policies carry over)
-- If needed, recreate:
ALTER TABLE data_vectors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access data_vectors" ON data_vectors;
CREATE POLICY "Service role full access data_vectors" ON data_vectors FOR ALL USING (auth.role() = 'service_role');

-- ============================================================================
-- 2. MERGE service_data_cache INTO data_cache (then drop)
-- ============================================================================

-- data_cache already has: user_id, source, type, external_id, data (jsonb), synced_at, received_at, embedding
-- service_data_cache had: user_id, service, item_type, external_id, raw_content, metadata, attachment_refs
-- The usi-connector now writes to data_cache using the data jsonb column, so no schema additions needed.

-- Migrate any existing service_data_cache rows into data_cache
INSERT INTO data_cache (user_id, source, type, external_id, data, synced_at)
SELECT
  user_id,
  service AS source,
  item_type AS type,
  external_id,
  jsonb_build_object(
    'raw_content', raw_content,
    'metadata', COALESCE(metadata, '{}'),
    'attachment_refs', COALESCE(attachment_refs, '[]')
  ) AS data,
  COALESCE(updated_at, cached_at, now()) AS synced_at
FROM service_data_cache
ON CONFLICT (user_id, source, external_id) DO NOTHING;

DROP TABLE IF EXISTS service_data_cache;

-- ============================================================================
-- 3. MOVE SYNC CONFIG TO connections TABLE (then drop service_sync_config)
-- ============================================================================

ALTER TABLE connections ADD COLUMN IF NOT EXISTS sync_should_cache boolean;
ALTER TABLE connections ADD COLUMN IF NOT EXISTS sync_strategy text;
ALTER TABLE connections ADD COLUMN IF NOT EXISTS sync_interval_minutes int DEFAULT 15;
ALTER TABLE connections ADD COLUMN IF NOT EXISTS sync_data_types text[] DEFAULT '{}';
ALTER TABLE connections ADD COLUMN IF NOT EXISTS sync_list_method text;
ALTER TABLE connections ADD COLUMN IF NOT EXISTS sync_read_method text;

-- Migrate existing sync configs to connections
UPDATE connections c
SET
  sync_should_cache = s.should_cache,
  sync_strategy = s.sync_strategy,
  sync_interval_minutes = s.sync_interval_minutes,
  sync_data_types = s.data_types,
  sync_list_method = s.list_method,
  sync_read_method = s.read_method
FROM service_sync_config s
WHERE c.user_id = s.user_id AND c.service = s.service;

DROP TABLE IF EXISTS service_sync_config;
