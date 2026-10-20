-- How much of each mailbox the synced copy holds in full
-- (lib/services/mail-history.js). Every email from complete_since up to
-- swept_at is in data_cache; search asks the mail provider only for older
-- mail. done means the walk back reached the horizon (a year).
CREATE TABLE IF NOT EXISTS mail_coverage (
  user_id uuid NOT NULL,
  source text NOT NULL,
  complete_since timestamptz,
  swept_at timestamptz,
  done boolean NOT NULL DEFAULT false,
  -- A walk back part way: its upper end and the mailbox's next page.
  walk_before timestamptz,
  walk_next text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, source)
);
