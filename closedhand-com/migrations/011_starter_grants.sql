-- Closedhand Managed LLM's free use, given once per person (lib/included-ai.js).
-- person_hash is a one-way fingerprint of the sign-in that claimed it, kept
-- after the account is deleted so deleting and claiming again gives nothing
-- new. network_hash is a one-way fingerprint of the internet connection the
-- claim came from, so one connection cannot collect it again and again; it is
-- cleared after 30 days. Both are keyed with TOKEN_ENCRYPTION_KEY, so neither
-- can be matched to a sign-in or address without it. The caps on new free use
-- count these rows, which deleting an account leaves in place.
CREATE TABLE IF NOT EXISTS starter_grants (
  id bigserial PRIMARY KEY,
  person_hash text NOT NULL UNIQUE,
  network_hash text,
  granted_usd numeric(10, 2) NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS starter_grants_granted_at ON starter_grants (granted_at);
CREATE INDEX IF NOT EXISTS starter_grants_network ON starter_grants (network_hash) WHERE network_hash IS NOT NULL;
