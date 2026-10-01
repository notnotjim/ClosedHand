-- Migration 027 predates the self-host runner and was missing from its baseline.
-- Existing installs need a runner-managed migration too. Leave unknown old zones null.
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS timezone text;
