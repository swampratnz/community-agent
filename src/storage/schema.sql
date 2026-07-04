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

-- Keep updated_at honest on any UPDATE path.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS knowledge_set_updated_at ON knowledge;
CREATE TRIGGER knowledge_set_updated_at
  BEFORE UPDATE ON knowledge
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS sessions_set_updated_at ON sessions;
CREATE TRIGGER sessions_set_updated_at
  BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Community membership + tiers. super_admin is env-bootstrapped and never
-- stored here; this table holds 'admin' and 'member' grants.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_users (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform      TEXT        NOT NULL,
  platform_user_id TEXT     NOT NULL,
  display_name  TEXT,
  role          TEXT        NOT NULL DEFAULT 'member',  -- 'admin' | 'member'
  added_by      TEXT,                                   -- platform user id of granter
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, platform_user_id)
);

DROP TRIGGER IF EXISTS community_users_set_updated_at ON community_users;
CREATE TRIGGER community_users_set_updated_at
  BEFORE UPDATE ON community_users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Runtime policies set by super admins (e.g. code_answers, paused).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS policies (
  key           TEXT        PRIMARY KEY,
  value         JSONB       NOT NULL,
  updated_by    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Session hygiene: cap resumed-session length (see agent/core.ts).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS turn_count INT NOT NULL DEFAULT 0;

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

-- ---------------------------------------------------------------------------
-- Server roster: who is (or was) in the platform community space, kept from
-- join/leave events plus a startup backfill. Identity metadata ONLY (id,
-- display name, join/leave timestamps) — data every server member already
-- sees in the member list. NEVER message content (see SECURITY.md). Durable
-- like community_users, not age-purged like interactions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS server_roster (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform       TEXT        NOT NULL,
  user_id        TEXT        NOT NULL,
  display_name   TEXT,
  joined_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at        TIMESTAMPTZ,                        -- null = currently present
  rejoined_count INT         NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, user_id)
);

CREATE INDEX IF NOT EXISTS server_roster_joined_idx
  ON server_roster (platform, joined_at DESC);

DROP TRIGGER IF EXISTS server_roster_set_updated_at ON server_roster;
CREATE TRIGGER server_roster_set_updated_at
  BEFORE UPDATE ON server_roster
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Admin-curated context notes about known community members (issue #45).
-- Person-scoped facts ("runs the Chch meetup") that do NOT belong in the
-- global knowledge FAQ. Human-entered only, admin-read only, deleted by the
-- member's forget_me/purge (see SECURITY.md).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS member_notes (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform      TEXT        NOT NULL,
  user_id       TEXT        NOT NULL,           -- the member the note is about
  note          TEXT        NOT NULL,
  created_by    TEXT        NOT NULL,           -- platform user id of the admin author
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS member_notes_user_idx
  ON member_notes (platform, user_id, created_at DESC);

DROP TRIGGER IF EXISTS member_notes_set_updated_at ON member_notes;
CREATE TRIGGER member_notes_set_updated_at
  BEFORE UPDATE ON member_notes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Member-submitted reports of harassment/spam/rule violations, for admins to
-- triage. Purely informational intake — no automatic action is taken on a
-- report; an admin still decides and acts via the existing `moderate` tool.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS content_reports (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform         TEXT        NOT NULL,
  reporter_user_id TEXT        NOT NULL,
  reporter_name    TEXT,
  conversation_id  TEXT        NOT NULL,
  target_user_id   TEXT,
  message_id       TEXT,
  reason           TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'open', -- 'open' | 'resolved' | 'dismissed'
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_by      TEXT,
  resolved_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS content_reports_conversation_idx
  ON content_reports (conversation_id, created_at DESC);

-- Backs the per-reporter rolling-24h rate cap (see repository.ts createContentReport).
CREATE INDEX IF NOT EXISTS content_reports_reporter_rate_idx
  ON content_reports (platform, reporter_user_id, created_at DESC);
