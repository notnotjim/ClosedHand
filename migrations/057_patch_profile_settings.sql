-- 057_patch_profile_settings.sql: change a person's settings inside the
-- database, touching only the keys named.
--
-- Every writer used to read the whole settings object, change it in memory
-- and write the whole object back. When a read failed, during a database
-- restart for instance, a writer carried on with an empty object and saved
-- that: every setting went at once, the dashboard password with them, and
-- with no password the dashboard opens to anyone who reaches it. Two writers
-- that overlapped also undid each other.
--
-- This changes only what it is given, in one statement against the row as it
-- is now. self_host_config (the password hash, models, the personal URL) is
-- never replaced whole: its keys change one at a time through p_conf_set and
-- p_conf_unset, and a self_host_config inside p_set is ignored.
CREATE OR REPLACE FUNCTION patch_profile_settings(
  p_id uuid,
  p_set jsonb DEFAULT '{}'::jsonb,
  p_unset text[] DEFAULT '{}'::text[],
  p_conf_set jsonb DEFAULT '{}'::jsonb,
  p_conf_unset text[] DEFAULT '{}'::text[]
) RETURNS jsonb
LANGUAGE sql
AS $$
  UPDATE profiles
     SET settings = jsonb_set(
           ((coalesce(settings, '{}'::jsonb) - coalesce(p_unset, '{}'::text[])) - 'self_host_config')
             || (coalesce(p_set, '{}'::jsonb) - 'self_host_config'),
           '{self_host_config}',
           (coalesce(settings->'self_host_config', '{}'::jsonb) - coalesce(p_conf_unset, '{}'::text[]))
             || coalesce(p_conf_set, '{}'::jsonb)),
         updated_at = now()
   WHERE id = p_id
  RETURNING settings
$$;
