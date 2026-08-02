-- ---------------------------------------------------------------------------
-- Server roster: who is (or was) in the platform community space, kept from
-- join/leave events plus a startup backfill. Identity metadata ONLY (id,
-- display name, join/leave timestamps) — data every server member already
-- sees in the member list. NEVER message content (see SECURITY.md). Durable
-- like community_users, not age-purged like interactions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS server_roster (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform       TEXT        NOT NULL,
  user_id        TEXT        NOT NULL,
  display_name   TEXT,
  joined_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at        TIMESTAMPTZ,                        -- null = currently present
  rejoined_count INT         NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, user_id)
);

CREATE INDEX IF NOT EXISTS server_roster_joined_idx
  ON server_roster (platform, joined_at DESC);

DROP TRIGGER IF EXISTS server_roster_set_updated_at ON server_roster;
CREATE TRIGGER server_roster_set_updated_at
  BEFORE UPDATE ON server_roster
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
