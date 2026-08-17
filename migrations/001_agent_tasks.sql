-- Background Agents: agent_tasks table
-- Run this in Supabase SQL editor

CREATE TABLE agent_tasks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  model TEXT NOT NULL DEFAULT 'claude-haiku-4-5-20251001',
  platform TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  result TEXT,
  progress TEXT[],
  messages JSONB,
  tools_used TEXT[],
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_agent_tasks_user ON agent_tasks(user_id, status);
