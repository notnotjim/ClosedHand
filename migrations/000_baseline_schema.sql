-- ClosedHand — consolidated baseline schema for a fresh self-hosted install.
--
-- This single file creates the entire current schema on vanilla Postgres +
-- pgvector. It is the canonical schema for a new install; the numbered
-- incremental migrations (001_*.sql onward) are historical and are superseded
-- by this baseline for fresh installs.
--
-- Reconstructed from the reference deployment's catalog (columns/defaults/
-- nullability, constraints, indexes, functions). Verified: no triggers, views,
-- sequences, or generated columns. Supabase-specific objects are deliberately
-- excluded (auth-schema RLS policies, the realtime publication, the auth/
-- storage/realtime/vault schemas) — a self-hosted install owns its own identity.
--
-- Extensions: only `vector` is required. gen_random_uuid() is core in PG13+.
-- Table order is FK-safe: profiles first, then dependants.

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- profiles — the root identity table. NOTE: on Supabase, profiles.id has no
-- FK to auth.users, so this schema is completely free of the auth schema.
-- An OSS install can own its own identity table with no changes.
-- ---------------------------------------------------------------------------
CREATE TABLE profiles (
  id uuid NOT NULL,
  display_name text,
  email text,
  timezone text DEFAULT 'Europe/London'::text,
  settings jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  is_anonymous boolean DEFAULT false,
  CONSTRAINT profiles_pkey PRIMARY KEY (id)
);

-- ---------------------------------------------------------------------------
-- agent_tasks — no FK to profiles in prod.
-- progress/tools_used are NATIVE text[] (matters for the driver's encoder).
-- ---------------------------------------------------------------------------
CREATE TABLE agent_tasks (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  goal text NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  model text DEFAULT 'claude-haiku-4-5-20251001'::text NOT NULL,
  platform text NOT NULL,
  chat_id text NOT NULL,
  result text,
  progress text[],
  messages jsonb,
  tools_used text[],
  error text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  completed_at timestamp with time zone,
  title text,
  success_criteria jsonb,
  CONSTRAINT agent_tasks_pkey PRIMARY KEY (id)
);

CREATE TABLE attachments (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  attachment_id text NOT NULL,
  file_name text NOT NULL,
  description text,
  media_type text,
  storage_path text NOT NULL,
  size_bytes integer,
  created_at timestamp with time zone DEFAULT now(),
  direction text,
  CONSTRAINT attachments_pkey PRIMARY KEY (id),
  CONSTRAINT attachments_user_id_attachment_id_key UNIQUE (user_id, attachment_id),
  CONSTRAINT attachments_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE
);

-- task_tools / output_destinations are NATIVE text[].
CREATE TABLE automations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  name text NOT NULL,
  description text DEFAULT ''::text NOT NULL,
  status text DEFAULT 'active'::text NOT NULL,
  trigger_type text DEFAULT 'manual'::text NOT NULL,
  trigger_cron text,
  trigger_timezone text DEFAULT 'Europe/London'::text,
  trigger_human_schedule text,
  trigger_event_source text,
  trigger_event_condition text,
  task_prompt text DEFAULT ''::text NOT NULL,
  task_model text DEFAULT 'sonnet'::text NOT NULL,
  task_tools text[] DEFAULT '{}'::text[] NOT NULL,
  task_use_cloud boolean DEFAULT false NOT NULL,
  task_max_duration integer DEFAULT 900 NOT NULL,
  output_destinations text[] DEFAULT '{chat_platforms,dashboard}'::text[] NOT NULL,
  output_urgent boolean DEFAULT false NOT NULL,
  chain_target_id uuid,
  platform text DEFAULT 'dashboard'::text NOT NULL,
  chat_id text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT automations_pkey PRIMARY KEY (id),
  CONSTRAINT automations_user_id_name_key UNIQUE (user_id, name),
  CONSTRAINT automations_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE,
  CONSTRAINT automations_chain_target_id_fkey FOREIGN KEY (chain_target_id) REFERENCES automations(id) ON DELETE SET NULL,
  CONSTRAINT automations_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'idle'::text]))),
  CONSTRAINT automations_trigger_type_check CHECK ((trigger_type = ANY (ARRAY['manual'::text, 'scheduled'::text, 'event'::text])))
);

