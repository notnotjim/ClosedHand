-- A Closedhand account is the Google or Microsoft sign-in that confirmed a
-- personal URL. It holds that personal URL and nothing else.
--
-- Deleting an account forgets the sign-in straight away. Its address and
-- old names lose their owner while the Worker takes their routes down, and
-- each name is held for six months so an old bookmark can never open a
-- stranger's computer. A held name with no owner links to nobody.
ALTER TABLE addresses ALTER COLUMN owner_id DROP NOT NULL;
ALTER TABLE retired_names ALTER COLUMN owner_id DROP NOT NULL;

-- When the address's computer was last connected, as Cloudflare reports it
-- for the tunnel (the Worker passes it on every hour). An address unused for
-- ninety days is released, its name held for its owner for six months.
ALTER TABLE addresses ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE held_names (
  hostname text PRIMARY KEY,
  owner_id uuid REFERENCES owners(id) ON DELETE SET NULL,
  release_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX held_names_owner ON held_names (owner_id);
