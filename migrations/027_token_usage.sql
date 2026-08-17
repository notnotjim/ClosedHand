-- 027: token_usage — BYOK spend accounting (daily rollup per feature + model).
-- For DBs provisioned before this landed in 000_baseline_schema.sql (fresh
-- installs get it from the baseline; James's prod applies this incrementally).
-- 026 is a cloud-branch migration; this deliberately skips that number.

CREATE TABLE IF NOT EXISTS token_usage (
  user_id uuid NOT NULL,
  day date NOT NULL,
  feature text NOT NULL,
  model text NOT NULL,
  calls integer NOT NULL DEFAULT 0,
  tokens_in bigint NOT NULL DEFAULT 0,
  tokens_out bigint NOT NULL DEFAULT 0,
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT token_usage_pkey PRIMARY KEY (user_id, day, feature, model)
);

CREATE OR REPLACE FUNCTION public.record_token_usage(
  p_user_id uuid,
  p_day date,
  p_feature text,
  p_model text,
  p_calls integer,
  p_tokens_in bigint,
  p_tokens_out bigint
) RETURNS void
LANGUAGE sql
AS $function$
  INSERT INTO token_usage (user_id, day, feature, model, calls, tokens_in, tokens_out)
  VALUES (p_user_id, p_day, p_feature, p_model, p_calls, p_tokens_in, p_tokens_out)
  ON CONFLICT (user_id, day, feature, model) DO UPDATE SET
    calls = token_usage.calls + EXCLUDED.calls,
    tokens_in = token_usage.tokens_in + EXCLUDED.tokens_in,
    tokens_out = token_usage.tokens_out + EXCLUDED.tokens_out,
    updated_at = now();
$function$;
