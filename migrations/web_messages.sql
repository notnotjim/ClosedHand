-- Web chat messages table
-- Bridges the webapp (server.js) and bot (index.js) via Supabase

create table web_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id),
  direction text not null check (direction in ('inbound', 'outbound')),
  content text,
  file_data jsonb,
  status text default 'pending' check (status in ('pending', 'processing', 'complete', 'error')),
  created_at timestamptz default now()
);

-- Enable Realtime
alter publication supabase_realtime add table web_messages;

-- Index for efficient polling/queries
create index idx_web_messages_user_dir on web_messages(user_id, direction, created_at);

-- Add is_anonymous flag to profiles (for anonymous web chat users)
alter table profiles add column if not exists is_anonymous boolean default false;
