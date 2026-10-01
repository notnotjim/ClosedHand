-- An old name after a rename: it redirects for thirty days, then shows that
-- it has moved until six months after the rename, then it is released. Until
-- release it is reserved to its owner, who can take it back; once released
-- it is free for anyone, and its row goes, so nothing links it to them.
ALTER TABLE retired_names ADD COLUMN release_at timestamptz;
UPDATE retired_names SET release_at = created_at + interval '6 months';
ALTER TABLE retired_names ALTER COLUMN release_at SET NOT NULL;

-- Things the service emails its operator about, once each time they happen
-- (active until the condition clears). value is the last reading.
CREATE TABLE service_alerts (
  name text PRIMARY KEY,
  active boolean NOT NULL DEFAULT false,
  value integer,
  updated_at timestamptz NOT NULL DEFAULT now()
);
