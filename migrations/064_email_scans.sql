-- Which emails the flight and booking scanners have already read, so the
-- same unchanged email is not sent to the LLM pass after pass
-- (lib/email-scans.js). text_hash is a hash of what was sent, never the text.
CREATE TABLE IF NOT EXISTS email_scans (
  user_id   uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  scanner   text NOT NULL,
  email_id  text NOT NULL,
  text_hash text NOT NULL,
  reads     integer NOT NULL DEFAULT 1,
  read_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scanner, email_id)
);
