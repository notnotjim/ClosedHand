-- Add user_skills table for installed skills (Worker system)
-- Run this in Supabase SQL editor

CREATE TABLE user_skills (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  source_url TEXT,
  content TEXT NOT NULL,
  category TEXT DEFAULT 'custom',
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
CREATE INDEX idx_user_skills_user ON user_skills(user_id);
