-- Worker Teams: project-level grouping + individual tasks
-- Run this in Supabase SQL editor

-- Worker Teams (project-level grouping)
CREATE TABLE IF NOT EXISTS worker_teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'planning',
  plan JSONB DEFAULT '[]',
  brain_note_title TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  platform TEXT DEFAULT 'dashboard',
  chat_id TEXT DEFAULT 'dashboard',
  model TEXT DEFAULT 'sonnet',
  triggered_by TEXT DEFAULT 'manual'
);

-- Worker Team Tasks (individual todos within a team)
CREATE TABLE IF NOT EXISTS worker_team_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES worker_teams(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  lane TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  depends_on UUID[] DEFAULT '{}',
  sort_order INT DEFAULT 0,
  run_id UUID,
  result TEXT,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_worker_teams_user ON worker_teams(user_id);
CREATE INDEX IF NOT EXISTS idx_worker_teams_status ON worker_teams(status);
CREATE INDEX IF NOT EXISTS idx_worker_team_tasks_team ON worker_team_tasks(team_id);
CREATE INDEX IF NOT EXISTS idx_worker_team_tasks_status ON worker_team_tasks(status);
