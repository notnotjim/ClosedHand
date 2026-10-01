-- File Search indexed one Drive account because origin was the whole identity
-- of a source. An account column lets two Drive sources (or two OneDrives)
-- coexist. Null means the primary connection, so existing rows keep working.
ALTER TABLE rag_sources ADD COLUMN IF NOT EXISTS account text;
