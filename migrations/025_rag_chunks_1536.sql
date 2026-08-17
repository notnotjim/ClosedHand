-- File Search (rag_chunks) was created at vector(768) in 005 but the live column
-- and match_rag_chunks RPC were widened to 1536 by hand when File Search moved to
-- Qwen3-Embedding (Matryoshka-truncated to 1536), the same dims data_vectors uses.
-- Migration 012 recorded that switch for data_vectors but nothing recorded it for
-- rag_chunks, so a rebuild from migrations would create a 768 column and every
-- 1536-dim File Search insert would fail. This aligns the schema history with live.
--
-- Non-destructive on the current prod DB: the column is already vector(1536) with
-- real data, so the ALTER is a no-op there. On a fresh rebuild it widens the empty
-- 768 column from 005. There is deliberately NO TRUNCATE here (unlike 012).

ALTER TABLE rag_chunks ALTER COLUMN embedding TYPE vector(1536);

DROP INDEX IF EXISTS idx_rag_chunks_embedding;
CREATE INDEX IF NOT EXISTS idx_rag_chunks_embedding ON rag_chunks
USING hnsw (embedding vector_cosine_ops);

CREATE OR REPLACE FUNCTION match_rag_chunks(
  query_embedding vector(1536),
  match_user_id uuid,
  match_threshold float default 0.3,
  match_count int default 5
)
returns table (
  id uuid,
  document_id uuid,
  chunk_index integer,
  content text,
  metadata jsonb,
  similarity float
)
language sql stable
as $$
  select
    rag_chunks.id,
    rag_chunks.document_id,
    rag_chunks.chunk_index,
    rag_chunks.content,
    rag_chunks.metadata,
    1 - (rag_chunks.embedding <=> query_embedding) as similarity
  from rag_chunks
  where rag_chunks.user_id = match_user_id
    and 1 - (rag_chunks.embedding <=> query_embedding) > match_threshold
  order by rag_chunks.embedding <=> query_embedding
  limit match_count;
$$;
