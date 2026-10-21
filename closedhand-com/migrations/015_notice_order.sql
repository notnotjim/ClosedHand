-- The maintainer's notices (lib/operator-notices.js) come out in the order
-- they were queued: two queued in the same instant share a created_at, so
-- each gets a number as it is added.
ALTER TABLE operator_notices ADD COLUMN IF NOT EXISTS seq bigserial;
