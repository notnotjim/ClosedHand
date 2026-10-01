-- Jev (TypeSafe) screening for Pulse was removed. Forget any saved TypeSafe
-- key and its switch, so no credential for it stays behind. Idempotent.
UPDATE profiles SET settings = settings - 'typesafe_api_key' - 'typesafe_enabled'
WHERE settings ? 'typesafe_api_key' OR settings ? 'typesafe_enabled';
