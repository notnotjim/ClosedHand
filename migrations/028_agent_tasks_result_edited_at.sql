-- 028: agent run outputs are editable in place.
--
-- When the user asks for changes to a document an agent produced, chat edits
-- the stored result rather than spawning a new run, and the dashboard card and
-- PDF download need to say the output has been revised since it completed.
--
-- Applied manually (no automated runner).

ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS result_edited_at timestamptz;