-- NOTE for the driver's type-aware encoder: tools_used is NATIVE text[], but
-- progress and messages are jsonb here (unlike agent_tasks, where progress is
-- text[]). Same column name, different type across the two tables.
CREATE TABLE automation_runs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  automation_id uuid,
  user_id uuid NOT NULL,
  status text DEFAULT 'running'::text NOT NULL,
  model text,
  tools_used text[] DEFAULT '{}'::text[] NOT NULL,
  progress jsonb DEFAULT '[]'::jsonb NOT NULL,
  messages jsonb DEFAULT '[]'::jsonb NOT NULL,
  input_context text,
  output_summary text,
  full_report text,
  error text,
  started_at timestamp with time zone DEFAULT now() NOT NULL,
  completed_at timestamp with time zone,
  duration_secs integer,
  triggered_by text DEFAULT 'manual'::text,
  chain_source_id uuid,
  platform text DEFAULT 'dashboard'::text NOT NULL,
  chat_id text,
  CONSTRAINT automation_runs_pkey PRIMARY KEY (id),
  CONSTRAINT automation_runs_automation_id_fkey FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE CASCADE,
  CONSTRAINT automation_runs_chain_source_id_fkey FOREIGN KEY (chain_source_id) REFERENCES automation_runs(id) ON DELETE SET NULL,
  CONSTRAINT automation_runs_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE,
  CONSTRAINT automation_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'pending'::text, 'success'::text, 'failed'::text, 'cancelled'::text])))
);

-- user_id is TEXT here, not uuid, and there is no FK. Faithful to prod.
CREATE TABLE bridge_requests (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id text NOT NULL,
  action text NOT NULL,
  params jsonb DEFAULT '{}'::jsonb,
  status text DEFAULT 'pending'::text NOT NULL,
  result jsonb,
  error text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT bridge_requests_pkey PRIMARY KEY (id)
);

CREATE TABLE bug_reports (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  platform text,
  chat_id text,
  comment text,
  transcript jsonb DEFAULT '[]'::jsonb NOT NULL,
  screenshots jsonb DEFAULT '[]'::jsonb NOT NULL,
  status text DEFAULT 'open'::text NOT NULL,
  resolution_note text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  resolved_at timestamp with time zone,
  CONSTRAINT bug_reports_pkey PRIMARY KEY (id)
);

-- user_id is TEXT here, not uuid. Faithful to prod.
CREATE TABLE canvases (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id text NOT NULL,
  filename text NOT NULL,
  mime_type text NOT NULL,
  content text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT canvases_pkey PRIMARY KEY (id)
);

-- The reference deployment has UNIQUE (platform, platform_user_id) only, but the
-- app upserts chat_links with onConflict (user_id, platform) (webapp/server.js:1710)
-- — "one link per user per platform" — which hard-errors 42P10 on vanilla Postgres
-- without a matching unique. This baseline adds that UNIQUE (it coexists with the
-- platform/platform_user_id one), making the upsert correct on a self-hosted DB.
CREATE TABLE chat_links (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  platform text NOT NULL,
  platform_user_id text,
  activation_code text,
  linked_at timestamp with time zone DEFAULT now(),
  expires_at timestamp with time zone,
  CONSTRAINT chat_links_pkey PRIMARY KEY (id),
  CONSTRAINT chat_links_platform_platform_user_id_key UNIQUE (platform, platform_user_id),
  CONSTRAINT chat_links_user_id_platform_key UNIQUE (user_id, platform),
  CONSTRAINT chat_links_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id)
);

-- sync_data_types is NATIVE text[]; tokens/config/metadata are jsonb.
CREATE TABLE connections (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  service text NOT NULL,
  tokens jsonb DEFAULT '{}'::jsonb NOT NULL,
  config jsonb DEFAULT '{}'::jsonb,
  connected_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  metadata jsonb,
  sync_should_cache boolean,
  sync_strategy text,
  sync_interval_minutes integer DEFAULT 15,
  sync_data_types text[] DEFAULT '{}'::text[],
  sync_list_method text,
  sync_read_method text,
  CONSTRAINT connections_pkey PRIMARY KEY (id),
  CONSTRAINT connections_user_id_service_key UNIQUE (user_id, service),
  CONSTRAINT connections_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE
);

