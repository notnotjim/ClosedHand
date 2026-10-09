-- 054_goals.sql: goals sit beside preferences.
--
-- A preference says how Closedhand should act ("no emojis"); a goal says
-- what the person is working towards ("launch publicly by December"). Both
-- are written by the person, in chat or on the dashboard, and live in the
-- same list so the two always agree; the kind tells them apart.
ALTER TABLE user_rules ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'preference';
DO $$ BEGIN
  ALTER TABLE user_rules ADD CONSTRAINT user_rules_kind CHECK (kind IN ('preference', 'goal'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
