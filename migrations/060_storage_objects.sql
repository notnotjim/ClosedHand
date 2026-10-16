-- Files for hosts where the bot and the dashboard can't share a folder, such
-- as Railway (STORAGE_DRIVER=pg, lib/storage-driver-pg.js). Empty elsewhere.
CREATE TABLE IF NOT EXISTS storage_objects (
  bucket text NOT NULL,
  key text NOT NULL,
  content_type text,
  data bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket, key)
);