-- No FK and no UNIQUE on user_id in prod.
CREATE TABLE conversation_threads (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  title text,
  messages jsonb DEFAULT '[]'::jsonb,
  summary text,
  is_active boolean DEFAULT true,
  platform text DEFAULT 'web'::text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  archived boolean DEFAULT false NOT NULL,
  CONSTRAINT conversation_threads_pkey PRIMARY KEY (id)
);

CREATE TABLE conversations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  messages jsonb DEFAULT '[]'::jsonb,
  summary text,
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT conversations_pkey PRIMARY KEY (id),
  CONSTRAINT conversations_user_id_key UNIQUE (user_id),
  CONSTRAINT conversations_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE
);

-- The (user_id, source, external_id) uniqueness is a UNIQUE INDEX, not a table
-- constraint (created below). ON CONFLICT works against either, so upserts are
-- fine — but it must be created for them to work.
CREATE TABLE data_cache (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  source text NOT NULL,
  type text NOT NULL,
  external_id text NOT NULL,
  data jsonb NOT NULL,
  synced_at timestamp with time zone DEFAULT now() NOT NULL,
  received_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT data_cache_pkey PRIMARY KEY (id)
);

-- Constraint names are the prod ones (table was renamed from service_vectors).
CREATE TABLE data_vectors (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  service text NOT NULL,
  item_type text NOT NULL,
  external_id text NOT NULL,
  content text,
  embedding vector(1536),
  enrichment_level text DEFAULT 'basic'::text,
  source_metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT service_vectors_pkey PRIMARY KEY (id),
  CONSTRAINT service_vectors_user_id_service_external_id_key UNIQUE (user_id, service, external_id),
  CONSTRAINT service_vectors_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id)
);

CREATE TABLE datasets (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  name text NOT NULL,
  columns jsonb DEFAULT '[]'::jsonb NOT NULL,
  description text,
  automation_id uuid,
  row_count integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT datasets_pkey PRIMARY KEY (id),
  CONSTRAINT datasets_user_id_name_key UNIQUE (user_id, name)
);

CREATE TABLE dataset_rows (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  dataset_id uuid NOT NULL,
  user_id uuid NOT NULL,
  data jsonb DEFAULT '{}'::jsonb NOT NULL,
  row_index integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT dataset_rows_pkey PRIMARY KEY (id),
  CONSTRAINT dataset_rows_dataset_id_fkey FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE
);

-- Constraint names are the prod ones (table was renamed from notes).
-- value is TEXT holding a pre-stringified JSON string — must never be
-- re-encoded by the driver's write path.
CREATE TABLE facts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  key text NOT NULL,
  value text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT notes_pkey PRIMARY KEY (id),
  CONSTRAINT notes_user_id_key_key UNIQUE (user_id, key),
  CONSTRAINT notes_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE
);

CREATE TABLE index_progress (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  service text NOT NULL,
  phase1_total integer DEFAULT 0,
  phase1_done integer DEFAULT 0,
  phase2_total integer DEFAULT 0,
  phase2_done integer DEFAULT 0,
  status text DEFAULT 'pending'::text,
  last_sync timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT index_progress_pkey PRIMARY KEY (id),
  CONSTRAINT index_progress_user_id_service_key UNIQUE (user_id, service),
  CONSTRAINT index_progress_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id)
);

CREATE TABLE pulse_config (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  enabled boolean DEFAULT false,
  interval_minutes integer DEFAULT 30,
  quiet_hours_start integer DEFAULT 22,
  quiet_hours_end integer DEFAULT 8,
  last_run timestamp with time zone,
  last_notified timestamp with time zone,
  settings jsonb DEFAULT '{}'::jsonb,
  proactive_level text DEFAULT 'medium'::text,
  delivery_platforms jsonb DEFAULT '[]'::jsonb,
  CONSTRAINT pulse_config_pkey PRIMARY KEY (id),
  CONSTRAINT pulse_config_user_id_key UNIQUE (user_id),
  CONSTRAINT pulse_config_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE
);

