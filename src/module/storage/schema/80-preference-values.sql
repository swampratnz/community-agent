-- ---------------------------------------------------------------------------
-- Module fragment: the NZ deployment's standing-preference VALUE allowlists.
--
-- agent-base ships `response_style_prefs` (17-prefs.sql) and `language_prefs`
-- (54-language-prefs.sql), but it generalised their CHECK constraints from a
-- value allowlist to a SHAPE check (`~ '^[a-z0-9]+(-[a-z0-9]+)*$'`, length
-- <= 32): which styles and which languages exist is a deployment's content,
-- and a framework schema cannot enumerate them. This community DOES know:
-- `set_response_style` offers 'standard'|'plain' and `set_language_preference`
-- offers 'auto'|'en'|'mi', both as closed model-facing enums, so the column
-- constraint is restored here to match — defence in depth behind those enums,
-- exactly as before the package flip.
--
-- Constraint NAMES are deliberately new (`*_allowed`), not the auto-generated
-- `response_style_prefs_style_check` / `language_prefs_language_check` that
-- Postgres gave the inline CHECKs: a module must never DROP or redefine a
-- constraint the base owns (CLAUDE.md, plan §3 `migrations`). On the
-- production database, whose columns still carry the pre-flip inline value
-- CHECKs, these are equivalent constraints added alongside them and nothing
-- observable changes; on a fresh database they are what narrows base's shape
-- check back down to this deployment's values.
--
-- ONE drop/re-add pair per constraint name, as everywhere else in the schema:
-- migrate() replays the whole concatenation as a single multi-statement query
-- on every deploy, and a second pair for the same name would validate live
-- rows against the narrower of the two (see 26-jobs-shortcuts.sql's note and
-- tests/schemaConstraintIdempotency.test.ts). When a value is added to either
-- tool enum, EDIT the list below.
-- ---------------------------------------------------------------------------
ALTER TABLE response_style_prefs DROP CONSTRAINT IF EXISTS response_style_prefs_style_allowed;
ALTER TABLE response_style_prefs ADD CONSTRAINT response_style_prefs_style_allowed
  CHECK (style IN ('standard', 'plain'));

ALTER TABLE language_prefs DROP CONSTRAINT IF EXISTS language_prefs_language_allowed;
ALTER TABLE language_prefs ADD CONSTRAINT language_prefs_language_allowed
  CHECK (language IN ('auto', 'en', 'mi'));
