-- 033_drop_brain_notes.sql — remove the last of the old note store.
--
-- brain_notes (originally knowledge_nodes) was the first memory table: hand
-- written notes with their own embedding and full-text columns. It was
-- superseded by data_vectors, which holds conversation memory and pinned facts
-- together and is what the dashboard's Context Brain reads and what passive
-- recall searches. Nothing has written a brain_notes row or called
-- match_brain_notes since that switch; the only remaining reference in the
-- application was a resolved-null placeholder standing in for a read that no
-- longer happened.
--
-- The table goes rather than being left empty. An unused table with three
-- indexes on it is a thing every future schema question has to be answered
-- about, and a 768-dimension embedding column is a standing invitation to
-- write to it again with vectors from a model nothing else uses.
--
-- Content is dropped with it, deliberately: these rows predate the current
-- memory model and are not migrated into data_vectors.
--
-- Runner-managed, so every statement is idempotent (see lib/migrations.js).
-- The indexes and constraints belong to the table and go with it; only the
-- function needs its own statement.

DROP FUNCTION IF EXISTS public.match_brain_notes(vector, uuid, double precision, integer);

DROP TABLE IF EXISTS public.brain_notes;
