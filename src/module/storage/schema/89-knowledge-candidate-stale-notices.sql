-- ---------------------------------------------------------------------------
-- Module fragment: knowledge-candidate submitter mid-flight stale notice
-- (issue #1408) — the one-time "still being reviewed" DM to the member who
-- FILED a knowledge tip via `suggest_knowledge`, complementing the
-- admin-side crossing-latch alert `knowledgeCandidateStaleAlert.ts` already
-- sends once the guild-wide pending count leaves zero (issue #1073).
--
-- Byte-shape-identical to `88-report-reporter-stale-notices.sql` (issue
-- #1375), the direct precedent this fragment copies: sits BESIDE the base
-- `knowledge_candidates` table, never mutating it. `candidate_id PRIMARY KEY`
-- plus `INSERT ... ON CONFLICT DO NOTHING` in the accessor is the whole
-- idempotency mechanism: a candidate is flagged here the first (and only)
-- time its submitter is notified, so a later tick never re-sends.
--
-- No FK to `knowledge_candidates` (the withdrawal tables' own no-FK stance).
-- No submitter identity or candidate content column either: the row only
-- ever needs to answer "has candidate N's submitter already been notified?",
-- so there is nothing here for `forget_me`/`purge_user_data` to erase, and
-- this table needs no `registerPurgeContributor` hook — same no-hook stance
-- as `88-report-reporter-stale-notices.sql`, for the same reason.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_candidate_stale_notices (
  candidate_id INTEGER PRIMARY KEY,
  notified_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
