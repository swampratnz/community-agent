-- ---------------------------------------------------------------------------
-- Restart-safe freshness guard for the weekly proactive admin
-- recurring-questions digest (issue #97): one row per admin identity, so a
-- redeploy/restart mid-week can't re-send within the same freshness window.
-- Identity + timestamp only — no message content, no cluster text — and
-- deletable by forget_me/purge_user_data alongside other admin-identity-keyed
-- rows.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_digest_sends (
  platform         TEXT        NOT NULL,
  platform_user_id TEXT        NOT NULL,
  sent_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, platform_user_id)
);
-- Week-over-week trend snapshot (issue #497): the exact same bare integers
-- the digest already sends this admin, nothing more — see
-- `sanitizeDigestCounts`/`getLastDigestCounts`/`recordAdminDigestSnapshot` in
-- repository.ts. Deliberately NOT bumped by the snapshot-only write path, so
-- it stays decoupled from the `sent_at` freshness guard above.
ALTER TABLE admin_digest_sends ADD COLUMN IF NOT EXISTS last_counts JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- Restart-safe freshness guard + trend store for the weekly super-admin
-- cost-trend DM (issue #578), off unless USAGE_COST_DIGEST_ENABLED. A single
-- global row (`id` pinned to `true`, never more than one) — this signal is
-- one aggregate dollar figure every super admin sees identically (same shape
-- as `usageAlert.ts`'s own global `outbound`/`costUsd` read), unlike
-- `admin_digest_sends` above which is keyed per-admin for a per-admin-scoped
-- signal. `total_cost_usd` is the LAST WEEK's reported total
-- (`usageStats(7).costUsd + .backgroundCostUsd`), read back the following
-- week to compute the delta; `sent_at` is the freshness guard so a
-- redeploy/restart mid-week can't re-send within the same ~7-day window.
-- Bare aggregate figure + timestamp only — no user id, conversation id, or
-- message content — so forget_me/purge_user_data have nothing to touch here,
-- same as `background_job_costs`.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usage_cost_digest_state (
  id             BOOLEAN     PRIMARY KEY DEFAULT true CHECK (id),
  total_cost_usd NUMERIC     NOT NULL,
  sent_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Last week's prompt-cache hit rate (issue #608), persisted alongside
-- total_cost_usd above so the same weekly DM can also render a cache-hit-rate
-- trend line. Nullable: a quiet week (zero cache activity, or no row yet)
-- must not force a 0/NaN comparison next week — the write is skipped
-- entirely in that case, same "omit rather than corrupt" convention as
-- formatCacheUsageLine's own zero-activity check.
ALTER TABLE usage_cost_digest_state ADD COLUMN IF NOT EXISTS last_cache_hit_rate NUMERIC;

-- ---------------------------------------------------------------------------
-- Restart-safe freshness guard for the proactive engagement-percentage alert
-- (issue #568): a push companion to the pull-only, super-admin-only
-- `engagement_stats` tool (issue #419). Unlike `admin_digest_sends`, this is
-- deliberately SINGLE-ROW/guild-wide, not per-identity — `engagementStats()`
-- itself is a guild-wide, unscoped aggregate, not something computed per
-- recipient, so there is nothing to key per admin. The `id = 1` CHECK plus a
-- fixed-value upsert enforce the single row. `last_percentage` is forward-
-- compat only for a v2 week-over-week trend suffix (mirroring `admin_digest_
-- sends.last_counts`'s own growth path) — this PR writes it but MUST NOT read
-- or render it. No user/admin identifier column: forget_me/purge_user_data
-- have nothing to touch here, same as `background_job_costs`/`shortcut_hits`.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS engagement_alert_sends (
  id              SMALLINT    PRIMARY KEY DEFAULT 1,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_percentage NUMERIC,
  CONSTRAINT engagement_alert_sends_singleton CHECK (id = 1)
);

-- ---------------------------------------------------------------------------
-- Restart-safe freshness guard for the weekly member-facing digest post
-- (issue #645): a push companion, to a wider audience, of the same
-- `context_digests`/curated-`knowledge` data `list_context_digests`/
-- `list_knowledge_topics` already expose to admins. SINGLE-ROW/guild-wide
-- like `engagement_alert_sends` above — one post per week to one configured
-- channel, nothing to key per recipient. No user/admin identifier column:
-- forget_me/purge_user_data have nothing to touch here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS member_digest_sends (
  id      SMALLINT    PRIMARY KEY DEFAULT 1,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT member_digest_sends_singleton CHECK (id = 1)
);

-- ---------------------------------------------------------------------------
-- Restart-safe freshness guard for the proactive weekly admin-leverage alert
-- (issue #785): a push companion to the pull-only, super-admin-only
-- `admin_activity` tool (issue #488), moving VISION's "Admin leverage"
-- north star ("moderation/curation actions per admin") from pull to push,
-- mirroring the identical #472/#568 pull-to-push moves already made for
-- `departed_admin_alert`/`engagement_alert_sends`. Deliberately SINGLE-ROW/
-- guild-wide, not per-identity — the actions-per-admin rate is a guild-wide,
-- unscoped aggregate, not something computed per recipient, so there is
-- nothing to key per admin. The `id = 1` CHECK plus a fixed-value upsert
-- enforce the single row. `last_rate` is the read-back trend baseline
-- `formatAdminLeverageAlertMessage`'s week-over-week suffix compares
-- against, mirroring `engagement_alert_sends.last_percentage`'s shape. No
-- user/admin identifier column: forget_me/purge_user_data have nothing to
-- touch here, same as `engagement_alert_sends`/`member_digest_sends`.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_leverage_alert_sends (
  id        SMALLINT    PRIMARY KEY DEFAULT 1,
  sent_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_rate NUMERIC,
  CONSTRAINT admin_leverage_alert_sends_singleton CHECK (id = 1)
);
