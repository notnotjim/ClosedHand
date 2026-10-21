-- Closedhand Managed Models start with a first month (lib/included-ai.js), not
-- an amount. ends_at is when an account's first month ends (null for a key
-- made for a Closedhand+ subscriber); stopped_at is when its key was stopped,
-- because the first month ended or Closedhand+ did, and is cleared when
-- Closedhand+ starts it again. The hourly sweep stops keys whose first month
-- is over.
ALTER TABLE included_ai_keys ADD COLUMN IF NOT EXISTS ends_at timestamptz;
ALTER TABLE included_ai_keys ADD COLUMN IF NOT EXISTS stopped_at timestamptz;
CREATE INDEX IF NOT EXISTS included_ai_keys_ending ON included_ai_keys (ends_at) WHERE stopped_at IS NULL AND ends_at IS NOT NULL;

-- The maintainer's notices (lib/operator-notices.js): how many first months
-- have started against the expected number, a burst of them, and this month's
-- OpenRouter spend against its budget. Nothing is ever stopped by these; they
-- tell the maintainer in time to raise the limits. operator_alerts records
-- which threshold has been told for which period, so each is told once.
-- operator_notices waits for the maintainer's own Closedhand to collect it,
-- and is emailed instead when it has not been collected within a day.
CREATE TABLE IF NOT EXISTS operator_alerts (
  kind text NOT NULL,
  period text NOT NULL,
  level integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, period, level)
);
CREATE TABLE IF NOT EXISTS operator_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  emailed_at timestamptz
);
CREATE INDEX IF NOT EXISTS operator_notices_waiting ON operator_notices (created_at) WHERE delivered_at IS NULL;
