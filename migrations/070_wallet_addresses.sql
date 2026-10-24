-- 070_wallet_addresses.sql: addresses Closedhand fills in at checkout.
--
-- The person adds them in Settings, under Wallet. One is their home: every
-- card is billed there and orders go there, unless a card names another
-- address for its billing (wallet_cards.billing = {"address_id": ...}) or the
-- person asks for another delivery address. lib/wallet.js types them into
-- the page; country is the two-letter ISO code.
CREATE TABLE IF NOT EXISTS wallet_addresses (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  label text NOT NULL,
  name text,
  line1 text NOT NULL,
  line2 text,
  city text,
  region text,
  postcode text,
  country text NOT NULL,
  phone text,
  is_home boolean DEFAULT false NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT wallet_addresses_pkey PRIMARY KEY (id),
  CONSTRAINT wallet_addresses_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_wallet_addresses_user ON wallet_addresses (user_id);
