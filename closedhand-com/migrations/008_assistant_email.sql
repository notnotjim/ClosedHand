-- The assistant email relay: each copy of Closedhand that turns on its own
-- address gets one here. closedhand.com is transport only. Mail arrives
-- sealed to the copy's own key, which never leaves that computer; replies
-- wait here encrypted until sent. Quotas belong to the verified owner, not
-- to a copy that could be reinstalled.

-- Only an address the sign-in provider vouches for may receive the
-- assistant's private replies: Google says when it verified one, and a
-- personal Microsoft account's address is its sign-in. A work account's
-- address is whatever its organisation typed in, so it never counts.
ALTER TABLE owners ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;

CREATE TABLE mail_relay_accounts (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  secret_hash text NOT NULL,
  public_key text NOT NULL,
  address text UNIQUE NOT NULL,
  owner_email text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);
CREATE INDEX mail_relay_accounts_owner ON mail_relay_accounts (owner_id);

CREATE TABLE mail_relay_inbound (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES mail_relay_accounts(id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  sender text NOT NULL,
  authenticated boolean NOT NULL,
  message_id text,
  sealed jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '14 days',
  acknowledged_at timestamptz,
  UNIQUE (account_id, provider_id)
);
CREATE INDEX mail_relay_inbound_pending ON mail_relay_inbound (account_id, received_at) WHERE acknowledged_at IS NULL;

CREATE TABLE mail_relay_consent (
  account_id uuid NOT NULL REFERENCES mail_relay_accounts(id) ON DELETE CASCADE,
  address text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, address)
);

