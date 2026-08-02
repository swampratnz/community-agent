import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// Storage boot config validates env at import time — provide a dummy
// DATABASE_URL before importing anything that (transitively) loads it,
// matching the convention in tests/repository.test.ts.
const hasDb = Boolean(process.env.DATABASE_URL);

process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

const { pool, closeDb } = await import('../src/storage/db.js');
const { bootConfig } = await import('../src/config/boot.js');
const { loadSchemaSql } = await import('../src/storage/schema/manifest.js');

/**
 * REPLAY-IDEMPOTENCY proof for the fragment split (docs/AGENT-BASE-PLAN.md
 * Phase 1 item 4): the CI database this runs against has already been
 * migrated by the CI migrate step (locally: `npm run migrate` first, per
 * docs/agents/recipes.md), so applying the full manifest concatenation AGAIN
 * — same :EMBEDDING_DIM substitution, same ONE pool.query as migrate() — must
 * succeed, and must leave the catalog exactly as it found it. That is the
 * production contract the split must not break: migrate() replays the whole
 * schema over the already-applied prod DB on every deploy.
 *
 * Why not a full monolith-vs-fragments pg_dump diff in-process: the monolith
 * schema.sql no longer exists in the tree to dump from (git history holds it;
 * the statement-level byte-identity of the move was verified mechanically in
 * the splitting PR). Replay-idempotency + catalog stability is the gate that
 * stays enforceable in-repo — it fails if a fragment drops, rewords, or
 * reorders a statement in a way that changes what a replay produces.
 *
 * The snapshot is DDL-only (tables + columns + constraint names/definitions
 * from information_schema/pg_catalog), deliberately not row data: other test
 * FILES run in parallel against the same database and their DML must not
 * redden this file.
 */
async function snapshotCatalog(): Promise<string> {
  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`,
  );
  const columns = await pool.query(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' ORDER BY table_name, column_name`,
  );
  const constraints = await pool.query(
    `SELECT r.relname AS table_name, c.conname AS constraint_name,
            pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_class r ON r.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = r.relnamespace
      WHERE n.nspname = 'public' ORDER BY r.relname, c.conname`,
  );
  const indexes = await pool.query(
    `SELECT tablename, indexname FROM pg_indexes
      WHERE schemaname = 'public' ORDER BY tablename, indexname`,
  );
  return JSON.stringify(
    {
      tables: tables.rows,
      columns: columns.rows,
      constraints: constraints.rows,
      indexes: indexes.rows,
    },
    null,
    2,
  );
}

test(
  'schema fragments: replaying the full concatenation over an already-migrated database succeeds and leaves the catalog byte-identical',
  { skip },
  async () => {
    const before = await snapshotCatalog();
    // Precondition, not vacuity: on a database that was never migrated the
    // replay would CREATE everything and before/after would differ for the
    // wrong reason. Fail with the actionable message instead.
    assert.match(
      before,
      /"table_name": "sessions"/,
      'database has not been migrated — run `npm run migrate` before `npm test` (docs/agents/recipes.md)',
    );

    // Exactly what migrate() does: one substitution, ONE multi-statement
    // pool.query (atomicity is load-bearing — a mid-file failure must roll
    // back the entire replay).
    const raw = await loadSchemaSql();
    const sql = raw.replaceAll(':EMBEDDING_DIM', String(bootConfig.db.embeddingDim));
    await pool.query(sql);

    const after = await snapshotCatalog();
    assert.equal(
      after,
      before,
      'replaying the schema fragments changed the catalog of an already-migrated database — ' +
        'the concatenation is no longer replay-idempotent against the production schema',
    );
  },
);

after(async () => {
  await closeDb();
});
