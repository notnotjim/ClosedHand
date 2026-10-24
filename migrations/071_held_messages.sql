-- Messages Closedhand raised on its own in the person's quiet hours, kept
-- until those hours end and then sent (lib/proactive.js). One row is one
-- message to one chat app, deleted once it has gone.
CREATE TABLE IF NOT EXISTS held_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  platform         text NOT NULL,
  platform_user_id text NOT NULL,
  text             text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS held_messages_user ON held_messages (user_id, created_at);
