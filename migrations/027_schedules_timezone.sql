-- 027: schedules carry the timezone they were created in.
--
-- registerSchedule() has always fired cron jobs in schedule.timezone, but the
-- column never existed: the value lived only on the in-memory object made at
-- creation. Every bot restart re-registered schedules from this table without
-- it, so they all fell back to Europe/London. A reminder set for 10:00 by a
-- user in Osaka fired at 18:00 their time after any deploy.
--
-- Applied manually (no automated runner). Backfill existing enabled rows from
-- the owner's profile location where one is saved; rows with no known location
-- stay NULL and keep the historical London fallback.

ALTER TABLE schedules ADD COLUMN IF NOT EXISTS timezone text;

UPDATE schedules s
SET timezone = p.settings->'location'->>'timezone'
FROM profiles p
WHERE s.user_id = p.id
  AND s.timezone IS NULL
  AND p.settings->'location'->>'timezone' IS NOT NULL;
