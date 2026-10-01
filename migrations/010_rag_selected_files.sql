-- Add selected_files column to rag_sources for selective file indexing
-- Run with: supabase db query --linked < migrations/010_rag_selected_files.sql

ALTER TABLE rag_sources ADD COLUMN IF NOT EXISTS selected_files jsonb;

-- Update origin check constraint to include cloud storage providers
ALTER TABLE rag_sources DROP CONSTRAINT IF EXISTS rag_sources_origin_check;
ALTER TABLE rag_sources ADD CONSTRAINT rag_sources_origin_check
  CHECK (origin IN ('cloud', 'bridge', 'gdrive', 'onedrive', 'dropbox'));
