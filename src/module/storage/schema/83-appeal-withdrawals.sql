-- ---------------------------------------------------------------------------
-- Module fragment: member-side appeal withdrawal (issue #1278), the fourth
-- sibling in the report/tip/suggestion/appeal self-service-retraction set
-- issue #1243 built the module-owned-auxiliary-table pattern for.
--
-- `withdrawOwnReports`/`withdrawOwnKnowledgeTips` are base-owned functions
-- that flip a base table's own `status` column directly — unavailable here,
-- since the base `moderation_appeals.status` CHECK constraint
-- (`resolve_appeal`'s `z.enum(['resolved', 'dismissed'])`) has no
-- `'withdrawn'` value and widening it is an agent-base change. This table
-- sits BESIDE the base `moderation_appeals` table instead, byte-for-byte the
-- same shape as `suggestion_withdrawals` (issue #1243): an appeal's
-- withdrawal is recorded here, consulted by
-- `resolve_appeal`/`list_appeals`/`my_submissions`, and never mutates the
-- base row.
--
-- No FK to the base `moderation_appeals` table (`suggestion_withdrawals`'s/
-- `access_request_resolutions`'s own no-FK stance). No platform/user id/
-- display name column either: an appeal's own row already carries that, so
-- this table only ever needs to answer "has id N been withdrawn?".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS appeal_withdrawals (
  appeal_id INTEGER PRIMARY KEY,
  withdrawn_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
