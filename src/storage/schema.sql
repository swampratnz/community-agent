-- Community Agent schema (PostgreSQL + pgvector)
-- The embedding dimension is templated as :EMBEDDING_DIM by migrate.ts.

CREATE EXTENSION IF NOT EXISTS vector;
-- Substring-robust trigram matching (issue #362) — the lexical fallback for
-- knowledge_search's semantic-miss path. Standard Postgres contrib, present
-- in the pgvector/pgvector:pg16 CI image.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

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
  -- Post-hoc "does this entry earn its keep" signal (issue #134): bumped by
  -- knowledge_search hits above the relevance floor, read by list_knowledge
  -- so admins can spot dead entries to prune. Deliberately excluded from the
  -- knowledge_set_updated_at trigger's column list below — retrieval hits
  -- must not look like content edits, or they'd defeat #27's recency hedging
  -- and reshuffle list_knowledge's updated_at ordering on every member search.
  retrieval_count INT       NOT NULL DEFAULT 0,
  last_retrieved_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS retrieval_count INT NOT NULL DEFAULT 0;
ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS last_retrieved_at TIMESTAMPTZ;

-- Source citation + freshness (issue #214). source_url/source_title are
-- optional provenance metadata: docs-ingest populates them automatically from
-- the page it ingested; admin-tier save_knowledge/update_knowledge/
-- accept_knowledge_candidate calls may set them explicitly. verified_at is set
-- to now() whenever a save/update call supplies a source_url — "admin-set on
-- save" for human curation, "ingest time" for docs-ingest — and is otherwise
-- left null. Deliberately excluded from the knowledge_set_updated_at trigger's
-- column list below, same exclusion as retrieval_count/last_retrieved_at:
-- editing citation metadata is not a content edit.
ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS source_url TEXT;
ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS source_title TEXT;
ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

-- Link-rot check (issue #448): an opt-in weekly background job HEAD-checks
-- every entry's source_url and stamps whether it's still reachable, so a
-- dead citation doesn't keep rendering as authoritative to members forever
-- with no admin signal. Both nullable/default NULL: an entry with no
-- source_url, or one never yet checked, has source_unreachable = NULL
-- ("unknown"), distinct from false ("checked, still resolves"). Deliberately
-- excluded from the knowledge_set_updated_at trigger's column list, same
-- exclusion as retrieval_count/source_url above — a reachability check is
-- not a content edit.
ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS source_unreachable BOOLEAN;
ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS source_checked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS knowledge_embedding_idx
  ON knowledge USING hnsw (embedding vector_cosine_ops);

-- Lexical fallback support (issue #362): searchKnowledgeLexical's
-- word_similarity() query against the same COALESCE(title,'') || ' ' ||
-- content expression this index is built on. title is nullable, so the
-- COALESCE must match on both sides or null-titled entries silently never
-- match.
CREATE INDEX IF NOT EXISTS knowledge_trgm_idx
  ON knowledge USING gin ((COALESCE(title, '') || ' ' || content) gin_trgm_ops);

-- Keep updated_at honest on any UPDATE path.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Scoped to the content-bearing columns (not retrieval_count/last_retrieved_at)
-- so a knowledge_search hit's counter bump never touches updated_at — see the
-- comment on those columns above.
DROP TRIGGER IF EXISTS knowledge_set_updated_at ON knowledge;
CREATE TRIGGER knowledge_set_updated_at
  BEFORE UPDATE OF scope, title, content, source_user_id, created_by_role, embedding ON knowledge
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
-- Cross-platform identity linking: a `persons` row groups the
-- community_users rows that are the same human (e.g. one member's Discord
-- account and WhatsApp number) so forget_me/purge, the daily reply budget,
-- and admin views can follow the person, not the platform row. Created only
-- via the admin-tier `link_member` tool (see repository.ts) — never inferred
-- from message content, and never touches `role` (tier stays per-platform-row
-- by design; see docs/SECURITY.md).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS persons (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE community_users ADD COLUMN IF NOT EXISTS person_id BIGINT REFERENCES persons(id);

CREATE INDEX IF NOT EXISTS community_users_person_idx ON community_users (person_id);

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
  status           TEXT        NOT NULL DEFAULT 'open', -- 'open' | 'resolved' | 'dismissed' | 'withdrawn' (by reporter)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_by      TEXT,
  resolved_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS content_reports_conversation_idx
  ON content_reports (conversation_id, created_at DESC);

-- Backs the per-reporter rolling-24h rate cap (see repository.ts createContentReport).
CREATE INDEX IF NOT EXISTS content_reports_reporter_rate_idx
  ON content_reports (platform, reporter_user_id, created_at DESC);

-- Was this report filed from a 1:1 DM (WhatsApp is always DM; Discord DM
-- channel)? Derived from the platform/channel type at creation time, never
-- from message content — see CallerContext.isDirect (issue #197). Existing
-- rows default to false (non-retroactive: pre-#197 DM reports stay
-- super-admin-only, matching their original visibility contract).
ALTER TABLE content_reports ADD COLUMN IF NOT EXISTS is_dm BOOLEAN NOT NULL DEFAULT false;

-- Backs list_reports's optional targetUserId filter (issue #463), mirroring
-- moderation_history's target filter (#83).
CREATE INDEX IF NOT EXISTS content_reports_target_idx
  ON content_reports (target_user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Restart-safe freshness guard for the weekly proactive admin
-- recurring-questions digest (issue #97): one row per admin identity, so a
-- redeploy/restart mid-week can't re-send within the same freshness window.
-- Identity + timestamp only — no message content, no cluster text — and
-- deletable by forget_me/purge_user_data alongside other admin-identity-keyed
-- rows.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_digest_sends (
  platform         TEXT        NOT NULL,
  platform_user_id TEXT        NOT NULL,
  sent_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, platform_user_id)
);
-- Week-over-week trend snapshot (issue #497): the exact same bare integers
-- the digest already sends this admin, nothing more — see
-- `sanitizeDigestCounts`/`getLastDigestCounts`/`recordAdminDigestSnapshot` in
-- repository.ts. Deliberately NOT bumped by the snapshot-only write path, so
-- it stays decoupled from the `sent_at` freshness guard above.
ALTER TABLE admin_digest_sends ADD COLUMN IF NOT EXISTS last_counts JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- Standing "plain language" response-style preference (issue #126), set by
-- the member/guest-tier `set_response_style` tool so it doesn't need re-
-- asking every message. Keyed on raw (platform, user_id) like
-- `admin_digest_sends` above, not `community_users`, so it works for any
-- caller the bot talks to, including a guest in open mode. No row = today's
-- default ('standard') behaviour — see `getResponseStyle` in repository.ts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS response_style_prefs (
  platform      TEXT        NOT NULL,
  user_id       TEXT        NOT NULL,
  style         TEXT        NOT NULL DEFAULT 'standard' CHECK (style IN ('standard', 'plain')),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, user_id)
);

-- ---------------------------------------------------------------------------
-- Standing language-reply preference (issue #189), set by the member/guest-
-- tier `set_language_preference` tool so a caller who wants every reply in a
-- specific language doesn't need to re-ask each message. Keyed on raw
-- (platform, user_id) like `response_style_prefs` above, not
-- `community_users`, so it works for a guest in open mode too. No row (or
-- 'auto') means today's default per-message language-mirroring behaviour
-- (issue #68) — see `getLanguagePreference` in repository.ts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS language_prefs (
  platform      TEXT        NOT NULL,
  user_id       TEXT        NOT NULL,
  language      TEXT        NOT NULL DEFAULT 'auto' CHECK (language IN ('auto', 'en', 'mi')),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, user_id)
);

-- ---------------------------------------------------------------------------
-- Auto-moderation strikes (Discord bad-language / abuse warnings). One row
-- per warning against a member, keyed on raw (platform, user_id) like
-- response_style_prefs — a warned user need not be in community_users. An
-- ACTIVE strike is one with cleared_at IS NULL; a member is "blocked" (muted
-- role assigned) once their active-strike count reaches the configured limit.
-- An admin clears warnings by stamping cleared_at/cleared_by on all of a
-- user's active rows (which also lifts the mute). `source` distinguishes an
-- automatic detection from an admin-issued warning; `excerpt` stores only a
-- short capped snippet of the offending message for admin context, never the
-- whole message (see SECURITY.md). Purge-coherent: forget_me/purge_user_data
-- delete a user's rows.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS member_warnings (
  id          BIGSERIAL   PRIMARY KEY,
  platform    TEXT        NOT NULL,
  user_id     TEXT        NOT NULL,
  reason      TEXT        NOT NULL,
  excerpt     TEXT,
  source      TEXT        NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'admin')),
  issued_by   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  cleared_at  TIMESTAMPTZ,
  cleared_by  TEXT
);

-- Fast active-strike count / "is this member blocked" lookups on the hot path
-- (every scanned message checks the warned user's active strike count).
CREATE INDEX IF NOT EXISTS member_warnings_active_idx
  ON member_warnings (platform, user_id)
  WHERE cleared_at IS NULL;

-- ---------------------------------------------------------------------------
-- Admin-reviewed queue that turns a recurring `context_digests` cluster into
-- a durable `knowledge` entry (issue #102 — the `knowledge_candidates` half
-- of #51 that its adversarial review deferred). Model-drafted Q&A text over
-- member chat; nothing ever reaches `knowledge` (and therefore no tier's
-- `knowledge_search`) except through an explicit admin
-- `accept_knowledge_candidate` call — the human-curation invariant this repo
-- keeps for `knowledge` generally. `topic` is denormalized from the source
-- digest at insert time (not just read through `digest_id`) so the builder's
-- dedup guard and this queue's display keep working after a purge nulls
-- `digest_id` (see `purgeSingleIdentity` in repository.ts, which deletes
-- still-*pending* candidates outright when their digest is invalidated, and
-- only nulls the link for accepted/declined ones — accepted candidates are
-- already admin-reviewed knowledge and get the same accountability
-- treatment as `knowledge`/`admin_audit` generally).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_candidates (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  digest_id     BIGINT REFERENCES context_digests(id) ON DELETE SET NULL,
  topic         TEXT        NOT NULL,
  title         TEXT        NOT NULL,
  content       TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by   TEXT,
  reviewed_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS knowledge_candidates_status_idx
  ON knowledge_candidates (status, created_at DESC);

CREATE INDEX IF NOT EXISTS knowledge_candidates_digest_idx
  ON knowledge_candidates (digest_id);

-- ---------------------------------------------------------------------------
-- Member feedback on the bot's own answers (issue #118) — the deferred
-- feedback-loop half of #60 (which taught the model to attribute
-- knowledge-base answers and flag general-knowledge ones, but explicitly
-- deferred a rating mechanism). A member rates the most recent answer the
-- bot gave *them* in this conversation. Purge coherence: `interaction_id` is
-- `ON DELETE SET NULL` so purging the rated reply (the recipient's own
-- forget_me/purge_user_data, via purgeSingleIdentity's interactions delete)
-- drops the dangling reference without orphaning or cascading into this
-- table, keeping the aggregate
-- helpful/unhelpful trend intact; `forget_me`/`purge_user_data` separately
-- delete the rater's *own* answer_feedback rows (see repository.ts).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS answer_feedback (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform        TEXT        NOT NULL,
  conversation_id TEXT        NOT NULL,
  user_id         TEXT        NOT NULL,
  interaction_id  BIGINT      REFERENCES interactions(id) ON DELETE SET NULL,
  helpful         BOOLEAN     NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS answer_feedback_conversation_idx
  ON answer_feedback (conversation_id, created_at DESC);

-- Backs the per-rater rolling-24h rate cap (see repository.ts createAnswerFeedback).
CREATE INDEX IF NOT EXISTS answer_feedback_user_rate_idx
  ON answer_feedback (platform, user_id, created_at DESC);

-- Optional free-text reason alongside the boolean (issue #354, the follow-up
-- #118 explicitly deferred). Nullable, no backfill: a rating with no
-- accompanying reason stores NULL exactly as before. Deleted along with the
-- rest of the row by the rater's own forget_me/purge_user_data purge — no new
-- retention or deletion path.
ALTER TABLE answer_feedback ADD COLUMN IF NOT EXISTS comment TEXT;

-- ---------------------------------------------------------------------------
-- Knowledge-search misses (issue #208): a `knowledge_search` call that
-- returned hits but none cleared KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD,
-- persisted so admins can see what real questions have no confident answer
-- yet — the complement `question_digest`/`knowledge_candidates`/
-- `countStaleKnowledge` don't capture (see repository.ts's
-- `recordKnowledgeGap` for why this is gated on "hits existed but none
-- cleared the floor", not merely "zero hits", so an embed() outage can't
-- masquerade as a wave of genuine misses). Purge-coherent: forget_me/
-- purge_user_data delete the caller's own rows.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_gaps (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform        TEXT        NOT NULL,
  conversation_id TEXT        NOT NULL,
  user_id         TEXT        NOT NULL,
  query_text      TEXT        NOT NULL,
  embedding       VECTOR(:EMBEDDING_DIM),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_gaps_conversation_idx
  ON knowledge_gaps (platform, conversation_id, created_at DESC);

-- Backs the per-user rolling-24h insert cap (see repository.ts recordKnowledgeGap).
CREATE INDEX IF NOT EXISTS knowledge_gaps_user_rate_idx
  ON knowledge_gaps (platform, user_id, created_at DESC);

-- Set once a later save_knowledge/update_knowledge clears
-- KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD against this gap's stored query
-- embedding (see repository.ts's resolveKnowledgeGaps, issue #422) — the
-- accept-gap curation loop #213's review named but #208 never built. NULL
-- (including every pre-existing row) means still unresolved. forget_me/
-- purge_user_data delete the row outright regardless of this value.
ALTER TABLE knowledge_gaps ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

-- Backs the `AND resolved_at IS NULL` filter both list_knowledge_gaps
-- (recentKnowledgeGapClusters) and countKnowledgeGaps add.
CREATE INDEX IF NOT EXISTS knowledge_gaps_unresolved_idx
  ON knowledge_gaps (conversation_id, created_at DESC) WHERE resolved_at IS NULL;

-- True for a row written by recordEscalatedKnowledgeGap — a confirmed,
-- member-initiated escalation (issue #479) rather than a passive
-- below-floor knowledge_search miss. Distinguishes "a member asked a human
-- directly" from an ordinary gap for curation priority (issue #514). Every
-- pre-existing row defaults to false (correct: none of them were escalated).
-- forget_me/purge_user_data already delete knowledge_gaps rows by user_id
-- regardless of this column, so no extra purge code is needed.
ALTER TABLE knowledge_gaps ADD COLUMN IF NOT EXISTS escalated BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- Cost of the three standalone background `query()` calls (issue #401) that
-- spend from the shared Max pool but write no `interactions` row, so
-- `usageStats()` (interactions-only) never saw them: the opt-in Stage-2 LLM
-- abuse classifier (`classifyAbuseWithLlm`), the offline context-builder
-- digest call (`summarizeCluster`), and the daily knowledge-refresh research
-- call (`researchTopic`). `job` is a fixed enum, never free text or anything
-- derived from chat content. Bare aggregate data only, same as
-- `admin_digest_sends` — no user id, conversation id, or platform, so
-- forget_me/purge_user_data have nothing to touch here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS background_job_costs (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job        TEXT        NOT NULL CHECK (job IN ('moderation_llm', 'context_builder', 'knowledge_refresh')),
  cost_usd   NUMERIC     NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS background_job_costs_created_at_idx
  ON background_job_costs (created_at DESC);

-- ---------------------------------------------------------------------------
-- Durable completion-DM watches for the super-admin dev-team dispatch tools
-- (dev_team_dispatch, dev_team_verify). One row per dispatched job: who asked
-- (platform + user id, for the DM back), plus the job's mode/repo for the
-- verdict text (for mode 'verify' the repo column carries the SOURCE
-- assessment job id instead — all the verdict DM needs to name). A
-- background poller (src/backgroundJobs.ts) reads unnotified rows, checks each
-- job's status over the tailnet, and on a terminal state (succeeded/failed)
-- DMs the requester then stamps notified_at — so a ~20-min run's completion
-- ping survives a bot restart and is sent at most once (the primary key +
-- notified_at guard prevent a double-send). Identity + job metadata only,
-- never any part of the requester's message content or the service's report.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dev_team_watches (
  job_id             TEXT        PRIMARY KEY,
  requester_platform TEXT        NOT NULL,
  requester_user_id  TEXT        NOT NULL,
  mode               TEXT        NOT NULL,
  repo               TEXT        NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at        TIMESTAMPTZ
);

-- The poller scans only unnotified rows every ~minute; a partial index keeps
-- that scan cheap as completed-and-notified rows accumulate.
CREATE INDEX IF NOT EXISTS dev_team_watches_unnotified_idx
  ON dev_team_watches (created_at)
  WHERE notified_at IS NULL;

-- ---------------------------------------------------------------------------
-- Durable hit counts for the four env-gated turn-skipping shortcuts (issue
-- #440) — each avoids a `query()` call against the shared Max pool but, until
-- now, recorded nothing beyond a single `logger.debug`/`.info` line, so a
-- super admin who enables one has no evidence of how often it actually fires.
-- `kind` is a fixed enum, never free text or anything derived from message
-- content — deliberately narrower than `interactions` (no user id,
-- conversation id, or platform) and narrower than `background_job_costs`
-- (no tie to a specific job run): a bare event marker, mirrored on that
-- table's shape. The `knowledge` kind counts only the member-facing knowledge
-- shortcut (`sendKnowledgeShortcut`) — the separate guest knowledge shortcut
-- (`sendGuestKnowledgeShortcut`) is deliberately excluded (see router.ts) so
-- this count is never misread as covering both. forget_me/purge_user_data
-- have nothing to touch here, same as background_job_costs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shortcut_hits (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind       TEXT        NOT NULL CHECK (kind IN ('ack', 'knowledge', 'repeat_question', 'repeat_max_turns')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shortcut_hits_created_at_idx
  ON shortcut_hits (created_at DESC);

-- ---------------------------------------------------------------------------
-- Semantic half of the knowledge_candidates dedup guard (issue #503).
-- hasQueuedCandidateForTopic's exact (case-insensitive) string match doesn't
-- catch a paraphrased topic label — the offline builder's free-text `TOPIC:`
-- summary for the same recurring question can drift in wording run over run,
-- so an admin's decline of "Wellington meetup schedule" didn't stop
-- "when's the next Wellington meetup?" from resurfacing later. Nullable, no
-- backfill for rows inserted before this column existed (non-retroactive —
-- see docs/ARCHITECTURE.md); those rows simply never match on the semantic
-- path but remain covered by the untouched exact-match fast path.
-- ---------------------------------------------------------------------------
ALTER TABLE knowledge_candidates ADD COLUMN IF NOT EXISTS topic_embedding VECTOR(:EMBEDDING_DIM);

-- ---------------------------------------------------------------------------
-- Restart-safe freshness guard for the proactive engagement-percentage alert
-- (issue #568): a push companion to the pull-only, super-admin-only
-- `engagement_stats` tool (issue #419). Unlike `admin_digest_sends`, this is
-- deliberately SINGLE-ROW/guild-wide, not per-identity — `engagementStats()`
-- itself is a guild-wide, unscoped aggregate, not something computed per
-- recipient, so there is nothing to key per admin. The `id = 1` CHECK plus a
-- fixed-value upsert enforce the single row. `last_percentage` is forward-
-- compat only for a v2 week-over-week trend suffix (mirroring `admin_digest_
-- sends.last_counts`'s own growth path) — this PR writes it but MUST NOT read
-- or render it. No user/admin identifier column: forget_me/purge_user_data
-- have nothing to touch here, same as `background_job_costs`/`shortcut_hits`.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS engagement_alert_sends (
  id              SMALLINT    PRIMARY KEY DEFAULT 1,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_percentage NUMERIC,
  CONSTRAINT engagement_alert_sends_singleton CHECK (id = 1)
);
