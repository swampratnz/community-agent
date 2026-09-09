-- ---------------------------------------------------------------------------
-- Module fragment: project-note preview capture (issue #1366) — the
-- `my_project_notes` self-service listing that #1344 explicitly deferred.
--
-- There is no author-scoped content-listing export over the base
-- `project_notes` table (`searchProjectNotes` is relevance-ranked semantic
-- search, not a complete listing, and this module never queries a base
-- table's columns directly). So a truncated preview is captured here
-- instead, at write time, from the same `caller.platform`/`caller.userId`
-- and `args.content` `project_note`'s handler already has in scope —
-- keyed on the note id `saveProjectNote` returns on success, the same shape
-- `project_note_authors` (schema/85-project-note-records.sql) already
-- established for authorship.
--
-- A SEPARATE sibling table, not new columns on the already-shipped
-- `project_note_authors` — additive-only, #1344's schema untouched. No FK to
-- `project_notes`, matching every auxiliary table in this module. Stores no
-- identity of its own: `my_project_notes`' listing and the purge contributor
-- below both scope it by joining through `project_note_authors`.
--
-- `project_note` has no edit path (correction is withdraw-and-refile, #1344's
-- own accepted alternative), so a preview captured once at write time can
-- never drift from the base row's immutable content.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_note_previews (
  note_id      INTEGER PRIMARY KEY,
  project_slug TEXT        NOT NULL,
  preview      TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
