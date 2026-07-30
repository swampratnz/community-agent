import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * `migrate()` replays ALL of schema.sql as a SINGLE multi-statement query on
 * every run (`pool.query(sql)` — there is no `schema_migrations` ledger, so
 * nothing is ever skipped). Two consequences make this file's shape a
 * correctness concern rather than a style one:
 *
 *  1. Statements execute in file order against LIVE data, and
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
 * instead.
 *
 * Deliberately static (parses the SQL) rather than migrating a live DB twice
 * with data present, which would reproduce it more directly but is the wrong
 * trade here: it would need DDL locks and `shortcut_hits` rows in a suite whose
 * FILES run in parallel, and `tests/repository.test.ts` asserts on a *global*
 * `shortcutHits.total` delta — so a live version of this test would redden an
 * unrelated file. Guarding the cause costs nothing and cannot flake.
 */
const schema = readFileSync(new URL('../src/storage/schema.sql', import.meta.url), 'utf8');

test('schema.sql: no constraint name is ever re-added more than once (migrate() replays the whole file, so a stacked narrower pair breaks every future migration)', () => {
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
    `schema.sql re-adds these constraint names more than once: ${duplicated
      .map(([name, count]) => `${name} (${count}x)`)
      .join(', ')}. Widen the EXISTING pair's list in place instead of appending ` +
      'a new DROP/ADD pair — the earlier, narrower one still runs on every ' +
      'replay and will abort the whole migration once a row uses a value only ' +
      'the later pair allows.',
  );
});

test('schema.sql: every constraint re-add is preceded by its own DROP CONSTRAINT IF EXISTS (so a replay cannot fail on "already exists")', () => {
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

test('schema.sql: shortcut_hits_kind_check permits every ShortcutKind, in one pair (regression: issue #874 row blocked all migrations)', () => {
  const pairs = [
    ...schema.matchAll(/ADD\s+CONSTRAINT\s+shortcut_hits_kind_check\s*\n?\s*CHECK\s*\([^)]*\)/g),
  ];
  assert.equal(pairs.length, 1, 'exactly one shortcut_hits_kind_check re-add is expected');

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
