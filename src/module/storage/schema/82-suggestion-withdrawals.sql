-- ---------------------------------------------------------------------------
-- Module fragment: member-side suggestion withdrawal (issue #1243), the
-- follow-up #895 explicitly deferred ("Also add `withdraw_suggestion` for
-- `suggest_improvement` in this same PR. Rejected for scope... Named as a
-- natural, separately-filed follow-up below.").
--
-- `withdrawOwnReports`/`withdrawOwnKnowledgeTips` are base-owned functions
-- that flip a base table's own `status` column directly — unavailable here,
-- since the base `suggestions.status` CHECK constraint has no `'withdrawn'`
-- value and widening it is an agent-base change. This table sits BESIDE the
-- base `suggestions` table instead, the same "base owns the row, module
-- tracks something alongside it" pattern `access_request_resolutions`
-- established for issue #1239: a suggestion's withdrawal is recorded here,
-- consulted by `resolve_suggestion`/`list_suggestions`/`my_submissions`,
-- and never mutates the base row.
--
-- No FK to the base `suggestions` table — this module never takes a hard
-- dependency on a base table's shape (`accessRequestResolutions.ts`'s own
-- no-FK stance). No platform/user id/display name column either: a
-- suggestion's own row already carries that, so this table only ever needs
-- to answer "has id N been withdrawn?".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS suggestion_withdrawals (
  suggestion_id INTEGER PRIMARY KEY,
  withdrawn_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
