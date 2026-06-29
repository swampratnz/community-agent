-- Community Agent schema (PostgreSQL + pgvector)
-- The embedding dimension is templated as :EMBEDDING_DIM by migrate.ts.

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- Conversation <-> Claude session mapping (for multi-turn continuity).
-- One Claude session id per (platform, conversation).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform      TEXT        NOT NULL,
  conversation_id TEXT      NOT NULL,
  claude_session_id TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, conversation_id)
);

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
  role          TEXT        NOT NULL,              -- 'admin' | 'user'
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

-- Approximate nearest-neighbour index for semantic memory search.
CREATE INDEX IF NOT EXISTS interactions_embedding_idx
  ON interactions USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- Durable facts/knowledge the agent learns or admins curate.
-- Distinct from raw interactions: these are deliberately-saved, reusable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope         TEXT        NOT NULL DEFAULT 'global', -- 'global' | platform | conversation
  title         TEXT,
  content       TEXT        NOT NULL,
  source_user_id TEXT,
  created_by_role TEXT      NOT NULL DEFAULT 'admin',
  embedding     VECTOR(:EMBEDDING_DIM),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_embedding_idx
  ON knowledge USING hnsw (embedding vector_cosine_ops);

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