CREATE TABLE rag_sources (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  origin text NOT NULL,
  path text NOT NULL,
  file_count integer DEFAULT 0 NOT NULL,
  chunk_count integer DEFAULT 0 NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  error_message text,
  last_indexed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  selected_files jsonb,
  account text,
  CONSTRAINT rag_sources_pkey PRIMARY KEY (id),
  CONSTRAINT rag_sources_user_id_origin_path_key UNIQUE (user_id, origin, path),
  CONSTRAINT rag_sources_origin_check CHECK ((origin = ANY (ARRAY['cloud'::text, 'bridge'::text, 'gdrive'::text, 'onedrive'::text, 'dropbox'::text]))),
  CONSTRAINT rag_sources_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'indexing'::text, 'ready'::text, 'error'::text])))
);

CREATE TABLE rag_documents (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  name text NOT NULL,
  file_type text NOT NULL,
  mime_type text,
  size_bytes bigint DEFAULT 0 NOT NULL,
  chunk_count integer DEFAULT 0 NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  error_message text,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  source_id uuid,
  origin text,
  file_path text,
  file_modified_at timestamp with time zone,
  CONSTRAINT rag_documents_pkey PRIMARY KEY (id),
  CONSTRAINT rag_documents_source_id_fkey FOREIGN KEY (source_id) REFERENCES rag_sources(id) ON DELETE CASCADE
);

CREATE TABLE rag_chunks (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  document_id uuid NOT NULL,
  user_id uuid NOT NULL,
  chunk_index integer NOT NULL,
  content text NOT NULL,
  embedding vector(1536),
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT rag_chunks_pkey PRIMARY KEY (id),
  CONSTRAINT rag_chunks_document_id_fkey FOREIGN KEY (document_id) REFERENCES rag_documents(id) ON DELETE CASCADE
);

CREATE TABLE sandboxes (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  railway_service_id text NOT NULL,
  hostname text NOT NULL,
  sandbox_token text NOT NULL,
  status text DEFAULT 'active'::text,
  volume_size_mb integer DEFAULT 1024,
  created_at timestamp with time zone DEFAULT now(),
  last_used_at timestamp with time zone DEFAULT now(),
  total_exec_count integer DEFAULT 0,
  metadata jsonb DEFAULT '{}'::jsonb,
  CONSTRAINT sandboxes_pkey PRIMARY KEY (id),
  CONSTRAINT sandboxes_user_id_key UNIQUE (user_id),
  CONSTRAINT sandboxes_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id)
);

CREATE TABLE schedules (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  name text NOT NULL,
  cron_expression text NOT NULL,
  task text NOT NULL,
  enabled boolean DEFAULT true,
  last_run timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  chat_id text,
  run_once boolean,
  archived_at timestamp with time zone,
  CONSTRAINT schedules_pkey PRIMARY KEY (id),
  CONSTRAINT schedules_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE
);

-- PK is user_id, so .upsert(..., { onConflict: "user_id" }) works.
CREATE TABLE user_bridges (
  user_id uuid NOT NULL,
  token text NOT NULL,
  status text DEFAULT 'connected'::text,
  pairing_code text,
  paired_at timestamp with time zone DEFAULT now(),
  CONSTRAINT user_bridges_pkey PRIMARY KEY (user_id),
  CONSTRAINT user_bridges_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE
);

-- tools_discovered is NATIVE text[].
CREATE TABLE user_mcps (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  name text NOT NULL,
  server_url text NOT NULL,
  auth_token text,
  auth_type text DEFAULT 'bearer'::text,
  status text DEFAULT 'connected'::text,
  tools_discovered text[] DEFAULT '{}'::text[],
  installed_via text DEFAULT 'manual'::text,
  created_at timestamp with time zone DEFAULT now(),
  oauth_client_id text,
  oauth_client_secret text,
  oauth_refresh_token text,
  oauth_token_url text,
  oauth_token_expiry bigint,
  logo_url text,
  CONSTRAINT user_mcps_pkey PRIMARY KEY (id),
  CONSTRAINT user_mcps_user_id_server_url_key UNIQUE (user_id, server_url),
  CONSTRAINT user_mcps_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE
);

CREATE TABLE user_rules (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  rule text NOT NULL,
  active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  source text DEFAULT 'user'::text,
  CONSTRAINT user_rules_pkey PRIMARY KEY (id)
);

