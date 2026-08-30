-- ---------------------------------------------------------------------------
-- Module fragment: anonymous access-request resolution-speed log (issue
-- #1239), the fifth and last of the admin review queues (reports #1081,
-- appeals #1130, candidates #1149, suggestions #1152) to get an outcome-mix +
-- median-resolution-time signal.
--
-- `access_requests` (base) deletes its row on resolution by design
-- (docs/SECURITY.md's residual-risks section) — the single most sensitive
-- non-member record this bot keeps, since on WhatsApp the user id IS the
-- phone number. This table exists so the resolution-speed signal can survive
-- that deletion WITHOUT reversing it: it records only a duration and an
-- outcome, at the moment of resolution, never an identity. Deliberately no
-- platform, user id, or display name column — it cannot be linked back to a
-- specific requester, so it needs no `registerPurgeContributor` hook and
-- `forget_me`/`purge_user_data` have nothing here to reach.
--
-- Written at the two existing resolution call sites (`add_member` in
-- membership.ts, `decline_access_request` in accessAndSuggestions.ts) right
-- before each calls `clearAccessRequest` — the row is gone after that, so the
-- lookup of `firstRequestedAt` must happen first. The write is best-effort
-- (wrapped the same way `clearAccessRequest` itself already is in
-- `add_member`): it must never be able to fail or block the actual
-- resolution.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS access_request_resolutions (
  id BIGSERIAL PRIMARY KEY,
  requested_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  outcome TEXT NOT NULL CHECK (outcome IN ('approved', 'declined'))
);
CREATE INDEX IF NOT EXISTS access_request_resolutions_resolved_at_idx
  ON access_request_resolutions (resolved_at);
