-- Pages (the table keeps its first name, reports). A page lives under Pages
-- on the dashboard and goes only when the page itself is deleted: removing
-- the run that made it keeps the page. Saved agents' runs record their pages
-- too, so the page is linked in the message their results go out in.
ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_task_id_fkey;
ALTER TABLE reports ADD CONSTRAINT reports_task_id_fkey FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE SET NULL;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS automation_run_id uuid REFERENCES automation_runs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS reports_automation_run ON reports(automation_run_id);
