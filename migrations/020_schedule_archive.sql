-- A one-off that has fired is history, not garbage: keep the row so the user
-- can see what ClosedHand did and when, instead of the schedule vanishing.
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS archived_at timestamptz;
