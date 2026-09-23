-- ---------------------------------------------------------------------------
-- Module fragment: access-request guest mid-flight stale notice (issue
-- #1421) — the one-time "still being reviewed" DM to the GUEST who filed a
-- gated-access request, completing the guest-facing half of #1100's
-- admin-only crossing-latch alert (`accessRequestStaleAlert.ts`), the same
-- treatment `88`-`91` already gave content reports, knowledge candidates,
-- moderation appeals and member suggestions.
--
-- UNLIKE those four siblings, this table DOES carry requester identity
-- (platform, platform_user_id): the base `AccessRequest` type has no
-- anonymous numeric id to key idempotency on instead — it is addressed
-- everywhere in this module as a (platform, userId) pair
-- (`clearAccessRequest(platform, userId)`). So this fragment follows
-- `84-find-helper-requests.sql`'s registered-purge-hook precedent, not
-- `88`-`91`'s no-hook stance (safe there only because those tables store no
-- requester identity at all) — see accessRequestStaleNotices.ts's
-- `registerPurgeContributor` call, which handles the immediate
-- forget_me/purge_user_data path, and its `pruneAccessRequestStaleNotices`,
-- which reconciles the ordinary approve/decline/retention paths every tick
-- against the full pending-access-request scan.
--
-- No FK to the base `access_requests` table (this module's established
-- no-FK stance for auxiliary tables).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS access_request_stale_notices (
  platform          TEXT        NOT NULL,
  platform_user_id  TEXT        NOT NULL,
  notified_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, platform_user_id)
);
