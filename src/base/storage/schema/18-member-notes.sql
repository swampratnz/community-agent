-- ---------------------------------------------------------------------------
-- Admin-curated context notes about known community members (issue #45).
-- Person-scoped facts ("runs the Chch meetup") that do NOT belong in the
-- global knowledge FAQ. Human-entered only, admin-read only, deleted by the
-- member's forget_me/purge (see SECURITY.md).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS member_notes (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  platform      TEXT        NOT NULL,
  user_id       TEXT        NOT NULL,           -- the member the note is about
  note          TEXT        NOT NULL,
  created_by    TEXT        NOT NULL,           -- platform user id of the admin author
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS member_notes_user_idx
  ON member_notes (platform, user_id, created_at DESC);

DROP TRIGGER IF EXISTS member_notes_set_updated_at ON member_notes;
CREATE TRIGGER member_notes_set_updated_at
  BEFORE UPDATE ON member_notes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
