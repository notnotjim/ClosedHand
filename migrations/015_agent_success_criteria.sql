-- Success criteria for a background agent run.
--
-- These were generated in startAgent and passed to runAgent in memory only, so
-- any restart lost them, and the verification step is guarded on their
-- presence. A resumed agent therefore skipped verification entirely and
-- reported completed without anything checking it had done the job.
alter table agent_tasks add column if not exists success_criteria jsonb;
