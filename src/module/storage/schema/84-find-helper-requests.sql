-- ---------------------------------------------------------------------------
-- Module fragment: find_helper's own-request receipt (issue #1313) —
-- find_helper (social.ts) is the one rate-capped member-write with no
-- self-service history; every sibling (suggestions, reports/appeals,
-- knowledge tips, request_project_connection #908) already has one via
-- my_submissions. The base `helper_notifications` table backs
-- recordHelperNotificationIfUnderCap/isFindHelperRequesterAtDailyCap but
-- exposes no per-call, per-requester log with the topic text — this table
-- sits BESIDE it, the same "base owns the row, module tracks something
-- alongside it" pattern access_request_resolutions/suggestion_withdrawals/
-- appeal_withdrawals established.
--
-- Unlike those three siblings, this table stores direct requester PII
-- (requester_platform, requester_user_id, topic) — see findHelperRequests.ts's
-- registerPurgeContributor call, which follows the (platform, user_id)-keyed
-- knowledge_gaps pattern rather than those tables' no-hook stance (safe there
-- only because they store no requester identity).
--
-- No FK to helper_notifications or any base table (this module's established
-- no-FK stance for auxiliary tables).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS find_helper_requests (
  id                 SERIAL PRIMARY KEY,
  requester_platform TEXT        NOT NULL,
  requester_user_id  TEXT        NOT NULL,
  topic              TEXT        NOT NULL,
  matched            BOOLEAN     NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS find_helper_requests_requester_idx
  ON find_helper_requests (requester_platform, requester_user_id, created_at DESC);
