-- Skills Closedhand writes for itself (lib/skill-learning.js) live in
-- user_skills with category 'learned', beside the ones a person adds. These
-- record how often each is used, when it last changed and where it was
-- learned, so the dashboard can show it and unused ones can be removed.
ALTER TABLE user_skills ADD COLUMN IF NOT EXISTS uses integer NOT NULL DEFAULT 0;
ALTER TABLE user_skills ADD COLUMN IF NOT EXISTS last_used_at timestamptz;
ALTER TABLE user_skills ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE user_skills ADD COLUMN IF NOT EXISTS learned_from text;
