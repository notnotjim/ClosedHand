-- Local email state. Relay credentials are separate from connected mail accounts.
CREATE TABLE IF NOT EXISTS assistant_email_accounts (
 user_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
 install_id uuid UNIQUE NOT NULL, secret text NOT NULL CHECK(secret LIKE 'enc:v1:%'),
 private_key text NOT NULL CHECK(private_key LIKE 'enc:v1:%'), public_key text NOT NULL,
 address text, owner_email text, enabled boolean NOT NULL DEFAULT false,
 last_sync_at timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS assistant_email_threads (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
 subject text NOT NULL DEFAULT '', participants jsonb NOT NULL DEFAULT '[]',
 scope_id uuid, shared_brief text, purpose text, expires_at timestamptz, stopped boolean NOT NULL DEFAULT false,
 conversation_id uuid REFERENCES conversation_threads(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS assistant_email_messages (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
 thread_id uuid REFERENCES assistant_email_threads(id) ON DELETE CASCADE,
 message_id text, direction text NOT NULL CHECK(direction IN ('in','out')),
 envelope jsonb NOT NULL, state text NOT NULL DEFAULT 'pending',
 error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assistant_email_messages_thread ON assistant_email_messages(user_id,thread_id,created_at);
CREATE INDEX IF NOT EXISTS assistant_email_messages_reference ON assistant_email_messages(user_id,message_id);
CREATE INDEX IF NOT EXISTS assistant_email_messages_pending ON assistant_email_messages(state,created_at);
-- A crashed owner turn may already have performed an external action. It is
-- surfaced for review instead of executing the same request a second time.
CREATE OR REPLACE FUNCTION claim_assistant_email_message(message uuid, owner uuid)
RETURNS SETOF assistant_email_messages LANGUAGE sql SET search_path=public AS $$
 UPDATE assistant_email_messages SET state='processing',updated_at=now()
 WHERE id=message AND user_id=owner AND state='pending' RETURNING *;
$$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['assistant_email_accounts','assistant_email_threads','assistant_email_messages'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE format('REVOKE ALL ON %I FROM anon',t); END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE format('REVOKE ALL ON %I FROM authenticated',t); END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE format('GRANT ALL ON %I TO service_role',t); END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION claim_assistant_email_message(uuid,uuid) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT EXECUTE ON FUNCTION claim_assistant_email_message(uuid,uuid) TO service_role; END IF;
END $$;
