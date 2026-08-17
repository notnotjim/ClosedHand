-- Bug reports: /bug in any chat captures what the user was looking at when
-- something went wrong, so the moment is not lost by the time anyone looks.
--
-- Rows hold verbatim conversation content and screenshots, so this table is
-- service-role only: RLS is on with no policies, which denies every anon and
-- authenticated request. Nothing user-facing may ever read from it.

create table if not exists bug_reports (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  platform      text,
  chat_id       text,
  comment       text,
  -- Last several turns, already flattened to {role, content} strings with any
  -- base64 stripped. Enough to see what went wrong without storing media twice.
  transcript    jsonb not null default '[]'::jsonb,
  -- [{ path, mediaType }] in the "attachments" storage bucket
  screenshots   jsonb not null default '[]'::jsonb,
  status        text not null default 'open',
  resolution_note text,
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);

create index if not exists bug_reports_open_idx
  on bug_reports (status, created_at desc);

alter table bug_reports enable row level security;
