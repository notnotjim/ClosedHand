-- Receipt for an explicitly forwarded local report. Never shown in queue output.
ALTER TABLE bug_reports ADD COLUMN IF NOT EXISTS remote_receipt jsonb;
