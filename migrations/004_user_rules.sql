CREATE TABLE IF NOT EXISTS user_rules (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  rule TEXT NOT NULL,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  source TEXT DEFAULT 'user'
);
CREATE INDEX IF NOT EXISTS idx_user_rules_active ON user_rules(user_id, active) WHERE active = true;
