-- ---------------------------------------------------------------------------
-- Every interaction the agent sees, for auditing + learning/memory.
-- An interaction is one inbound message and the agent's response (if any).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS interactions (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform      TEXT        NOT NULL,
  conversation_id TEXT      NOT NULL,
  user_id       TEXT        NOT NULL,
  user_name     TEXT,
  role          TEXT        NOT NULL,              -- 'super_admin' | 'admin' | 'member' | 'guest'
  direction     TEXT        NOT NULL,              -- 'inbound' | 'outbound'
  content       TEXT        NOT NULL,
  addressed_to_bot BOOLEAN  NOT NULL DEFAULT false,
  is_direct     BOOLEAN     NOT NULL DEFAULT false,
  -- Cost/usage telemetry for outbound (agent) turns.
  cost_usd      DOUBLE PRECISION,
  meta          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  embedding     VECTOR(:EMBEDDING_DIM),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS interactions_convo_idx
  ON interactions (platform, conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS interactions_user_idx
  ON interactions (platform, user_id, created_at DESC);

-- Per-user daily reply budget (issue #217): countRepliesToUser counts recent
-- OUTBOUND rows keyed on (platform, meta->>'replyToUserId', created_at). Without
-- a matching index that count scans every outbound row on the hot inbound path.
-- Partial (outbound only) + the JSONB reply-target expression = an index-only
-- probe of exactly the rows the budget query touches.
CREATE INDEX IF NOT EXISTS interactions_reply_budget_idx
  ON interactions (platform, (meta->>'replyToUserId'), created_at DESC)
  WHERE direction = 'outbound';

-- Approximate nearest-neighbour index for semantic memory search.
CREATE INDEX IF NOT EXISTS interactions_embedding_idx
  ON interactions USING hnsw (embedding vector_cosine_ops);

-- Ambient archiving (issue #48): distinguish rows that address the bot from
-- ambient channel chatter, and keep the platform message id so a Discord
-- delete/edit can be honoured against the stored copy.
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'addressed';
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS message_id TEXT;

CREATE INDEX IF NOT EXISTS interactions_message_id_idx
  ON interactions (platform, message_id);

-- One-time relabel of legacy inbound rows that were never addressed to the
-- bot (recorded before `kind` existed). Idempotent: rows written after this
-- migration carry the correct kind at insert time and never match again.
UPDATE interactions SET kind = 'ambient'
 WHERE kind = 'addressed' AND direction = 'inbound'
   AND addressed_to_bot = false AND is_direct = false;
