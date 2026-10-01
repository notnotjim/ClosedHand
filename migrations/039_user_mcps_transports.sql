-- 039_user_mcps_transports.sql — an MCP connection can be more than an https URL.
--
-- Until now a row was a remote Streamable-HTTP server and nothing else. A
-- published server is at least as often a command to run (npx, uvx), a legacy
-- SSE endpoint, or a remote server that wants an API key in a header, and the
-- client now speaks all of those. The row records which transport it turned
-- out to be, how to start or reach it, and what the server offers beyond tools
-- (resources, prompts), so the dashboard can say so and the bot can use them.
--
-- updated_at is the cache signature: the bot re-reads a connection whenever it
-- changes and drops one the moment it is removed, instead of waiting out a
-- timer. A stdio row keeps the (user_id, server_url) key with a synthetic
-- "stdio:<command> <args>" address.
ALTER TABLE user_mcps
  ADD COLUMN IF NOT EXISTS transport text DEFAULT 'http',
  ADD COLUMN IF NOT EXISTS command text,
  ADD COLUMN IF NOT EXISTS args jsonb,
  ADD COLUMN IF NOT EXISTS env jsonb,
  ADD COLUMN IF NOT EXISTS headers jsonb,
  ADD COLUMN IF NOT EXISTS oauth_scope text,
  ADD COLUMN IF NOT EXISTS oauth_resource text,
  ADD COLUMN IF NOT EXISTS caps jsonb,
  ADD COLUMN IF NOT EXISTS prompts_discovered jsonb,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
