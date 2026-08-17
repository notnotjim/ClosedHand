-- RAG Library: vector search over uploaded documents
-- Run with: supabase db query --linked < migrations/005_rag_library.sql

create extension if not exists vector;

create table if not exists rag_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  name text not null,
  file_type text not null,
  mime_type text,
  size_bytes bigint not null default 0,
  chunk_count integer not null default 0,
  status text not null default 'pending',
  error_message text,
  metadata jsonb default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_rag_documents_user on rag_documents(user_id, created_at desc);
create index if not exists idx_rag_documents_status on rag_documents(user_id, status);

create table if not exists rag_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references rag_documents(id) on delete cascade,
  user_id uuid not null,
  chunk_index integer not null,
  content text not null,
  embedding vector(768),
  metadata jsonb default '{}',
  created_at timestamptz not null default now()
);

create index if not exists idx_rag_chunks_document on rag_chunks(document_id, chunk_index);
create index if not exists idx_rag_chunks_user on rag_chunks(user_id);

alter table rag_documents enable row level security;
alter table rag_chunks enable row level security;

create policy "Service role full access rag_documents" on rag_documents for all using (auth.role() = 'service_role');
create policy "Service role full access rag_chunks" on rag_chunks for all using (auth.role() = 'service_role');

create or replace function match_rag_chunks(
  query_embedding vector(768),
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
