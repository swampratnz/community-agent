-- ---------------------------------------------------------------------------
-- Module fragment: anonymous request_human_help frequency/recency log (issue
-- #1364, the buildable-again version of #1060). `request_human_help`
-- (feedback.ts) today either declines (daily cap) with nothing persisted, or
-- sets a turn-scoped flag the router reads exactly once, post-turn, to
-- direct-fire a single live `notifyAdmins` DM — then discards it. If that one
-- DM is missed (admin asleep/muted, WhatsApp's 24h window shut, or
-- ESCALATION_TO_ADMIN_ENABLED off) the ask leaves zero trace anywhere.
--
-- Deliberately even more minimal than `access_request_resolutions` (fragment
-- 81, which stores no identity but does store an outcome): no platform,
-- conversation, user, or outcome column at all — just "one ask happened, at
-- this time." Nothing here for `forget_me`/`purge_user_data` to reach, so
-- this table needs no `registerPurgeContributor` hook.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS human_help_request_log (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS human_help_request_log_created_at_idx
  ON human_help_request_log (created_at);
