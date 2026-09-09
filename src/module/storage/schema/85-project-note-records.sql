-- ---------------------------------------------------------------------------
-- Module fragment: project-note authorship + withdrawal (issue #1344) — the
-- one member-authored content type with no correction path (project_note
-- has no edit/delete/withdraw anywhere, and project_info deliberately never
-- shows note content to admins either, so there is no admin override).
--
-- The base `project_notes` INSERT already stores author_platform/
-- author_user_id on the row itself, but exposes no per-note author read —
-- `ProjectNoteHit` (searchProjectNotes' return shape) carries no author
-- field, and this module never queries a base table's columns directly. So
-- authorship is tracked here instead, captured from the SAME
-- caller.platform/caller.userId `project_note`'s handler already has at
-- write time, keyed on the note id `saveProjectNote` returns on success.
--
-- Two tables, the same "base owns the row, module tracks something beside
-- it" pattern `suggestion_withdrawals`/`appeal_withdrawals`/
-- `find_helper_requests` already established — no FK to `project_notes`,
-- consistent with every sibling auxiliary table in this module:
--
--   project_note_authors     — one row per note, written best-effort right
--                               after a successful project_note save. Stores
--                               direct identity, so findProjectNoteRecords.ts
--                               registers a purge contributor for it, the
--                               same (platform, user_id)-keyed pattern
--                               find_helper_requests.ts uses.
--   project_note_withdrawals — byte-identical shape to suggestion_
--                               withdrawals/appeal_withdrawals: an id and a
--                               timestamp, nothing else, so it needs no
--                               purge contributor either.
--
-- A note written before this shipped has no project_note_authors row and is
-- therefore never withdrawable — withdraw_project_note's ownership check
-- naturally refuses it with the same wording as an unknown id, which is
-- expected and correct (no backfill, no guessed authorship).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_note_authors (
  note_id         INTEGER PRIMARY KEY,
  author_platform TEXT        NOT NULL,
  author_user_id  TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_note_authors_author_idx
  ON project_note_authors (author_platform, author_user_id);

CREATE TABLE IF NOT EXISTS project_note_withdrawals (
  note_id      INTEGER PRIMARY KEY,
  withdrawn_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
