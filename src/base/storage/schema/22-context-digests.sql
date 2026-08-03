-- ---------------------------------------------------------------------------
-- Durable community-context digests distilled from interactions by the
-- offline context builder (issue #51). Each row is one recurring topic over
-- one period. example_refs are interaction ids, NEVER copied content, so a
-- privacy purge can invalidate affected digests (see repository.purgeUserData).
-- Digests deliberately outlive the raw rows the retention purge ages out.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS context_digests (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  period_start   TIMESTAMPTZ NOT NULL,
  period_end     TIMESTAMPTZ NOT NULL,
  platform       TEXT,                              -- null = all platforms
  topic          TEXT        NOT NULL,
  summary        TEXT        NOT NULL,
  example_refs   BIGINT[]    NOT NULL DEFAULT '{}',
  distinct_users INT         NOT NULL,
  question_count INT         NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS context_digests_created_idx
  ON context_digests (created_at DESC);
