-- A copy of ClosedHand is known by its secret alone (by the hash of it,
-- which is all this service stores). An install ID it merely states proves
-- nothing, so nobody can take a copy's place by knowing its ID. New
-- addresses get an ID of their own, which also names their route.
CREATE UNIQUE INDEX addresses_one_per_copy ON addresses (secret_hash);

-- Moving a personal URL to another copy: the old computer's connection is
-- cut first, then the address is connected again to the new one.
ALTER TABLE addresses ADD COLUMN reprovision boolean NOT NULL DEFAULT false;

-- A confirmation waiting for its code. The owner confirmed on closedhand.com
-- and was shown the code; it takes effect only when the copy that asked
-- types it in, so a confirmation link sent by somebody else can never point
-- an owner's address at somebody else's computer. The code is sealed with
-- TOKEN_ENCRYPTION_KEY and lasts ten minutes.
CREATE TABLE approvals (
  secret_hash text PRIMARY KEY CHECK (secret_hash ~ '^[a-f0-9]{64}$'),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  hostname text NOT NULL,
  web_port integer NOT NULL CHECK (web_port BETWEEN 1024 AND 65535),
  code text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
