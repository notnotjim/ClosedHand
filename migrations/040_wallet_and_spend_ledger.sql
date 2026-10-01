-- 040_wallet_and_spend_ledger.sql — money, recorded and bounded.
--
-- ClosedHand could already reach a checkout in the browser it drives; nothing
-- recorded what it spent or bounded it. spend_ledger is the record: one row
-- per purchase it was about to make, from the moment it asked (or decided it
-- may proceed) to what happened. It doubles as the idempotency check, so a
-- retry after a timeout cannot buy the same thing twice.
--
-- wallet_cards holds cards the person adds in Settings. The number and the
-- security code are stored encrypted (TOKEN_ENCRYPTION_KEY) and are never
-- shown to the model; the browser fills them in from here. limits is the
-- person's own rule for that card: how much per purchase, per day, per month,
-- and below what amount ClosedHand may go ahead without asking.
CREATE TABLE IF NOT EXISTS spend_ledger (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  merchant text,
  host text,
  url text,
  title text,
  amount numeric,
  currency text,
  amount_text text,
  card_id uuid,
  status text DEFAULT 'asked' NOT NULL,   -- asked | approved | auto | declined | refused | completed | failed
  approved_via text,                       -- chat | agent | auto
  source text,                             -- chat | agent | automation
  tool text,
  note text,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT spend_ledger_pkey PRIMARY KEY (id),
  CONSTRAINT spend_ledger_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_spend_ledger_user_time ON spend_ledger (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS wallet_cards (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  label text,
  brand text,
  last4 text NOT NULL,
  exp_month integer NOT NULL,
  exp_year integer NOT NULL,
  holder text,
  enc_number text NOT NULL,
  enc_cvc text,
  billing jsonb,
  limits jsonb DEFAULT '{}'::jsonb NOT NULL,
  is_default boolean DEFAULT false NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT wallet_cards_pkey PRIMARY KEY (id),
  CONSTRAINT wallet_cards_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE
);
