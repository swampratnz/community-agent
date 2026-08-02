-- ---------------------------------------------------------------------------
-- Projects (issue #927): a standing team's shared memory — an Impact Lab, a
-- working group — that follows the TEAM across platforms instead of living in
-- one channel. Three things make this different from `member_projects` (which
-- is a public showcase row: name, description, link, no content and no ACL):
--
--  1. Membership is per-identity here, but VISIBILITY expands through
--     `persons` at query time (see visibleProjectIds), so one human's Discord
--     and WhatsApp identities reach the same project once `link_member` has
--     linked them. Deliberately NOT keyed on person_id directly: linkMembers
--     MERGES person rows (keeps the lower id, drops the other), so a
--     person-keyed FK here would need repointing on every link/unlink. Keying
--     on the platform identity and expanding at read time has no such coupling.
--  2. Content lives in `project_notes` below, NOT in `knowledge`. Reusing
--     `knowledge` with a `scope = 'project:<id>'` value was the original
--     design and was rejected during implementation: `knowledge` has ~20
--     readers that are unrestricted by default (listKnowledge, the duplicate
--     and conflict pair-finders, the link-rot checker, the staleness
--     readers, every get-entry-by-id path), so private project content would
--     have been one un-audited caller away from an admin-facing view — and
--     every future reader would be a new leak site. A separate table means
--     every reader of project content is project-aware by construction.
--  3. Access needs TWO checks, not one. Membership says who may read; the
--     surface binding says WHERE it may be rendered. Without the second
--     check, a member asking in a public channel would have private project
--     content recited in front of everyone — issue #106's failure mode with
--     a team's private notes instead of one conversation's.
--
-- A project grants DATA SCOPE ONLY, never a tier: nothing here is consulted
-- when deriving the per-turn tool surface, exactly as `persons` "never
-- touches role". See docs/SECURITY.md.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projects (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug          TEXT        NOT NULL UNIQUE,
  name          TEXT        NOT NULL,
  -- Standing context for the project. DATA, NEVER AUTHORITY: it is rendered
  -- as project context and can never override the system prompt's security
  -- section, the same rule personas.ts already lives under.
  brief         TEXT,
  -- Nulled (not deleted) by forget_me/purge_user_data — the project outlives
  -- its creator's erasure. See purgeSingleIdentity.
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at   TIMESTAMPTZ
);

-- One row per platform identity in the project. Hard-DELETEd by forget_me:
-- pure identity, nothing shared is lost with it.
CREATE TABLE IF NOT EXISTS project_members (
  project_id    BIGINT      NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  platform      TEXT        NOT NULL,
  user_id       TEXT        NOT NULL,
  added_by      TEXT,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, platform, user_id)
);

CREATE INDEX IF NOT EXISTS project_members_identity_idx
  ON project_members (platform, user_id);

-- Where a project's content may be rendered. A DM to a member is always an
-- allowed surface and is NOT stored here (there is no stable conversation id
-- to bind); every non-DM conversation must be bound explicitly.
CREATE TABLE IF NOT EXISTS project_surfaces (
  project_id      BIGINT      NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  platform        TEXT        NOT NULL,
  conversation_id TEXT        NOT NULL,
  bound_by        TEXT,
  bound_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, platform, conversation_id)
);

CREATE INDEX IF NOT EXISTS project_surfaces_conversation_idx
  ON project_surfaces (platform, conversation_id);

-- The project's own memory: notes, decisions, facts. Embedded for semantic
-- recall exactly as `knowledge` is, but read ONLY through searchProjectNotes,
-- which enforces membership + surface in SQL.
--
-- `author_user_id` is NULLED by forget_me/purge_user_data rather than the row
-- being deleted (owner decision on #927): a departing member's erasure must
-- not silently gut the team's shared decisions. Precedent:
-- knowledge_candidates nulls its link for reviewed rows. NOTE the documented
-- residual — nulling authorship does not scrub personal information that the
-- note's own TEXT may contain; see docs/SECURITY.md.
CREATE TABLE IF NOT EXISTS project_notes (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id     BIGINT      NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title          TEXT,
  content        TEXT        NOT NULL,
  -- Verbatim member-supplied URL, stored as text, NEVER fetched — same rule
  -- as member_projects.link. This is how an external doc is referenced
  -- without this service becoming a file store or a fetcher.
  reference_url  TEXT,
  author_platform TEXT,
  author_user_id  TEXT,
  embedding      VECTOR(:EMBEDDING_DIM),
  retrieval_count INT        NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_notes_project_idx
  ON project_notes (project_id);

DROP TRIGGER IF EXISTS project_notes_set_updated_at ON project_notes;
CREATE TRIGGER project_notes_set_updated_at
  BEFORE UPDATE OF title, content, reference_url, embedding ON project_notes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
