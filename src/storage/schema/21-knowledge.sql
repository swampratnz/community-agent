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

-- Real-time stale-knowledge admin nudge (issue #701): stamped the moment a
-- served, already-stale entry (isKnowledgeStale) is unalerted since its last
-- edit — stale_alerted_at IS NULL OR stale_alerted_at < updated_at. An admin
-- edit via update_knowledge/accept_knowledge_candidate bumps updated_at
-- (below) and so automatically re-arms the gate with no separate reset.
-- Deliberately excluded from the knowledge_set_updated_at trigger's column
-- list below, same exclusion as retrieval_count/source_url/source_unreachable
-- above: stamping this alone must never look like a content edit.
ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS stale_alerted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS knowledge_embedding_idx
  ON knowledge USING hnsw (embedding vector_cosine_ops);

-- Lexical fallback support (issue #362): searchKnowledgeLexical's
-- word_similarity() query against the same COALESCE(title,'') || ' ' ||
-- content expression this index is built on. title is nullable, so the
-- COALESCE must match on both sides or null-titled entries silently never
-- match.
CREATE INDEX IF NOT EXISTS knowledge_trgm_idx
  ON knowledge USING gin ((COALESCE(title, '') || ' ' || content) gin_trgm_ops);

-- Scoped to the content-bearing columns (not retrieval_count/last_retrieved_at)
-- so a knowledge_search hit's counter bump never touches updated_at — see the
-- comment on those columns above.
DROP TRIGGER IF EXISTS knowledge_set_updated_at ON knowledge;
CREATE TRIGGER knowledge_set_updated_at
  BEFORE UPDATE OF scope, title, content, source_user_id, created_by_role, embedding ON knowledge
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
