-- 068_projects.sql: projects, grown out of matters (043).
--
-- A project is something the person is working on over days or weeks: a
-- move, a wedding, a trip, a piece of work. It has an emoji that marks it in
-- every chat app, what it is (a sentence or two), the instructions Closedhand
-- follows for anything in it, its context (files, notes, links, and emails,
-- events or messages from connected apps, kept by id), and the live picture
-- matters kept: where it stands, who said what, what is open, what was
-- decided. Closedhand never starts one silently: it offers once (status
-- offered) and the person says yes, or starts one themselves. The matters
-- table goes with no copy, by choice: nothing in it was something the person
-- had asked for.
DROP TABLE IF EXISTS matters;
CREATE TABLE IF NOT EXISTS projects (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  name text NOT NULL,
  emoji text,                                  -- null while only offered
  about text DEFAULT '' NOT NULL,              -- what it is, in the person's words
  instructions text DEFAULT '' NOT NULL,       -- how Closedhand handles anything in it, one a line
  summary text,                                -- one line on where it stands
  state jsonb DEFAULT '{}'::jsonb NOT NULL,    -- { people: [{name, position, said, when}], facts: [], open: [], decisions: [] }
  context jsonb DEFAULT '[]'::jsonb NOT NULL,  -- [{ kind, id, title, ... }]: project-rules.js cleanItem
  status text DEFAULT 'active' NOT NULL,       -- offered | active | archived | declined
  expected_end timestamptz,
  last_touched timestamptz DEFAULT now() NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  offered_at timestamptz,
  archived_at timestamptz,
  CONSTRAINT projects_pkey PRIMARY KEY (id),
  CONSTRAINT projects_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_projects_user_status ON projects (user_id, status, last_touched DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_one_emoji ON projects (user_id, emoji) WHERE status = 'active';

-- Each project has a conversation of its own, as a thread that is never the
-- open one: a message with the project's emoji continues it from any chat
-- app, and the person's other conversation never sees it.
ALTER TABLE conversation_threads ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_conversation_threads_project ON conversation_threads (project_id) WHERE project_id IS NOT NULL;

-- A goal is a project's goal, kept in the shape research shows gets goals
-- done (055): one a project, and it goes with the project. Goals made before
-- projects belonged to nothing and go, by choice: nobody has any yet.
ALTER TABLE goals ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects(id) ON DELETE CASCADE;
DELETE FROM goals WHERE project_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_goals_one_per_project ON goals (project_id) WHERE project_id IS NOT NULL;
