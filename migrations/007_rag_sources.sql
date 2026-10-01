-- RAG Source Connectors: index folders from Cloud Computer / Local Computer
-- Run with: supabase db query --linked < migrations/007_rag_sources.sql

create table if not exists rag_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  origin text not null check (origin in ('cloud', 'bridge')),
  path text not null,
  file_count integer not null default 0,
  chunk_count integer not null default 0,
  status text not null default 'pending' check (status in ('pending', 'indexing', 'ready', 'error')),
  error_message text,
  last_indexed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, origin, path)
);

create index if not exists idx_rag_sources_user on rag_sources(user_id);

-- Add source tracking to existing documents
alter table rag_documents add column if not exists source_id uuid references rag_sources(id) on delete cascade;
alter table rag_documents add column if not exists origin text;
alter table rag_documents add column if not exists file_path text;
alter table rag_documents add column if not exists file_modified_at timestamptz;

create index if not exists idx_rag_documents_source on rag_documents(source_id);
create index if not exists idx_rag_documents_path on rag_documents(user_id, file_path);

alter table rag_sources enable row level security;
create policy "Service role full access rag_sources" on rag_sources for all using (auth.role() = 'service_role');
