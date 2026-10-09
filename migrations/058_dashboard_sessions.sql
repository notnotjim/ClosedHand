-- 058_dashboard_sessions.sql: one row per dashboard sign-in.
--
-- Every sign-in used to get the same signed cookie value, good for a year.
-- Nothing could take it back: logging out left it working, and a new
-- password did not sign anyone out. Now each sign-in gets its own random
-- session (webapp/dashboard-sessions.js). Only a hash of it is kept here, so
-- reading this table does not let anyone sign in. Logging out deletes the
-- row; a new password ends every row made under the old one (password_fp).
CREATE TABLE IF NOT EXISTS dashboard_sessions (
  token_hash  text PRIMARY KEY,
  kind        text NOT NULL DEFAULT 'password',
  password_fp text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS dashboard_sessions_expires_at ON dashboard_sessions (expires_at);
