-- 029: running agents can be steered mid-run.
--
-- "Also check X" said while an agent runs now reaches the agent instead of
-- waiting behind it: chat appends to pending_notes via the agent_note tool,
-- and the agent loop folds the notes in at its next iteration (the same
-- per-iteration row read that already serves cancellation).
--
-- Applied manually (no automated runner).

ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS pending_notes jsonb DEFAULT '[]'::jsonb;
