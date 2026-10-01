-- 041_bookings.sql — upcoming bookings, picked out of mail, kept with their references.
--
-- Flights already get this treatment (tracked from confirmation emails, with
-- live status). Trains, hotels, event tickets, restaurant tables and hire
-- cars are the same kind of thing: something with a booking reference and a
-- time, which a person would otherwise dig out of their inbox at the door.
-- Meetings and calls are deliberately NOT here; the calendar has those.
-- dedupe_key is set by the scanner (kind, reference or title, date) so the
-- same email read twice cannot produce two bookings.
CREATE TABLE IF NOT EXISTS bookings (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  kind text NOT NULL,                 -- train | hotel | event | restaurant | car | ferry | bus | other
  title text NOT NULL,
  provider text,
  reference text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  timezone text,
  location text,
  details jsonb DEFAULT '{}'::jsonb NOT NULL,
  status text DEFAULT 'confirmed' NOT NULL,   -- confirmed | cancelled
  source_email_id text,
  dedupe_key text NOT NULL,
  detected_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT bookings_pkey PRIMARY KEY (id),
  CONSTRAINT bookings_user_dedupe_key UNIQUE (user_id, dedupe_key),
  CONSTRAINT bookings_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bookings_user_start ON bookings (user_id, starts_at);
