-- ---------------------------------------------------------------------------
-- Community membership + tiers. super_admin is env-bootstrapped and never
-- stored here; this table holds 'admin' and 'member' grants.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_users (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform      TEXT        NOT NULL,
  platform_user_id TEXT     NOT NULL,
  display_name  TEXT,
  role          TEXT        NOT NULL DEFAULT 'member',  -- 'admin' | 'member'
  added_by      TEXT,                                   -- platform user id of granter
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, platform_user_id)
);

DROP TRIGGER IF EXISTS community_users_set_updated_at ON community_users;
CREATE TRIGGER community_users_set_updated_at
  BEFORE UPDATE ON community_users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Cross-platform identity linking: a `persons` row groups the
-- community_users rows that are the same human (e.g. one member's Discord
-- account and WhatsApp number) so forget_me/purge, the daily reply budget,
-- and admin views can follow the person, not the platform row. Created only
-- via the admin-tier `link_member` tool (see repository.ts) — never inferred
-- from message content, and never touches `role` (tier stays per-platform-row
-- by design; see docs/SECURITY.md).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS persons (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE community_users ADD COLUMN IF NOT EXISTS person_id BIGINT REFERENCES persons(id);

CREATE INDEX IF NOT EXISTS community_users_person_idx ON community_users (person_id);
