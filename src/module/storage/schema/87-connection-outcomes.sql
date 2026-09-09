-- ---------------------------------------------------------------------------
-- Module fragment: connection-outcome tracking for find_helper/
-- request_project_connection (issue #1354) — both member->member handoffs
-- are already counted (helper_notifications/project_connection_requests,
-- surfaced via helperMatchesCount/projectConnectionsCount in adminDigest.ts)
-- and receipted to the requester (find_helper_requests.ts/
-- project_connection_requests, via my_submissions), but neither has ever
-- asked "did that actually help?" — this table is that missing OUTCOME
-- signal, one row per real handoff.
--
-- A module-owned auxiliary table beside social.ts's tool handlers, the same
-- "base/module owns the row, this module tracks something alongside it"
-- pattern find_helper_requests/project_note_authors already established —
-- no FK to helper_notifications/project_connection_requests, this module's
-- established no-FK stance for auxiliary tables.
--
-- Stores direct requester PII (requester_platform, requester_user_id), so
-- connectionOutcomes.ts registers a purge contributor, the same
-- (platform, user_id)-keyed pattern find_helper_requests.ts uses.
--
-- followup_sent_at/outcome/responded_at start NULL at insert (issue #1354
-- acceptance criterion 1) and are only ever written by the daily follow-up
-- job (followup_sent_at) and rate_connection_outcome (outcome/responded_at),
-- never at insert time.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connection_outcomes (
  id                 SERIAL PRIMARY KEY,
  requester_platform TEXT        NOT NULL,
  requester_user_id  TEXT        NOT NULL,
  kind               TEXT        NOT NULL CHECK (kind IN ('find_helper', 'project_connection')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  followup_sent_at   TIMESTAMPTZ,
  outcome            TEXT CHECK (outcome IS NULL OR outcome IN ('helpful', 'not_helpful')),
  responded_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS connection_outcomes_requester_idx
  ON connection_outcomes (requester_platform, requester_user_id, created_at DESC);

-- The daily follow-up job's own scan predicate — followup_sent_at IS NULL
-- rows older than the fixed window.
CREATE INDEX IF NOT EXISTS connection_outcomes_followup_due_idx
  ON connection_outcomes (created_at)
  WHERE followup_sent_at IS NULL;
