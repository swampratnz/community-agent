import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { SCHEMA_FRAGMENTS, loadSchemaSql } from '@swampratnz/agent-base/storage/schema/manifest.js';
import { COMMUNITY_MIGRATIONS, COMMUNITY_SCHEMA_FRAGMENTS } from '../src/module/storage/schema/manifest.js';

/**
 * `migrate()` replays the ENTIRE schema — agent-base's fragments plus this
 * module's, concatenated base-first — as a SINGLE multi-statement query on
 * every run (`pool.query(sql)` — there is no `schema_migrations` ledger, so
 * nothing is ever skipped). Two consequences make the concatenation's shape a
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
 * The package flip makes this test MORE load-bearing here, not less. The base
 * fragments are agent-base's now (and it runs its own copy of this check over
 * them), but the concatenation this deployment actually applies is base's
 * fragments PLUS `src/module/storage/schema/` — and a module fragment is
 * exactly where a stacked or base-shadowing pair would be introduced. So the
 * subject here is the JOINED text, assembled the same way `migrate()` and
 * `createAgent().start()` assemble it.
 *
 * CI cannot catch that dynamically: it provisions an empty pgvector container
 * per run, so `npm run migrate` there only ever exercises the fresh-database
 * path, where stacked pairs are harmless. This test guards the invariant
 * statically instead — deliberately parsing the SQL rather than migrating a
 * live DB twice with data present, which would need DDL locks in a suite whose
 * FILES run in parallel.
 */
const schema = [
  await loadSchemaSql(),
  ...COMMUNITY_MIGRATIONS.map((f) => `-- fragment: ${f.name}\n${f.sql}`),
].join('\n');

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
  const pairs = [...schema.matchAll(/ADD\s+CONSTRAINT\s+shortcut_hits_kind_check[\s\S]*?;/g)];
  assert.equal(pairs.length, 1, 'exactly one shortcut_hits_kind_check re-add is expected');
  assert.match(pairs[0][0], /\)\s*\)\s*;$/, 'the whole CHECK (... IN (...)) clause should be captured');

  // Derived from the `ShortcutKind` union rather than hardcoded here, so adding
  // a 7th kind to the type without widening the constraint fails THIS test
  // instead of failing at runtime on the first real insert. Read from the
  // INSTALLED package's declarations — the union is a type, so the shipped
  // `.d.ts` is where it survives compilation.
  const require = createRequire(import.meta.url);
  const shortcutHits = require.resolve('@swampratnz/agent-base/storage/repository/shortcutHits.js');
  const kindSource = readFileSync(shortcutHits.replace(/\.js$/, '.d.ts'), 'utf8');
  const union = /(?:export )?(?:declare )?type ShortcutKind =([\s\S]*?);/.exec(kindSource);
  assert.ok(union, 'could not locate the ShortcutKind union — update this test if it moved');
  const kinds = [...union[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(kinds.length >= 6, `expected to parse the ShortcutKind members, got ${kinds.length}`);

  for (const kind of kinds) {
    assert.match(pairs[0][0], new RegExp(`'${kind}'`), `shortcut_hits_kind_check must permit '${kind}'`);
  }
});

test('schema manifests: every .sql file on disk is listed exactly once, for BOTH the base package and this module', () => {
  // The silent-drop hazard: each manifest reads ONLY what it lists (an explicit
  // array, not a glob, because concatenation order is load-bearing). A fragment
  // committed to a schema directory but never added to its manifest would
  // simply not be part of the migration — no error, no missing-file crash, just
  // tables (or constraints) that never get created.
  const require = createRequire(import.meta.url);
  const baseSchemaDir = dirname(require.resolve('@swampratnz/agent-base/storage/schema/manifest.js'));
  const moduleSchemaDir = join(process.cwd(), 'src', 'module', 'storage', 'schema');

  for (const [label, dir, listed] of [
    ['@swampratnz/agent-base', baseSchemaDir, [...SCHEMA_FRAGMENTS]],
    ['src/module/storage/schema/', moduleSchemaDir, [...COMMUNITY_SCHEMA_FRAGMENTS]],
  ] as const) {
    const onDisk = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const counts = new Map<string, number>();
    for (const name of listed) counts.set(name, (counts.get(name) ?? 0) + 1);
    const duplicated = [...counts.entries()].filter(([, n]) => n > 1).map(([name]) => name);
    assert.deepEqual(
      duplicated,
      [],
      `${label} lists these fragments more than once: ${duplicated.join(', ')}`,
    );

    assert.deepEqual(
      [...listed].sort(),
      onDisk,
      `${label}: the schema directory and its manifest must list exactly the same .sql files — ` +
        'a fragment on disk but missing from the manifest is silently excluded from every migration, ' +
        'and a manifest entry with no file crashes migrate() at startup.',
    );
  }
});

const baseSchema = await loadSchemaSql();

test('the module fragment never re-defines a constraint the base package owns (a module may add its own, never reshape base’s)', () => {
  const baseNames = new Set(
    [...baseSchema.matchAll(/ADD\s+CONSTRAINT\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]),
  );
  const moduleSql = COMMUNITY_MIGRATIONS.map((f) => f.sql).join('\n');
  const moduleTouched = [
    ...moduleSql.matchAll(/(?:ADD|DROP)\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/g),
  ].map((m) => m[1]);

  const stolen = moduleTouched.filter((n) => baseNames.has(n));
  assert.deepEqual(
    stolen,
    [],
    `src/module/storage/schema/ drops or re-adds constraints the base package owns: ${stolen.join(', ')}. ` +
      'A module contributes its OWN named constraints (see 80-preference-values.sql) — reshaping a ' +
      "base one couples this deployment to the framework's internals and breaks on the next base release.",
  );
});
