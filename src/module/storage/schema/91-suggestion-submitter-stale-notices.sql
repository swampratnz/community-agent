-- ---------------------------------------------------------------------------
-- Module fragment: suggestion submitter mid-flight stale notice (issue
-- #1415) — the one-time "still being reviewed" DM to the member who FILED a
-- bot-improvement suggestion via `suggest_improvement`, complementing the
-- admin-side crossing-latch alert `suggestionStaleAlert.ts` already sends
-- once the guild-wide pending-suggestion count leaves zero (issue #1091).
--
-- Byte-shape-identical to `90-appeal-appellant-stale-notices.sql` (issue
-- #1413), the direct precedent this fragment copies: sits BESIDE the base
-- `suggestions` table, never mutating it. `suggestion_id PRIMARY KEY` plus
-- `INSERT ... ON CONFLICT DO NOTHING` in the accessor is the whole
-- idempotency mechanism: a suggestion is flagged here the first (and only)
-- time its submitter is notified, so a later tick never re-sends.
--
-- No FK to `suggestions` (the withdrawal tables' own no-FK stance). No
-- submitter identity or suggestion content column either: the row only ever
-- needs to answer "has suggestion N's submitter already been notified?", so
-- there is nothing here for `forget_me`/`purge_user_data` to erase, and this
-- table needs no `registerPurgeContributor` hook — same no-hook stance as
-- `90-appeal-appellant-stale-notices.sql`, for the same reason.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS suggestion_submitter_stale_notices (
  suggestion_id INTEGER PRIMARY KEY,
  notified_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
