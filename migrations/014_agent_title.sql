-- A short human title for a background agent run.
--
-- The card showed the goal's first line, which is the user's message verbatim
-- ("Ok I've just reconnected google so it should work now"), because the goal is
-- an instruction and not a name for the work. Generated once when the agent
-- starts, so the list reads as a list of jobs.
alter table agent_tasks add column if not exists title text;