CREATE TABLE user_skills (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  source_url text,
  content text NOT NULL,
  category text DEFAULT 'custom'::text,
  installed_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT user_skills_pkey PRIMARY KEY (id),
  CONSTRAINT user_skills_user_id_name_key UNIQUE (user_id, name),
  CONSTRAINT user_skills_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE
);

-- PK is phone, so .upsert(..., { onConflict: "phone" }) works.
CREATE TABLE wa_pending_links (
  phone text NOT NULL,
  token text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT wa_pending_links_pkey PRIMARY KEY (phone),
  CONSTRAINT wa_pending_links_token_key UNIQUE (token)
);

CREATE TABLE web_messages (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid,
  direction text NOT NULL,
  content text,
  file_data jsonb,
  status text DEFAULT 'pending'::text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT web_messages_pkey PRIMARY KEY (id),
  CONSTRAINT web_messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id),
  CONSTRAINT web_messages_direction_check CHECK ((direction = ANY (ARRAY['inbound'::text, 'outbound'::text]))),
  CONSTRAINT web_messages_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'complete'::text, 'error'::text])))
);

-- ---------------------------------------------------------------------------
-- Indexes (constraint-backed ones already created above)
-- ---------------------------------------------------------------------------

CREATE INDEX idx_agent_tasks_user ON public.agent_tasks USING btree (user_id, status);

CREATE INDEX idx_automations_user ON public.automations USING btree (user_id);
CREATE INDEX idx_automations_active ON public.automations USING btree (user_id, status) WHERE (status = 'active'::text);

CREATE INDEX idx_runs_automation ON public.automation_runs USING btree (automation_id);
CREATE INDEX idx_runs_user ON public.automation_runs USING btree (user_id);
CREATE INDEX idx_runs_pending ON public.automation_runs USING btree (status) WHERE (status = 'pending'::text);

CREATE INDEX idx_bridge_requests_status_created ON public.bridge_requests USING btree (status, created_at);

CREATE INDEX bug_reports_open_idx ON public.bug_reports USING btree (status, created_at DESC);

CREATE INDEX idx_canvases_user ON public.canvases USING btree (user_id);

CREATE INDEX idx_chat_links_platform_lookup ON public.chat_links USING btree (platform, platform_user_id);

CREATE INDEX idx_threads_user ON public.conversation_threads USING btree (user_id, updated_at DESC);
CREATE INDEX idx_threads_active ON public.conversation_threads USING btree (user_id, is_active) WHERE (is_active = true);

-- REQUIRED for data_cache upserts on (user_id, source, external_id).
CREATE UNIQUE INDEX idx_data_cache_user_external ON public.data_cache USING btree (user_id, source, external_id);
CREATE INDEX idx_data_cache_user_received ON public.data_cache USING btree (user_id, received_at DESC);
CREATE INDEX idx_data_cache_user_source_type ON public.data_cache USING btree (user_id, source, type);
CREATE INDEX idx_data_cache_user_synced ON public.data_cache USING btree (user_id, source, synced_at DESC);

CREATE INDEX idx_dv_user ON public.data_vectors USING btree (user_id, service);
CREATE INDEX idx_dv_embedding ON public.data_vectors USING hnsw (embedding vector_cosine_ops);

CREATE INDEX idx_datasets_user ON public.datasets USING btree (user_id);
CREATE INDEX idx_dataset_rows_dataset ON public.dataset_rows USING btree (dataset_id, row_index);
CREATE INDEX idx_dataset_rows_user ON public.dataset_rows USING btree (user_id);

CREATE INDEX idx_rag_sources_user ON public.rag_sources USING btree (user_id);
CREATE INDEX idx_rag_documents_user ON public.rag_documents USING btree (user_id, created_at DESC);
CREATE INDEX idx_rag_documents_status ON public.rag_documents USING btree (user_id, status);
CREATE INDEX idx_rag_documents_source ON public.rag_documents USING btree (source_id);
CREATE INDEX idx_rag_documents_path ON public.rag_documents USING btree (user_id, file_path);
CREATE INDEX idx_rag_chunks_document ON public.rag_chunks USING btree (document_id, chunk_index);
CREATE INDEX idx_rag_chunks_user ON public.rag_chunks USING btree (user_id);
CREATE INDEX idx_rag_chunks_embedding ON public.rag_chunks USING hnsw (embedding vector_cosine_ops);

