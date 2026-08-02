import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SCHEMA_FRAGMENTS, loadSchemaSql } from '../src/storage/schema/manifest.js';

/**
 * `migrate()` replays the ENTIRE schema — the `src/storage/schema/` fragments
 * concatenated in manifest order — as a SINGLE multi-statement query on every
 * run (`pool.query(sql)` — there is no `schema_migrations` ledger, so nothing
 * is ever skipped). Two consequences make the concatenation's shape a
 * correctness concern rather than a style one:
 *
 *  1. Statements execute in concatenation order against LIVE data, and
 *     `ALTER TABLE ... ADD CONSTRAINT` validates every existing row.
 *  2. It is one query, so any failure rolls back the WHOLE migration — no
 *     schema change lands at all.
 *
 * So if a constraint name gets a second DROP/ADD pair appended to widen an
 * enum, the earlier, NARROWER pair still runs first on every future migration.
 * One row holding a value only the later pair allows makes that earlier
 * statement abort, and the whole migration fails from then on.
 *
 * That happened: `shortcut_hits_kind_check` had stacked pairs (a 5-kind one
 * followed by a 6-kind one adding 'whatsapp_text_command'), so a single
 * WhatsApp `!`-command hit — which issue #874 records in production — was
 * enough to block every subsequent migration permanently.
 *
 * CI cannot catch that: it provisions an empty pgvector container per run, so
 * `npm run migrate` there only ever exercises the fresh-database path, where
 * stacked pairs are harmless. This test guards the invariant statically
 * instead — and, now that the schema is split, it reads the fragments through
 * the SAME manifest concatenation `migrate()` applies, so the invariants hold
 * ACROSS fragments: a pair stacked in a different fragment file is exactly as
 * fatal as one stacked ten lines below the original.
 *
 * Deliberately static (parses the SQL) rather than migrating a live DB twice
 * with data present, which would reproduce it more directly but is the wrong
 * trade here: it would need DDL locks and `shortcut_hits` rows in a suite whose
 * FILES run in parallel, and `tests/repository.test.ts` asserts on a *global*
 * `shortcutHits.total` delta — so a live version of this test would redden an
 * unrelated file. Guarding the cause costs nothing and cannot flake.
 * (The DB-backed replay proof lives in tests/schemaFragmentEquivalence.test.ts.)
 */
const schema = await loadSchemaSql();

test('schema fragments: no constraint name is ever re-added more than once across the concatenation (migrate() replays it all, so a stacked narrower pair breaks every future migration)', () => {
  // Matches `ADD CONSTRAINT <name>` across newlines/extra whitespace, which is
  // how these are actually written (name on the ALTER line, CHECK indented on
  // the next).
  const addedNames = [...schema.matchAll(/ADD\s+CONSTRAINT\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);

  const seen = new Map<string, number>();
  for (const name of addedNames) seen.set(name, (seen.get(name) ?? 0) + 1);
  const duplicated = [...seen.entries()].filter(([, count]) => count > 1);

  assert.deepEqual(
    duplicated,
    [],
    `the schema fragments re-add these constraint names more than once: ${duplicated
      .map(([name, count]) => `${name} (${count}x)`)
      .join(', ')}. Widen the EXISTING pair's list in place instead of appending ` +
      'a new DROP/ADD pair (in any fragment) — the earlier, narrower one still runs on every ' +
      'replay and will abort the whole migration once a row uses a value only ' +
      'the later pair allows.',
  );
});

test('schema fragments: every constraint re-add is preceded by its own DROP CONSTRAINT IF EXISTS (so a replay cannot fail on "already exists")', () => {
  const names = [...schema.matchAll(/ADD\s+CONSTRAINT\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
  const dropped = new Set(
    [...schema.matchAll(/DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]),
  );

  const missingDrop = names.filter((n) => !dropped.has(n));
  assert.deepEqual(
    missingDrop,
    [],
    `these constraints are added without a preceding DROP CONSTRAINT IF EXISTS: ${missingDrop.join(', ')}. ` +
      'Unlike CREATE TABLE/INDEX, ADD CONSTRAINT has no IF NOT EXISTS form, so a bare ' +
      'ADD fails on the second migrate() run.',
  );
});

test('schema fragments: shortcut_hits_kind_check permits every ShortcutKind, in one pair (regression: issue #874 row blocked all migrations)', () => {
  // Matched to the statement terminator rather than to a closing paren: a
  // `CHECK (kind IN (...))` has NESTED parens, so a `\([^)]*\)` pattern stops at
  // the inner `IN (` list's paren and silently examines only part of the clause.
  // That happened to cover every literal here, but it would quietly stop doing
  // so if the clause shape ever changed (PR #900 review).
  const pairs = [...schema.matchAll(/ADD\s+CONSTRAINT\s+shortcut_hits_kind_check[\s\S]*?;/g)];
  assert.equal(pairs.length, 1, 'exactly one shortcut_hits_kind_check re-add is expected');
  assert.match(pairs[0][0], /\)\s*\)\s*;$/, 'the whole CHECK (... IN (...)) clause should be captured');

  // Derived from the `ShortcutKind` union rather than hardcoded here, so adding
  // a 7th kind to the type without widening the constraint fails THIS test
  // instead of failing at runtime on the first real insert.
  const kindSource = readFileSync(
    new URL('../src/storage/repository/shortcutHits.ts', import.meta.url),
    'utf8',
  );
  const union = /export type ShortcutKind =([\s\S]*?);/.exec(kindSource);
  assert.ok(union, 'could not locate the ShortcutKind union — update this test if it moved');
  const kinds = [...union[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(kinds.length >= 6, `expected to parse the ShortcutKind members, got ${kinds.length}`);

  for (const kind of kinds) {
    assert.match(pairs[0][0], new RegExp(`'${kind}'`), `shortcut_hits_kind_check must permit '${kind}'`);
  }
});

test('schema manifest: every .sql file in src/storage/schema/ is listed exactly once, and every listed fragment exists on disk', () => {
  // The silent-drop hazard: `loadSchemaSql()` reads ONLY what the manifest
  // lists (an explicit array, not a glob, because concatenation order is
  // load-bearing). A fragment committed to the directory but never added to
  // the manifest would simply not be part of the migration — no error, no
  // missing-file crash, just tables that never get created. This makes that
  // state fail CI instead.
  const schemaDir = fileURLToPath(new URL('../src/storage/schema/', import.meta.url));
  const onDisk = readdirSync(schemaDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const listed = [...SCHEMA_FRAGMENTS];

  const counts = new Map<string, number>();
  for (const name of listed) counts.set(name, (counts.get(name) ?? 0) + 1);
  const duplicated = [...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name);
  assert.deepEqual(duplicated, [], `manifest lists these fragments more than once: ${duplicated.join(', ')}`);

  assert.deepEqual(
    [...listed].sort(),
    onDisk,
    'src/storage/schema/ and SCHEMA_FRAGMENTS in manifest.ts must list exactly the same .sql files — ' +
      'a fragment on disk but missing from the manifest is silently excluded from every migration, ' +
      'and a manifest entry with no file crashes migrate() at startup.',
  );
});