CREATE TABLE mail_relay_suppression (
  address_hash text PRIMARY KEY,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mail_relay_outbox (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES mail_relay_accounts(id) ON DELETE CASCADE,
  request_hash text NOT NULL,
  payload text CHECK (payload LIKE 'enc:v1:%'),
  recipients jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  provider_id text UNIQUE,
  reserved_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mail_relay_outbox_pending ON mail_relay_outbox (state, created_at);

CREATE TABLE mail_relay_feedback (
  event_id text PRIMARY KEY,
  provider_id text NOT NULL,
  event jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mail_relay_usage (
  owner_key text NOT NULL,
  period date NOT NULL,
  sent integer NOT NULL DEFAULT 0,
  received integer NOT NULL DEFAULT 0,
  bytes bigint NOT NULL DEFAULT 0,
  estimated_usd numeric(14,6) NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_key, period)
);

CREATE TABLE mail_relay_meter (
  event_id text PRIMARY KEY,
  owner_key text NOT NULL,
  direction text NOT NULL,
  allowed boolean NOT NULL,
  reason text,
  deliveries integer NOT NULL,
  bytes bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mail_relay_controls (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  monthly_usd numeric NOT NULL DEFAULT 450 CHECK (monthly_usd > 0),
  paused boolean NOT NULL DEFAULT false
);
INSERT INTO mail_relay_controls (id) VALUES (true);

CREATE TABLE mail_relay_alerts (
  month date NOT NULL,
  threshold integer NOT NULL,
  sent_at timestamptz,
  PRIMARY KEY (month, threshold)
);

-- At most three enabled copies per owner, counted under the owner's lock.
CREATE FUNCTION provision_mail_relay_account(installation uuid, owner uuid, proof_hash text, public_key_text text, sender_address text, verified_email text)
RETURNS SETOF mail_relay_accounts LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM owners WHERE id = owner FOR UPDATE;
  IF (SELECT count(*) FROM mail_relay_accounts WHERE owner_id = owner AND enabled) >= 3 THEN RETURN; END IF;
  RETURN QUERY INSERT INTO mail_relay_accounts (id, owner_id, secret_hash, public_key, address, owner_email)
    VALUES (installation, owner, proof_hash, public_key_text, sender_address, verified_email) RETURNING *;
END $$;

-- One lock covers every replica, duplicate submissions and account deletions.
-- Inbound mail was already accepted by Amazon, so its cost counts even when
-- it is refused here.
CREATE FUNCTION reserve_mail_relay_usage(event_key text, account uuid, direction_text text, deliveries integer, message_bytes bigint)
RETURNS TABLE (allowed boolean, reason text) LANGUAGE plpgsql AS $$
DECLARE
  owner_key_text text; monthly date := date_trunc('month', now() at time zone 'UTC')::date;
  today date := (now() at time zone 'UTC')::date; global_used mail_relay_usage; user_used mail_relay_usage; daily mail_relay_usage;
  controls mail_relay_controls; charge numeric; answer boolean := true; why text; prior mail_relay_meter;
BEGIN
  IF event_key IS NULL OR account IS NULL AND direction_text = 'out' OR direction_text IS NULL OR deliveries IS NULL OR message_bytes IS NULL
     OR direction_text NOT IN ('in', 'out') OR deliveries < 1 OR deliveries > 8 OR message_bytes < 0 OR message_bytes > 50000000 OR length(event_key) > 250 THEN
    RAISE EXCEPTION 'Invalid usage event';
  END IF;
  SELECT * INTO controls FROM mail_relay_controls WHERE id = true FOR UPDATE;
  SELECT encode(sha256(convert_to(lower(owner_email), 'UTF8')), 'hex') INTO owner_key_text FROM mail_relay_accounts WHERE id = account;
  IF owner_key_text IS NULL THEN owner_key_text := 'unknown'; END IF;
  SELECT * INTO prior FROM mail_relay_meter WHERE event_id = event_key;
  IF FOUND THEN
    IF prior.owner_key <> owner_key_text OR prior.direction <> direction_text OR prior.deliveries <> deliveries OR prior.bytes <> message_bytes THEN
      RETURN QUERY SELECT false, 'Usage event does not match this request.'::text; RETURN;
    END IF;
    RETURN QUERY SELECT prior.allowed, prior.reason; RETURN;
  END IF;
  INSERT INTO mail_relay_usage (owner_key, period) VALUES ('global', monthly) ON CONFLICT DO NOTHING;
  SELECT * INTO global_used FROM mail_relay_usage WHERE owner_key = 'global' AND period = monthly;
  INSERT INTO mail_relay_usage (owner_key, period) VALUES (owner_key_text, monthly), (owner_key_text || ':daily', today) ON CONFLICT DO NOTHING;
  SELECT * INTO user_used FROM mail_relay_usage WHERE owner_key = owner_key_text AND period = monthly;
  SELECT * INTO daily FROM mail_relay_usage WHERE owner_key = owner_key_text || ':daily' AND period = today;
  charge := deliveries * 0.0005 + message_bytes * deliveries::numeric / 1048576 * 0.002;
  IF controls.paused OR global_used.estimated_usd + charge > controls.monthly_usd THEN
    UPDATE mail_relay_controls SET paused = true WHERE id = true; answer := false; why := 'Email is temporarily paused while capacity is increased.';
  ELSIF owner_key_text = 'unknown' THEN answer := false; why := 'Unknown email address.';
  ELSIF user_used.bytes + message_bytes * deliveries > 262144000 THEN answer := false; why := 'Your monthly email data allowance has been reached. It resets next month.';
  ELSIF direction_text = 'out' AND user_used.sent + deliveries > 1000 OR direction_text = 'in' AND user_used.received + deliveries > 2000 THEN
    answer := false; why := 'Your monthly email allowance has been reached. It resets next month.';
  ELSIF direction_text = 'out' AND daily.sent + deliveries > 100 OR direction_text = 'in' AND daily.received + deliveries > 200 THEN
    answer := false; why := 'Your daily email allowance has been reached. It resets at midnight UTC.';
  END IF;
  IF answer OR direction_text = 'in' THEN
    UPDATE mail_relay_usage SET sent = sent + CASE WHEN direction_text = 'out' THEN deliveries ELSE 0 END,
      received = received + CASE WHEN direction_text = 'in' THEN deliveries ELSE 0 END, bytes = bytes + message_bytes * deliveries, estimated_usd = estimated_usd + charge
      WHERE owner_key = 'global' AND period = monthly;
  END IF;
  IF answer THEN
    UPDATE mail_relay_usage SET sent = sent + CASE WHEN direction_text = 'out' THEN deliveries ELSE 0 END,
      received = received + CASE WHEN direction_text = 'in' THEN deliveries ELSE 0 END, bytes = bytes + message_bytes * deliveries, estimated_usd = estimated_usd + charge
      WHERE owner_key IN (owner_key_text, owner_key_text || ':daily') AND period = CASE WHEN owner_key = owner_key_text THEN monthly ELSE today END;
  END IF;
  INSERT INTO mail_relay_meter (event_id, owner_key, direction, allowed, reason, deliveries, bytes)
    VALUES (event_key, owner_key_text, direction_text, answer, why, deliveries, message_bytes);
  RETURN QUERY SELECT answer, why;
END $$;

-- Sending has already reserved its usage at submission, including outcomes
-- that turn out ambiguous, which are never resent automatically.
CREATE FUNCTION claim_mail_relay_outbox(job uuid)
RETURNS SETOF mail_relay_outbox LANGUAGE plpgsql AS $$
DECLARE item mail_relay_outbox;
BEGIN
  IF EXISTS (SELECT 1 FROM mail_relay_controls WHERE id = true AND paused) THEN RETURN; END IF;
  SELECT * INTO item FROM mail_relay_outbox WHERE id = job AND state = 'pending' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM mail_relay_accounts WHERE id = item.account_id AND enabled) THEN
    UPDATE mail_relay_outbox SET state = 'cancelled', payload = NULL, error = 'Email address is paused.', updated_at = now() WHERE id = job; RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM mail_relay_meter WHERE event_id = 'out:' || job::text AND allowed) THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(item.recipients) r(address)
             JOIN mail_relay_suppression s ON s.address_hash = encode(sha256(convert_to(r.address, 'UTF8')), 'hex')) THEN
    UPDATE mail_relay_outbox SET state = 'suppressed', payload = NULL, error = 'Delivery stopped for this recipient.', updated_at = now() WHERE id = job; RETURN;
  END IF;
  RETURN QUERY UPDATE mail_relay_outbox SET state = 'sending', reserved_at = now(), updated_at = now() WHERE id = job RETURNING *;
END $$;
