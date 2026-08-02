-- ---------------------------------------------------------------------------
-- Member-submitted improvement suggestions for the bot itself (issue #46) —
-- a structured path from "the bot should do X" in chat to the humans who run
-- the pipeline. The bridge to GitHub stays human: an admin reviews the queue
-- and files anything worthwhile as a proposal issue themselves; the bot
-- NEVER touches the repo.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS suggestions (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform      TEXT        NOT NULL,
  user_id       TEXT        NOT NULL,
  display_name  TEXT,
  content       TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'new', -- 'new' | 'reviewed' | 'declined' | 'done'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by   TEXT,
  reviewed_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS suggestions_status_idx
  ON suggestions (status, created_at DESC);

-- Backs the per-user rolling-24h rate cap (see repository.ts createSuggestion).
CREATE INDEX IF NOT EXISTS suggestions_user_rate_idx
  ON suggestions (platform, user_id, created_at DESC);
