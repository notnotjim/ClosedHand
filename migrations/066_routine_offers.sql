-- Requests that made Closedhand do some work, kept briefly so one the person
-- keeps making at a steady rhythm can be offered as a routine
-- (lib/routine-offers.js). Deleting a chat deletes its requests with it.
-- local_at is when it was asked in the person's own time then, for the
-- weekday and part of day ("every Monday morning").
CREATE TABLE IF NOT EXISTS asks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  thread_id  uuid REFERENCES conversation_threads(id) ON DELETE CASCADE,
  text       text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  local_at   text NOT NULL
);
CREATE INDEX IF NOT EXISTS asks_user_at ON asks (user_id, at);

-- A routine Closedhand will offer, once, the next time the person makes
-- that request. schedule is in words ("every Monday morning").
CREATE TABLE IF NOT EXISTS routine_offers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name        text NOT NULL,
  goal        text NOT NULL,
  schedule    text NOT NULL,
  triggers    jsonb NOT NULL DEFAULT '[]'::jsonb,
  ask_ids     uuid[] NOT NULL,
  status      text NOT NULL DEFAULT 'pending',
  created_at  timestamptz NOT NULL DEFAULT now(),
  offered_at  timestamptz
);
CREATE INDEX IF NOT EXISTS routine_offers_user ON routine_offers (user_id, status);
