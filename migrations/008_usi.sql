-- Universal Semantic Index (USI) tables
-- Run in Supabase SQL editor

-- Universal data cache for services without existing sync
CREATE TABLE IF NOT EXISTS service_data_cache (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES profiles(id),
  service text NOT NULL,
  item_type text NOT NULL,
  external_id text NOT NULL,
  raw_content text,
  metadata jsonb DEFAULT '{}',
  attachment_refs jsonb DEFAULT '[]',
  cached_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id, service, external_id)
);

CREATE INDEX IF NOT EXISTS idx_sdc_user_service ON service_data_cache(user_id, service);

-- Universal semantic vector index
CREATE TABLE IF NOT EXISTS service_vectors (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES profiles(id),
  service text NOT NULL,
  item_type text NOT NULL,
  external_id text NOT NULL,
  content text,
  embedding vector(768),
  enrichment_level text DEFAULT 'basic',
  source_metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id, service, external_id)
);

CREATE INDEX IF NOT EXISTS idx_sv_embedding ON service_vectors
USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS idx_sv_user ON service_vectors(user_id, service);

-- Unified semantic search across all services
CREATE OR REPLACE FUNCTION search_service_vectors(
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
  FROM service_vectors sv
  WHERE sv.user_id = match_user_id
    AND sv.embedding IS NOT NULL
    AND 1 - (sv.embedding <=> query_embedding) > match_threshold
    AND (filter_service IS NULL OR sv.service = filter_service)
  ORDER BY sv.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Index progress tracking
CREATE TABLE IF NOT EXISTS index_progress (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES profiles(id),
  service text NOT NULL,
  phase1_total int DEFAULT 0,
  phase1_done int DEFAULT 0,
  phase2_total int DEFAULT 0,
  phase2_done int DEFAULT 0,
  status text DEFAULT 'pending',
  last_sync timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id, service)
);
