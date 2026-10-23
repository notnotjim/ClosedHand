-- 069_routines_in_projects.sql: a routine can belong to a project.
--
-- It then runs inside the project, with its instructions, record and files,
-- and what it finds comes with the project's emoji and is kept in the
-- project's own conversation (lib/automations.js, lib/task-delivery.js).
-- Deleting the project leaves its routines running on their own.
ALTER TABLE automations ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_automations_project ON automations (project_id) WHERE project_id IS NOT NULL;
