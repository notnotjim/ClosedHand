-- Repair baseline omissions and preserve execution state across every entry point.
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS pending_notes jsonb DEFAULT '[]'::jsonb;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS runtime jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS lease_owner text;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS lease_until timestamptz;
ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS runtime jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS lease_owner text;
ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS lease_until timestamptz;
ALTER TABLE automation_runs DROP CONSTRAINT IF EXISTS automation_runs_status_check;
ALTER TABLE automation_runs ADD CONSTRAINT automation_runs_status_check CHECK (status IN ('running','pending','success','failed','cancelled','partial','blocked'));

CREATE OR REPLACE FUNCTION append_agent_note(p_task_id uuid, p_user_id uuid, p_note jsonb)
RETURNS SETOF agent_tasks LANGUAGE sql AS $$
  UPDATE agent_tasks SET pending_notes = COALESCE(pending_notes, '[]'::jsonb) || jsonb_build_array(p_note), updated_at = now()
  WHERE id = p_task_id AND user_id = p_user_id AND status IN ('running','pending') RETURNING *;
$$;

-- Removing only the acknowledged IDs preserves notes appended during a model call.
CREATE OR REPLACE FUNCTION acknowledge_agent_notes(p_task_id uuid, p_user_id uuid, p_ids jsonb)
RETURNS SETOF agent_tasks LANGUAGE sql AS $$
  UPDATE agent_tasks SET pending_notes = COALESCE((SELECT jsonb_agg(n) FROM jsonb_array_elements(COALESCE(pending_notes,'[]'::jsonb)) n WHERE NOT (COALESCE(p_ids->'ids',p_ids) ? COALESCE(n->>'id',n->>'at',''))), '[]'::jsonb), updated_at = now()
  WHERE id=p_task_id AND user_id=p_user_id RETURNING *;
$$;

CREATE TABLE IF NOT EXISTS task_model_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
  task_id uuid, kind text NOT NULL, purpose text NOT NULL, model text,
  input_tokens bigint NOT NULL DEFAULT 0, output_tokens bigint NOT NULL DEFAULT 0,
  cache_read_tokens bigint NOT NULL DEFAULT 0, cache_write_tokens bigint NOT NULL DEFAULT 0,
  duration_ms bigint NOT NULL DEFAULT 0, status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_model_calls_task ON task_model_calls(user_id, task_id, created_at);
ALTER TABLE task_model_calls ENABLE ROW LEVEL SECURITY;
CREATE TABLE IF NOT EXISTS task_followups (
  user_id uuid NOT NULL, channel_key text NOT NULL, request_id uuid NOT NULL,
  payload jsonb NOT NULL, status text NOT NULL DEFAULT 'waiting', updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel_key)
);
ALTER TABLE task_followups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON FUNCTION append_agent_note(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION acknowledge_agent_notes(uuid, uuid, jsonb) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT EXECUTE ON FUNCTION append_agent_note(uuid, uuid, jsonb) TO service_role;
    GRANT EXECUTE ON FUNCTION acknowledge_agent_notes(uuid, uuid, jsonb) TO service_role;
    GRANT ALL ON task_model_calls, task_followups TO service_role;
  END IF;
END $$;
-- The runtime writes using the service role. No anonymous access to private metrics.

ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS delivery_status text;
ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS delivery_status text;
CREATE TABLE IF NOT EXISTS task_deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
 task_table text NOT NULL, task_id uuid NOT NULL, destination text NOT NULL,
 platform text NOT NULL, chat_id text NOT NULL, message text NOT NULL,
 status text NOT NULL DEFAULT 'pending', receipt text, error text,
 updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(task_table,task_id,destination)
);
CREATE TABLE IF NOT EXISTS task_worker_results (
 user_id uuid NOT NULL, task_id uuid NOT NULL, item_key text NOT NULL,
 result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(task_id,item_key)
);
ALTER TABLE task_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_worker_results ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION checkpoint_task_budget(p_table text, p_id uuid, p_owner text, p_budget jsonb)
RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF p_table NOT IN ('agent_tasks','automation_runs') THEN RAISE EXCEPTION 'Invalid task table'; END IF;
 EXECUTE format('UPDATE %I SET runtime=jsonb_set(runtime,''{budget}'',$1) WHERE id=$2 AND lease_owner=$3 AND status=''running''', p_table)
 USING p_budget, p_id, p_owner;
END $$;
REVOKE ALL ON FUNCTION checkpoint_task_budget(text, uuid, text, jsonb) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  GRANT ALL ON task_deliveries, task_worker_results TO service_role;
  GRANT EXECUTE ON FUNCTION checkpoint_task_budget(text,uuid,text,jsonb) TO service_role;
 END IF;
END $$;

ALTER TABLE task_followups ADD COLUMN IF NOT EXISTS attempt_id uuid;

ALTER TABLE task_model_calls ADD COLUMN IF NOT EXISTS reasoning_tokens bigint NOT NULL DEFAULT 0;
ALTER TABLE task_model_calls ADD COLUMN IF NOT EXISTS cost_usd_ticks bigint;

CREATE INDEX IF NOT EXISTS agent_tasks_recovery ON agent_tasks(status, lease_until) WHERE status IN ('pending','running');
CREATE INDEX IF NOT EXISTS automation_runs_recovery ON automation_runs(status, lease_until) WHERE status IN ('pending','running');
CREATE INDEX IF NOT EXISTS task_model_calls_user_time ON task_model_calls(user_id, created_at);

-- Hosted database defaults may grant function access directly to these roles.
DO $$ DECLARE role_name text; BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON FUNCTION append_agent_note(uuid,uuid,jsonb), acknowledge_agent_notes(uuid,uuid,jsonb), checkpoint_task_budget(text,uuid,text,jsonb) FROM %I',role_name);
   EXECUTE format('REVOKE ALL ON TABLE task_model_calls,task_followups,task_deliveries,task_worker_results FROM %I',role_name);
  END IF;
 END LOOP;
END $$;
