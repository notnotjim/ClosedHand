-- Which way a file travelled, so a Files view can tell what the user sent from
-- what ClosedHand produced.
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS direction text;
