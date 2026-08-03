-- ---------------------------------------------------------------------------
-- Member-declared interests for member-to-member discovery (issue #634) — a
-- single self-scoped, embedded, opt-in-published free-text blob per identity
-- (one row per (platform, user_id), upsert semantics), purged with the rest
-- of a member's data. member_projects below reuses this same table shape for
-- discrete named artifacts instead of one fuzzy blob per member.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS member_interests (
  platform      TEXT        NOT NULL,
  user_id       TEXT        NOT NULL,
  interests     TEXT        NOT NULL,
  embedding     VECTOR(:EMBEDDING_DIM),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, user_id)
);

CREATE INDEX IF NOT EXISTS member_interests_embedding_idx
  ON member_interests USING hnsw (embedding vector_cosine_ops);

-- Opt-in "notify me to help" flag for find_helper (issue #729) — rides the
-- existing member_interests row rather than a new table, so the existing
-- purgeSingleIdentity/markRosterLeave deletes of member_interests already
-- cover it with zero new purge code. Same ADD COLUMN IF NOT EXISTS
-- convention as member_projects.removed_at below.
ALTER TABLE member_interests ADD COLUMN IF NOT EXISTS willing_to_help BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- Member-declared project showcase (issue #646) — the second instance of
-- #634's self-declared-member-table pattern: opt-in, self-scoped, embedded,
-- purged with the rest of a member's data. Unlike member_interests (a fuzzy
-- discovery blob), these are discrete named artifacts a member accumulates
-- over time, hence the per-(platform,user_id,name) uniqueness (upsert-by-edit)
-- and the small per-member cap enforced in repository.ts's shareProject.
-- Deliberately NO display_name column: owner attribution is resolved at
-- render time via resolveDisplayName/resolveSanitizedLabel (community_users/
-- server_roster), the same freshness-over-staleness choice already made for
-- every other attributed-to-a-member render in this codebase.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS member_projects (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform      TEXT        NOT NULL,
  user_id       TEXT        NOT NULL,
  name          TEXT        NOT NULL,
  description   TEXT        NOT NULL,
  link          TEXT,                  -- verbatim member-supplied URL, stored as text, NEVER fetched
  embedding     VECTOR(:EMBEDDING_DIM),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Soft-delete marker for remove_project (repository.ts removeMemberProject)
  -- — deliberately NOT a hard DELETE, so the rolling-24h rate cap's COUNT(*)
  -- still sees a since-removed row and a share/remove/share cycle can't
  -- bypass it (same reasoning as content_reports' status = 'withdrawn').
  -- purgeSingleIdentity/markRosterLeave still hard-DELETE for full erasure.
  removed_at    TIMESTAMPTZ
);

-- Forwards-compatible with an already-applied earlier revision of this same
-- migration (soft-delete was added after the table's first draft) — same
-- ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT IF EXISTS convention already
-- used for knowledge.retrieval_count above.
ALTER TABLE member_projects ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;
ALTER TABLE member_projects DROP CONSTRAINT IF EXISTS member_projects_platform_user_id_name_key;

-- Self-declared "I'd welcome help on this" signal (issue #834) — same shape
-- as member_interests.willing_to_help above: boolean, opt-in, default false,
-- rendered only when true.
ALTER TABLE member_projects ADD COLUMN IF NOT EXISTS seeking_collaborators BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS member_projects_recent_idx
  ON member_projects (created_at DESC) WHERE removed_at IS NULL;

-- Backs both the per-member cap and the rolling-24h rate cap (see
-- repository.ts shareProject) — same shape as suggestions_user_rate_idx.
-- Deliberately NOT filtered on removed_at: the rate cap's COUNT(*) must see
-- soft-removed rows too.
CREATE INDEX IF NOT EXISTS member_projects_user_rate_idx
  ON member_projects (platform, user_id, created_at DESC);

-- Name is unique only among a member's ACTIVE projects (upsert-by-name
-- target) — a partial index rather than a plain UNIQUE constraint so a name
-- freed by remove_project can be reused for a later, genuinely new share.
CREATE UNIQUE INDEX IF NOT EXISTS member_projects_active_name_idx
  ON member_projects (platform, user_id, name) WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS member_projects_embedding_idx
  ON member_projects USING hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- Notification log for find_helper's opt-in member-to-member help handoff
-- (issue #729) — the active-side consumer of member_interests.willing_to_help
-- above. Backs both the per-helper rolling-7-day cap and the per-requester
-- rolling-24h cap (repository.ts recordHelperNotificationIfUnderCap /
-- isFindHelperRequesterAtDailyCap), DB-backed so neither is an in-memory
-- counter that resets on restart. Also gives purgeSingleIdentity/
-- markRosterLeave rows to delete in EITHER role (helper or requester).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS helper_notifications (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  helper_platform    TEXT        NOT NULL,
  helper_user_id     TEXT        NOT NULL,
  requester_platform TEXT        NOT NULL,
  requester_user_id  TEXT        NOT NULL,
  topic              TEXT        NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backs the per-helper rolling-7-day cap check inside
-- recordHelperNotificationIfUnderCap's own INSERT ... WHERE (SELECT ...).
CREATE INDEX IF NOT EXISTS helper_notifications_helper_idx
  ON helper_notifications (helper_platform, helper_user_id, created_at DESC);

-- Backs the per-requester rolling-24h cap check in
-- isFindHelperRequesterAtDailyCap.
CREATE INDEX IF NOT EXISTS helper_notifications_requester_idx
  ON helper_notifications (requester_platform, requester_user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Connection-request log for request_project_connection (issue #840) — the
-- signal-to-action handoff for member_projects.seeking_collaborators (#834),
-- byte-for-byte mirroring helper_notifications' shape above: an append-only
-- log (never edited in place) backing two independent DB-backed
-- rolling-window caps (repository.ts recordProjectConnectionIfUnderCap /
-- isProjectConnectionRequesterAtDailyCap), never in-memory counters that
-- reset on restart. Also gives purgeSingleIdentity/markRosterLeave rows to
-- delete in EITHER role (owner or requester).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_connection_requests (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_platform     TEXT        NOT NULL,
  owner_user_id      TEXT        NOT NULL,
  requester_platform TEXT        NOT NULL,
  requester_user_id  TEXT        NOT NULL,
  project_id         BIGINT      NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backs the per-owner rolling-7-day cap check inside
-- recordProjectConnectionIfUnderCap's own INSERT ... WHERE (SELECT ...).
CREATE INDEX IF NOT EXISTS project_connection_requests_owner_idx
  ON project_connection_requests (owner_platform, owner_user_id, created_at DESC);

-- Backs the per-requester rolling-24h cap check in
-- isProjectConnectionRequesterAtDailyCap.
CREATE INDEX IF NOT EXISTS project_connection_requests_requester_idx
  ON project_connection_requests (requester_platform, requester_user_id, created_at DESC);
