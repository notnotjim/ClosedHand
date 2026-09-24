-- Per-owner OAuth applications, separate from connected accounts.
CREATE TABLE IF NOT EXISTS public.connection_clients (
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 service text NOT NULL,
 client_id text NOT NULL,
 client_secret text NOT NULL CHECK (client_secret LIKE 'enc:v1:%'),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,service)
);
ALTER TABLE public.connection_clients ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.connection_clients FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON public.connection_clients FROM anon; END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON public.connection_clients FROM authenticated; END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT ALL ON public.connection_clients TO service_role; END IF;
END $$;

