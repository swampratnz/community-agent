-- ---------------------------------------------------------------------------
-- Module fragment: appeal appellant mid-flight stale notice (issue #1413) —
-- the one-time "still being reviewed" DM to the member who FILED a
-- moderation appeal via `appeal_moderation`, complementing the admin-side
-- crossing-latch alert `appealStaleAlert.ts` already sends once the
-- guild-wide open-appeal count leaves zero (issue #1020).
--
-- Byte-shape-identical to `89-knowledge-candidate-stale-notices.sql` (issue
-- #1408), the direct precedent this fragment copies: sits BESIDE the base
-- `moderation_appeals` table, never mutating it. `appeal_id PRIMARY KEY`
-- plus `INSERT ... ON CONFLICT DO NOTHING` in the accessor is the whole
-- idempotency mechanism: an appeal is flagged here the first (and only)
-- time its appellant is notified, so a later tick never re-sends.
--
-- No FK to `moderation_appeals` (the withdrawal tables' own no-FK stance).
-- No appellant identity or appeal content column either: the row only ever
-- needs to answer "has appeal N's appellant already been notified?", so
-- there is nothing here for `forget_me`/`purge_user_data` to erase, and
-- this table needs no `registerPurgeContributor` hook — same no-hook stance
-- as `89-knowledge-candidate-stale-notices.sql`, for the same reason.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS appeal_appellant_stale_notices (
  appeal_id INTEGER PRIMARY KEY,
  notified_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
