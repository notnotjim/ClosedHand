-- Whether a schedule describes a single occasion. Cron has no year, so "03:10
-- on 28 July" otherwise means every 28 July for ever.
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS run_once boolean;
