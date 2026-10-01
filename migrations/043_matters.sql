-- 043_matters.sql — the live picture of a matter in flight.
--
-- A conversation is kept as messages, and a long one is condensed into a
-- narrative, which is exactly where "Dan said no on Tuesday" goes missing.
-- A person does not hold the thread; they hold a small running picture of
-- the matter (who is involved, what each has said, what is open, what was
-- decided) and update it as each message arrives. This table is that
-- picture, one row per matter, updated in the background after every turn
-- and consulted before ClosedHand acts. It goes stale by silence and by the
-- matter's own end date, so an old party does not complicate a new one.
CREATE TABLE IF NOT EXISTS matters (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  title text NOT NULL,
  summary text,
  state jsonb DEFAULT '{}'::jsonb NOT NULL,   -- { people: [{name, position, said, when}], facts: [], open: [], decisions: [] }
  status text DEFAULT 'open' NOT NULL,        -- open | resolved | stale
  expected_end timestamptz,
  last_touched timestamptz DEFAULT now() NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  resolved_at timestamptz,
  CONSTRAINT matters_pkey PRIMARY KEY (id),
  CONSTRAINT matters_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_matters_user_status ON matters (user_id, status, last_touched DESC);
