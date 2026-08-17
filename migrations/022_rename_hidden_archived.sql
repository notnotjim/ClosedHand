-- The word is archive: kept, recoverable, just put away. Renamed minutes after
-- shipping as "hidden", before anything else grew roots into the old name.
ALTER TABLE conversation_threads RENAME COLUMN hidden TO archived;
