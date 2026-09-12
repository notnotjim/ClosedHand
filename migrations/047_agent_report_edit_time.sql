-- Migration 028 predates the self-host runner's floor. Repair existing
-- databases as well as including this field in the fresh-install baseline.
-- Dashboard listing, report retrieval and edited PDF exports require it.
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS result_edited_at timestamptz;
