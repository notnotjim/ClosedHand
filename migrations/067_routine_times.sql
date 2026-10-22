-- A routine that waits for something can run as an item arrives, or a set
-- time before an item starts or after it ends, for kinds with a time of
-- their own: an hour before each meeting, the day after each stay
-- (lib/watch-kinds.js, lib/watches.js).
ALTER TABLE automations ADD COLUMN IF NOT EXISTS trigger_when text NOT NULL DEFAULT 'arrives';
ALTER TABLE automations ADD COLUMN IF NOT EXISTS trigger_offset_minutes integer NOT NULL DEFAULT 0;
