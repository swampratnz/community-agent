-- ---------------------------------------------------------------------------
-- Append-only audit log of privileged (admin) actions the agent performed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_audit (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform      TEXT        NOT NULL,
  actor_user_id TEXT        NOT NULL,           -- who asked for it
  actor_name    TEXT,
  action_kind   TEXT        NOT NULL,
  target_user_id TEXT,
  conversation_id TEXT,
  params        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  result        TEXT,
  success       BOOLEAN     NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_audit_actor_idx
  ON admin_audit (platform, actor_user_id, created_at DESC);
