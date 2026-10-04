-- Reports: a fuller document ClosedHand writes only when one helps the
-- person (they asked for a document, it is something to keep, share or come
-- back to, or it needs layout chat cannot show). The chat answer is always
-- complete without it. A report made by a background run goes with that run.
CREATE TABLE IF NOT EXISTS reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  task_id uuid REFERENCES agent_tasks(id) ON DELETE CASCADE,
  title text NOT NULL,
  content text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reports_user ON reports(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS reports_task ON reports(task_id);
