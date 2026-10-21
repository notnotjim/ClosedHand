-- Closedhand+ (lib/plus.js): one row per account that has subscribed, kept in
-- step with Polar, which takes the payment and holds the card; nothing about
-- the payment itself is kept here. status is Polar's word for the
-- subscription, current_period_end when the paid month runs out, and
-- cancel_at_period_end whether it then stops. extended_month (YYYY-MM) is the
-- month the person paid to carry on past fair use. started_at is when it first
-- became active, so an ended subscription stops its key while one that never
-- went through leaves the free use alone. key_synced says whether the
-- account's OpenRouter key (included_ai_keys) has been set to match; the
-- hourly sweep retries any that has not. event_at is when Polar last changed
-- it, so a late, older event can't undo a newer one.
CREATE TABLE IF NOT EXISTS plus_subscriptions (
  owner_id uuid PRIMARY KEY REFERENCES owners(id) ON DELETE CASCADE,
  polar_customer_id text,
  polar_subscription_id text NOT NULL,
  status text NOT NULL,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  extended_month text,
  started_at timestamptz,
  key_synced boolean NOT NULL DEFAULT false,
  event_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS plus_subscriptions_unsynced ON plus_subscriptions (owner_id) WHERE NOT key_synced;
