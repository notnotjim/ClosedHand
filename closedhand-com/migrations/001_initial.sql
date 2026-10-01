-- The closedhand.com service keeps three things: who owns a personal URL,
-- the routing record for each personal URL, and bug reports people chose to
-- share. It never holds anyone's mail, calendar, files or conversations.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- One row per sign-in identity. People are known by the permanent ID their
-- provider gives them (Google "sub", Microsoft tenant + object ID), never by
-- email: a Microsoft work account's email is set by its organisation and is
-- not proof of anything. The email is kept for display only.
-- subject is NULL only for owners imported from the old service, who claim
-- their row once by signing in with the same verified Google address.
CREATE TABLE owners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('google', 'microsoft')),
  subject text,
  email text,
  name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX owners_identity ON owners (provider, subject) WHERE subject IS NOT NULL;

-- A personal URL: which copy of ClosedHand it reaches and the routing
-- credentials for it. id and secret_hash identify the copy (its install ID
-- and a hash of its secret); the secret itself never leaves that computer.
CREATE TABLE addresses (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES owners(id),
  secret_hash text NOT NULL CHECK (secret_hash ~ '^[a-f0-9]{64}$'),
  hostname text NOT NULL UNIQUE,
  web_port integer NOT NULL DEFAULT 3000 CHECK (web_port BETWEEN 1024 AND 65535),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'provisioning', 'connecting', 'active', 'error', 'revoked')),
  tunnel_id uuid,
  tunnel_token text,
  dns_id text,
  attempt_id uuid,
  lease_until timestamptz,
  revocation_complete boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- One personal URL per owner. A revoked one stays owned, so an old bookmark
-- can never lead to somebody else's computer.
CREATE UNIQUE INDEX addresses_one_per_owner ON addresses (owner_id);

-- Reports a person chose to send. Same columns as the table in each copy of
-- ClosedHand, so scripts/bug-queue.js reads either. Screenshots are kept
-- inline in the screenshots column.
CREATE TABLE bug_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  platform text,
  chat_id text,
  comment text,
  transcript jsonb NOT NULL DEFAULT '[]'::jsonb,
  screenshots jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'open',
  resolution_note text,
  source text,
  install_id text,
  app_version text,
  sent_at timestamptz,
  remote_receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX bug_reports_open_idx ON bug_reports (status, created_at DESC);
