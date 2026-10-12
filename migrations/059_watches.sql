-- 059_watches.sql: routines that wait for something to happen, and one
-- record of what the person has been told about.
--
-- A routine set to run "when something happens" was saved and never run:
-- nothing looked at it. lib/watches.js now checks each new email, bank
-- transaction and synced chat message against it. A watch for one thing
-- (run_once) closes when it fires ("done") or at its end date ("expired").
-- watch_words are words the thing will contain (an order number, a sender),
-- checked before any model is asked. watched_until and watch_seen are how far
-- it has looked, so an item is judged once.
--
-- told_items is every item Closedhand has told the person about, whichever
-- part told them (a watch, Pulse), so none of them tells them twice.
ALTER TABLE automations ADD COLUMN IF NOT EXISTS run_once boolean NOT NULL DEFAULT false;
ALTER TABLE automations ADD COLUMN IF NOT EXISTS watch_words text[] NOT NULL DEFAULT '{}';
ALTER TABLE automations ADD COLUMN IF NOT EXISTS watched_until timestamptz;
ALTER TABLE automations ADD COLUMN IF NOT EXISTS watch_seen text[] NOT NULL DEFAULT '{}';
ALTER TABLE automations ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE automations ADD COLUMN IF NOT EXISTS fired_at timestamptz;
-- A routine saved for "when something happens" before this ran would
-- otherwise look back over everything synced since it was made, and could
-- act on months-old mail. Those start from now.
UPDATE automations SET watched_until = now() WHERE trigger_type = 'event' AND watched_until IS NULL;
ALTER TABLE automations DROP CONSTRAINT IF EXISTS automations_status_check;
ALTER TABLE automations ADD CONSTRAINT automations_status_check CHECK (status IN ('active', 'paused', 'idle', 'done', 'expired'));

CREATE TABLE IF NOT EXISTS told_items (
  user_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  source      text NOT NULL,
  external_id text NOT NULL,
  told_by     text NOT NULL,
  told_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, source, external_id)
);
