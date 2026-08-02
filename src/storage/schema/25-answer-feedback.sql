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

-- One-time de-dup of legacy duplicate rows before the unique index below,
-- issue #619: this schema is applied idempotently against the live
-- production DB on every deploy (see migrate.ts), and the very bug this
-- migration fixes — a single rater double-tapping rate_answer — is exactly
-- what could have already left duplicate (interaction_id, user_id) rows
-- there. Keep the most recent row (highest id) per pair, drop the rest, so
-- the unique index below can always be created. Idempotent: once no
-- duplicates remain, this deletes zero rows on every subsequent run.
DELETE FROM answer_feedback a USING answer_feedback b
 WHERE a.interaction_id IS NOT NULL
   AND a.interaction_id = b.interaction_id
   AND a.user_id = b.user_id
   AND a.id < b.id;

-- One vote per (interaction, rater), issue #619: without this, a single
-- member calling rate_answer twice on the same bot reply inserted two rows,
-- inflating every downstream count (usage_stats' helpful ratio, the weekly
-- digest, and — most seriously — bypassing the >= 2 "more than one
-- identifiable person" floor on the low-rated caveat, config.ts's
-- MIN_KNOWLEDGE_LOW_RATED_CAVEAT_MIN_UNHELPFUL). Partial (WHERE interaction_id
-- IS NOT NULL) because forget_me/purge_user_data's ON DELETE SET NULL above
-- leaves multiple NULL-interaction_id rows for the same or different raters,
-- which must keep coexisting. createAnswerFeedback's ON CONFLICT clause must
-- repeat this exact predicate for Postgres to infer the partial index.
CREATE UNIQUE INDEX IF NOT EXISTS answer_feedback_interaction_rater_idx
  ON answer_feedback (interaction_id, user_id) WHERE interaction_id IS NOT NULL;

-- Optional free-text reason alongside the boolean (issue #354, the follow-up
-- #118 explicitly deferred). Nullable, no backfill: a rating with no
-- accompanying reason stores NULL exactly as before. Deleted along with the
-- rest of the row by the rater's own forget_me/purge_user_data purge — no new
-- retention or deletion path.
ALTER TABLE answer_feedback ADD COLUMN IF NOT EXISTS comment TEXT;
