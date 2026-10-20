-- The AI that comes with Closedhand (lib/included-ai.js): one OpenRouter key
-- per Closedhand account, made when its personal URL is claimed. Only
-- OpenRouter's name for the key (its hash) is kept, never the key itself,
-- which goes once to the computer that claimed. granted_usd is the starter
-- credit given with the first key and granted_at when; a key made again for
-- the same account carries what was left and keeps both.
CREATE TABLE IF NOT EXISTS included_ai_keys (
  owner_id uuid PRIMARY KEY REFERENCES owners(id) ON DELETE CASCADE,
  key_hash text NOT NULL UNIQUE,
  granted_usd numeric(10, 2) NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS included_ai_keys_granted_at ON included_ai_keys (granted_at);
