-- USI Connector: service sync config
CREATE TABLE IF NOT EXISTS service_sync_config (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES profiles(id),
  service text NOT NULL,
  should_cache boolean DEFAULT true,
  sync_strategy text DEFAULT 'interval',
  sync_interval_minutes int DEFAULT 15,
  data_types text[] DEFAULT '{}',
  list_method text,
  read_method text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id, service)
);

ALTER TABLE service_sync_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access service_sync_config" ON service_sync_config FOR ALL USING (auth.role() = 'service_role');
