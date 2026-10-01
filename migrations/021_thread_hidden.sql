-- Hiding a thread tidies the sidebar without touching memory; deleting stays
-- the full purge. Two different intents that were sharing one button.
ALTER TABLE conversation_threads ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;
