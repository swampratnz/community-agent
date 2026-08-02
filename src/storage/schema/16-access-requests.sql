-- ---------------------------------------------------------------------------
-- Gated-mode guests who have addressed the bot, so admins have a queue of
-- who to add without relaying pings out of band. Identity + counts only —
-- never message content (mirrors the "gated guest content is not stored"
-- invariant in router.ts).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS access_requests (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform           TEXT        NOT NULL,
  user_id            TEXT        NOT NULL,
  user_name          TEXT,
  first_requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_count      INT         NOT NULL DEFAULT 1,
  UNIQUE (platform, user_id)
);

CREATE INDEX IF NOT EXISTS access_requests_last_requested_idx
  ON access_requests (last_requested_at DESC);
