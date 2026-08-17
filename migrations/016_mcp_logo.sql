-- A connection's icon, copied to our own storage at connect time so the
-- dashboard never fetches from the MCP server's domain while the user browses.
ALTER TABLE user_mcps ADD COLUMN IF NOT EXISTS logo_url text;
