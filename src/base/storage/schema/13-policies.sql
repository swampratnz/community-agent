-- ---------------------------------------------------------------------------
-- Runtime policies set by super admins (e.g. code_answers, paused).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS policies (
  key           TEXT        PRIMARY KEY,
  value         JSONB       NOT NULL,
  updated_by    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
