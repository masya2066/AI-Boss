-- DevPilot durable state. PostgreSQL is the source of truth.
CREATE TABLE IF NOT EXISTS projects (
  id             TEXT PRIMARY KEY,
  repo_path      TEXT NOT NULL,
  policy_path    TEXT,
  default_branch TEXT NOT NULL DEFAULT 'main',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  state            TEXT NOT NULL,
  version          INTEGER NOT NULL,
  doc              JSONB NOT NULL,          -- full Task document
  lease_owner      TEXT,
  lease_expires_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_state_idx ON tasks(state);
CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks(project_id);

-- Append-only event log: every transition, gate run, agent run, denial.
CREATE TABLE IF NOT EXISTS task_events (
  id       BIGSERIAL PRIMARY KEY,
  task_id  TEXT NOT NULL REFERENCES tasks(id),
  ts       TIMESTAMPTZ NOT NULL DEFAULT now(),
  type     TEXT NOT NULL,
  data     JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS task_events_task_idx ON task_events(task_id, id);

CREATE TABLE IF NOT EXISTS agent_runs (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  role       TEXT NOT NULL,
  status     TEXT NOT NULL,
  session_id TEXT,
  doc        JSONB NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_runs_task_idx ON agent_runs(task_id);

-- Event log is immutable.
CREATE OR REPLACE FUNCTION devpilot_forbid_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'task_events is append-only'; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS task_events_immutable ON task_events;
CREATE TRIGGER task_events_immutable BEFORE UPDATE OR DELETE ON task_events
  FOR EACH ROW EXECUTE FUNCTION devpilot_forbid_mutation();
