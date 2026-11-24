-- Long-term project knowledge (delivered features, business rules in force).
CREATE TABLE IF NOT EXISTS project_knowledge (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  doc        JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
