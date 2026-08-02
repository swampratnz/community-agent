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
-- Member-contributed provenance on knowledge_candidates (issue #633): a
-- direct member write path (suggest_knowledge tool) sharing this table and
-- the same admin accept/decline review flow the offline context builder's
-- machine-drafted rows already use. Both nullable and NULL together for
-- every pre-existing row and any future builder-drafted row; non-NULL
-- together identifies a member-sourced row (whose `digest_id` is always
-- NULL — there is no context_digests row underneath a member's own tip).
-- forget_me/purge_user_data delete a member-sourced row in EVERY status
-- (pending AND accepted/declined), matched on these two columns — see
-- purgeSingleIdentity below. That is deliberately fuller than the digest-
-- invalidation path above (which only removes a still-*pending* machine
-- row and leaves an already-reviewed accepted one's accountability trail
-- intact): a member's own attributed submission is their data to erase
-- regardless of review status.
-- ---------------------------------------------------------------------------
ALTER TABLE knowledge_candidates ADD COLUMN IF NOT EXISTS source_platform TEXT;
ALTER TABLE knowledge_candidates ADD COLUMN IF NOT EXISTS source_user_id TEXT;

-- Backs suggest_knowledge's per-member rolling-24h rate cap and the
-- forget_me/purge_user_data delete above — same shape as
-- suggestions_user_rate_idx.
CREATE INDEX IF NOT EXISTS knowledge_candidates_source_rate_idx
  ON knowledge_candidates (source_platform, source_user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Links an accepted candidate to the durable `knowledge` entry it became
-- (issue #880), so a contributor's `my_submissions` view can surface that
-- entry's `retrieval_count` back to them — closing the loop `suggest_knowledge`
-- (#633) and the status-only `my_submissions` view (#830) left open at
-- "accepted". Set exactly once, by `acceptKnowledgeCandidate`, from the
-- `knowledge.id` that same call's `saveKnowledge` produced — never accepted as
-- caller input. Nullable and unset for every pre-existing row and every
-- pending/declined candidate; mirrors the existing `digest_id BIGINT
-- REFERENCES context_digests(id) ON DELETE SET NULL` FK shape so a later
-- `knowledge` deletion (e.g. `delete_knowledge`) drops the link rather than
-- the candidate row.
-- ---------------------------------------------------------------------------
ALTER TABLE knowledge_candidates ADD COLUMN IF NOT EXISTS knowledge_id BIGINT REFERENCES knowledge(id) ON DELETE SET NULL;

-- Widens the status CHECK to add 'withdrawn' (issue #895): lets a member
-- retract their OWN still-pending suggest_knowledge tip via
-- withdraw_knowledge_tip, the same self-service lever content_reports'
-- 'withdrawn' status already gives report filers. Non-destructive (the row
-- is kept, never deleted) and distinct from an admin-initiated 'declined',
-- same rationale as content_reports' own 'withdrawn' vs. 'dismissed' split.
-- Same single-pair DROP CONSTRAINT IF EXISTS / re-add convention as
-- shortcut_hits.kind above, safe to re-run against a table already holding
-- rows in any listed status. As there: to add a status, EDIT the list below
-- rather than appending a second pair for this constraint name — a narrower
-- earlier pair would abort the whole replayed migration once a row uses a
-- status only the later pair allows.
ALTER TABLE knowledge_candidates DROP CONSTRAINT IF EXISTS knowledge_candidates_status_check;
ALTER TABLE knowledge_candidates ADD CONSTRAINT knowledge_candidates_status_check
  CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn'));
