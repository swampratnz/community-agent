-- ---------------------------------------------------------------------------
-- Member-submitted reports of harassment/spam/rule violations, for admins to
-- triage. Purely informational intake — no automatic action is taken on a
-- report; an admin still decides and acts via the existing `moderate` tool.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS content_reports (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform         TEXT        NOT NULL,
  reporter_user_id TEXT        NOT NULL,
  reporter_name    TEXT,
  conversation_id  TEXT        NOT NULL,
  target_user_id   TEXT,
  message_id       TEXT,
  reason           TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'open', -- 'open' | 'resolved' | 'dismissed' | 'withdrawn' (by reporter)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_by      TEXT,
  resolved_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS content_reports_conversation_idx
  ON content_reports (conversation_id, created_at DESC);

-- Backs the per-reporter rolling-24h rate cap (see repository.ts createContentReport).
CREATE INDEX IF NOT EXISTS content_reports_reporter_rate_idx
  ON content_reports (platform, reporter_user_id, created_at DESC);

-- Was this report filed from a 1:1 DM (WhatsApp is always DM; Discord DM
-- channel)? Derived from the platform/channel type at creation time, never
-- from message content — see CallerContext.isDirect (issue #197). Existing
-- rows default to false (non-retroactive: pre-#197 DM reports stay
-- super-admin-only, matching their original visibility contract).
ALTER TABLE content_reports ADD COLUMN IF NOT EXISTS is_dm BOOLEAN NOT NULL DEFAULT false;

-- Backs list_reports's optional targetUserId filter (issue #463), mirroring
-- moderation_history's target filter (#83).
CREATE INDEX IF NOT EXISTS content_reports_target_idx
  ON content_reports (target_user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Durable record of a member's own appeal of their auto-moderation warning(s)
-- (issue #554) — appeal_moderation was, until now, fire-and-forget: it only
-- fired a best-effort notifySuperAdmins DM (notifyAppealFiled), so a missed
-- DM erased the appeal with no trace. Mirrors content_reports's shape
-- (member-submitted, admin-reviewed, non-destructive resolution). No
-- conversation_id — warnings/mutes are guild-wide state, same boundary as
-- member_warnings/clear_warnings/list_member_warnings, so this table isn't
-- conversation-scoped either. active_warnings/strike_limit are a snapshot at
-- filing time (not a live join to member_warnings), same convention as the
-- notifyAppealFiled DM they already accompany.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS moderation_appeals (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform         TEXT        NOT NULL,
  user_id          TEXT        NOT NULL,
  user_name        TEXT,
  reason           TEXT,
  active_warnings  INT         NOT NULL,
  strike_limit     INT         NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'open', -- 'open' | 'resolved' | 'dismissed'
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_by      TEXT,
  resolved_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS moderation_appeals_status_idx
  ON moderation_appeals (status, created_at DESC);

-- Backs forget_me/purge_user_data's per-identity delete.
CREATE INDEX IF NOT EXISTS moderation_appeals_user_idx
  ON moderation_appeals (platform, user_id);

-- ---------------------------------------------------------------------------
-- Auto-moderation strikes (Discord bad-language / abuse warnings). One row
-- per warning against a member, keyed on raw (platform, user_id) like
-- response_style_prefs — a warned user need not be in community_users. An
-- ACTIVE strike is one with cleared_at IS NULL; a member is "blocked" (muted
-- role assigned) once their active-strike count reaches the configured limit.
-- An admin clears warnings by stamping cleared_at/cleared_by on all of a
-- user's active rows (which also lifts the mute). `source` distinguishes an
-- automatic detection from an admin-issued warning; `excerpt` stores only a
-- short capped snippet of the offending message for admin context, never the
-- whole message (see SECURITY.md). Purge-coherent: forget_me/purge_user_data
-- delete a user's rows.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS member_warnings (
  id          BIGSERIAL   PRIMARY KEY,
  platform    TEXT        NOT NULL,
  user_id     TEXT        NOT NULL,
  reason      TEXT        NOT NULL,
  excerpt     TEXT,
  source      TEXT        NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'admin')),
  issued_by   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  cleared_at  TIMESTAMPTZ,
  cleared_by  TEXT
);

-- Fast active-strike count / "is this member blocked" lookups on the hot path
-- (every scanned message checks the warned user's active strike count).
CREATE INDEX IF NOT EXISTS member_warnings_active_idx
  ON member_warnings (platform, user_id)
  WHERE cleared_at IS NULL;

-- ---------------------------------------------------------------------------
-- Bot-side block list (issue #572), WhatsApp-only in practice today: the
-- Cloud API's only moderation lever is a toothless warn_user, and Baileys'
-- kick_user only removes someone from a *group*, never the bot's own DM
-- surface. A block is a pure bot-side ignore — no platform API call, unlike
-- every other moderation action — enforced by the router dropping a blocked
-- sender's message before role resolution or any storage, in both open and
-- gated access mode. One row per currently-blocked identity (not a history
-- log like member_warnings), so PRIMARY KEY doubles as the hot-path lookup
-- index. Deliberately NOT deleted by purgeUserData/forget_me (contrast
-- member_warnings above, which is): a blocked sender must not be able to
-- erase their own block by purging the linked identity that holds it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS blocked_users (
  platform     TEXT        NOT NULL,
  external_id  TEXT        NOT NULL,
  blocked_by   TEXT        NOT NULL,
  reason       TEXT,
  blocked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, external_id)
);
