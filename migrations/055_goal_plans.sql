-- 055_goal_plans.sql: goals become plans ClosedHand helps the person carry out.
--
-- A goal was a line in the preferences list (054). It is now its own record,
-- shaped by what research shows gets goals done: why it matters (the person's
-- own reason), the obstacle most likely to get in the way and an if-then plan
-- for it (mental contrasting with implementation intentions), a finish line
-- specific enough to check, near steps, the habit that gets them there (an
-- outcome paired with the habit behind it beats either alone), a reward they
-- chose if they want one, and a check-in time. What happens along the way is kept in goal_events, so the
-- Goals tab can show each goal's history.

CREATE TABLE IF NOT EXISTS goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  title text NOT NULL,
  shape text NOT NULL DEFAULT 'milestone' CHECK (shape IN ('milestone', 'habit')),
  why text,
  obstacle text,
  if_then text,
  target_date date,
  -- what done looks like, specific enough to check
  done_when text,
  -- the habit behind any goal, or the whole of a habit goal:
  -- { "action": "...", "cue": "after breakfast", "per_week": 5 }
  habit jsonb,
  -- a reward the person chose, if any
  reward text,
  -- milestone goals: [{ "id", "text", "owner": "you"|"closedhand", "due", "status": "todo"|"done"|"skipped", "done_at" }]
  plan jsonb NOT NULL DEFAULT '[]'::jsonb,
  stage text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'achieved', 'dropped')),
  -- { "days": [0..6, Sunday 0], "time": "19:00", "timezone": "Europe/London", "next_at": "..." }
  check_in jsonb,
  source text NOT NULL DEFAULT 'chat',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  achieved_at timestamptz
);
CREATE INDEX IF NOT EXISTS goals_user ON goals(user_id, status);

CREATE TABLE IF NOT EXISTS goal_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id uuid NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  -- created, planned, step_done, step_added, habit_done, check_in, note, stage, paused, resumed, achieved
  kind text NOT NULL,
  text text NOT NULL,
  ref jsonb
);
CREATE INDEX IF NOT EXISTS goal_events_goal ON goal_events(goal_id, at DESC);

-- Goals saved as preferences of kind "goal" (054) move here.
INSERT INTO goals (user_id, title, source, created_at)
  SELECT user_id, rule, COALESCE(source, 'chat'), created_at FROM user_rules WHERE kind = 'goal';
INSERT INTO goal_events (goal_id, user_id, kind, text, at)
  SELECT g.id, g.user_id, 'created', 'Goal set', g.created_at FROM goals g
  WHERE NOT EXISTS (SELECT 1 FROM goal_events e WHERE e.goal_id = g.id);
DELETE FROM user_rules WHERE kind = 'goal';
