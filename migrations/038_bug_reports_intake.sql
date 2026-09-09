-- 038_bug_reports_intake.sql — where a report came from, and whether it was sent on.
--
-- Self-host reports live in the person's own database and reach the queue only
-- when they say yes to sending; sent_at records that. On the hosted side the
-- intake endpoint writes reports from self-host installs into this same table,
-- so source, install_id and app_version say which install and which release.
ALTER TABLE bug_reports
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS install_id text,
  ADD COLUMN IF NOT EXISTS app_version text,
  ADD COLUMN IF NOT EXISTS sent_at timestamptz;
