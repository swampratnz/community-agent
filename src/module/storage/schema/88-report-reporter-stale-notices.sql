-- ---------------------------------------------------------------------------
-- Module fragment: reporter-side mid-flight stale notice (issue #1375) — the
-- one-time "still being reviewed" DM to the person who FILED a content
-- report, complementing the admin-side crossing-latch alert
-- `reportStaleAlert.ts` already sends once their own stale count leaves
-- zero (issue #1084).
--
-- Sits BESIDE the base `content_reports` table, never mutating it — same
-- "base owns the row, module tracks something beside it" pattern
-- `suggestion_withdrawals`/`appeal_withdrawals` established (issues
-- #1243/#1278). `report_id PRIMARY KEY` plus `INSERT ... ON CONFLICT DO
-- NOTHING` in the accessor is the whole idempotency mechanism: a report is
-- flagged here the first (and only) time its reporter is notified, so a
-- second tick — or a second admin sharing the same conversation, in the
-- same tick — never re-sends.
--
-- No FK to `content_reports` (the withdrawal tables' own no-FK stance). No
-- reporter identity or report content column either: the row only ever
-- needs to answer "has report N's reporter already been notified?", so
-- there is nothing here for `forget_me`/`purge_user_data` to erase, and
-- this table needs no `registerPurgeContributor` hook — the same no-hook
-- stance `82-suggestion-withdrawals.sql`/`83-appeal-withdrawals.sql` take,
-- for the same reason (unlike `84-find-helper-requests.sql`, which DOES
-- store requester identity and therefore DOES register one).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS report_reporter_stale_notices (
  report_id INTEGER PRIMARY KEY,
  notified_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
