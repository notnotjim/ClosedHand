-- Switch data_vectors from Gemini 768-dim to local Qwen3-Embedding 1536-dim
-- (Matryoshka truncation from native 4096, fits pgvector HNSW index limit)

TRUNCATE data_vectors;

ALTER TABLE data_vectors ALTER COLUMN embedding TYPE vector(1536);

DROP INDEX IF EXISTS idx_dv_embedding;
CREATE INDEX idx_dv_embedding ON data_vectors
USING hnsw (embedding vector_cosine_ops);

DROP FUNCTION IF EXISTS search_data_vectors;

CREATE OR REPLACE FUNCTION search_data_vectors(
  query_embedding vector(1536),
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
