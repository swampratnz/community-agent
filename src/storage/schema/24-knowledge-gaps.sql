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

-- Set once a real-time admin alert has been queued for the cluster this row
-- belongs to (issue #650) — stamped on every row of a cluster the moment it
-- crosses KNOWLEDGE_GAP_ALERT_THRESHOLD, so it can never contribute to a
-- future crossing again (single-shot per cluster, same never-notify-twice
-- precedent as the escalation/access-request real-time alerts). NULL
-- (including every pre-existing row) means not yet alerted.
ALTER TABLE knowledge_gaps ADD COLUMN IF NOT EXISTS alerted_at TIMESTAMPTZ;

-- Backs findCrossedKnowledgeGapCluster's `alerted_at IS NULL` filter, same
-- shape as knowledge_gaps_unresolved_idx above.
CREATE INDEX IF NOT EXISTS knowledge_gaps_unalerted_idx
  ON knowledge_gaps (conversation_id, created_at DESC) WHERE alerted_at IS NULL;
