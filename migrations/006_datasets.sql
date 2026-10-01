-- Datasets: structured data layer for automations and bot tools
-- Enables persistent state across automation runs

create table if not exists datasets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  name text not null,
  columns jsonb not null default '[]',
  description text,
  automation_id uuid,
  row_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, name)
);

create index if not exists idx_datasets_user on datasets(user_id);

create table if not exists dataset_rows (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references datasets(id) on delete cascade,
  user_id uuid not null,
  data jsonb not null default '{}',
  row_index integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_dataset_rows_dataset on dataset_rows(dataset_id, row_index);
create index if not exists idx_dataset_rows_user on dataset_rows(user_id);

alter table datasets enable row level security;
alter table dataset_rows enable row level security;

create policy "Service role full access datasets" on datasets for all using (auth.role() = 'service_role');
create policy "Service role full access dataset_rows" on dataset_rows for all using (auth.role() = 'service_role');