CREATE INDEX idx_sandboxes_user ON public.sandboxes USING btree (user_id);
CREATE INDEX idx_sandboxes_status ON public.sandboxes USING btree (status);

CREATE INDEX idx_user_mcps_user ON public.user_mcps USING btree (user_id);
CREATE INDEX idx_user_rules_active ON public.user_rules USING btree (user_id, active) WHERE (active = true);
CREATE INDEX idx_user_skills_user ON public.user_skills USING btree (user_id);

CREATE INDEX idx_web_messages_user_dir ON public.web_messages USING btree (user_id, direction, created_at);

-- ---------------------------------------------------------------------------
-- Functions (the vector-search RPCs). Note the loose `vector` parameter
-- type — no width is declared, so one function serves 768 and 1536 callers.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.match_rag_chunks(
  query_embedding vector,
  match_user_id uuid,
  match_threshold double precision DEFAULT 0.3,
  match_count integer DEFAULT 10
)
RETURNS TABLE(id uuid, document_id uuid, content text, chunk_index integer, metadata jsonb, similarity double precision)
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN QUERY
  SELECT c.id, c.document_id, c.content, c.chunk_index, c.metadata,
         1 - (c.embedding <=> query_embedding) AS similarity
  FROM rag_chunks c
  WHERE c.user_id = match_user_id
    AND c.embedding IS NOT NULL
    AND 1 - (c.embedding <=> query_embedding) > match_threshold
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.search_data_vectors(
  query_embedding vector,
  match_user_id uuid,
  match_threshold double precision DEFAULT 0.3,
  match_count integer DEFAULT 15,
  filter_service text DEFAULT NULL::text
)
RETURNS TABLE(id uuid, service text, item_type text, external_id text, content text, source_metadata jsonb, enrichment_level text, similarity double precision)
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN QUERY
  SELECT sv.id, sv.service, sv.item_type, sv.external_id, sv.content,
         sv.source_metadata, sv.enrichment_level,
         1 - (sv.embedding <=> query_embedding) AS similarity
  FROM data_vectors sv
  WHERE sv.user_id = match_user_id
    AND sv.embedding IS NOT NULL
    AND 1 - (sv.embedding <=> query_embedding) > match_threshold
    AND (filter_service IS NULL OR sv.service = filter_service)
  ORDER BY sv.embedding <=> query_embedding
  LIMIT match_count;
END;
$function$;

-- ---------------------------------------------------------------------------
-- token_usage — BYOK spend accounting (daily rollup per feature + model).
-- Written only through record_token_usage() below; one row per
-- user/day/feature/model keeps the table tiny forever. Tokens, not money:
-- prices vary per provider and go stale, token counts do not.
-- ---------------------------------------------------------------------------
CREATE TABLE token_usage (
  user_id uuid NOT NULL,
  day date NOT NULL,
  feature text NOT NULL,
  model text NOT NULL,
  calls integer NOT NULL DEFAULT 0,
  tokens_in bigint NOT NULL DEFAULT 0,
  tokens_out bigint NOT NULL DEFAULT 0,
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT token_usage_pkey PRIMARY KEY (user_id, day, feature, model)
);

-- Atomic increment: both processes can flush concurrently without a
-- read-modify-write race.
CREATE OR REPLACE FUNCTION public.record_token_usage(
  p_user_id uuid,
  p_day date,
  p_feature text,
  p_model text,
  p_calls integer,
  p_tokens_in bigint,
  p_tokens_out bigint
) RETURNS void
LANGUAGE sql
AS $function$
  INSERT INTO token_usage (user_id, day, feature, model, calls, tokens_in, tokens_out)
  VALUES (p_user_id, p_day, p_feature, p_model, p_calls, p_tokens_in, p_tokens_out)
  ON CONFLICT (user_id, day, feature, model) DO UPDATE SET
    calls = token_usage.calls + EXCLUDED.calls,
    tokens_in = token_usage.tokens_in + EXCLUDED.tokens_in,
    tokens_out = token_usage.tokens_out + EXCLUDED.tokens_out,
    updated_at = now();
$function$;
