-- A personal URL's old name after it is renamed. For thirty days the old
-- name sends visitors on to the new one; after that it stays reserved to
-- its owner for good, so an old bookmark can never open somebody else's
-- computer. dns_id is the old name's route, which the Worker removes once
-- the thirty days are up. announced says the Worker has set up the redirect.
CREATE TABLE retired_names (
  hostname text PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES owners(id),
  address_id uuid NOT NULL,
  redirect_to text NOT NULL,
  redirect_until timestamptz NOT NULL,
  dns_id text,
  announced boolean NOT NULL DEFAULT false,
  dns_removed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX retired_names_address ON retired_names (address_id);
