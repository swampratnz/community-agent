// Community Agent schema (PostgreSQL + pgvector)
// The embedding dimension is templated as :EMBEDDING_DIM by migrate.ts.
//
// The old monolithic src/storage/schema.sql is split into the fragment files
// in this directory (docs/AGENT-BASE-PLAN.md Phase 1 item 4). Every statement
// moved byte-verbatim — prod-schema continuity: migrate() replays the
// concatenation over the already-applied production schema, so a reworded
// statement could diverge the replay. The numbering gap is deliberate:
// 00–27 base, 50–53 community, 70 adapter — later phases pull the bands apart
// into per-module registrations.
//
// Concatenation ORDER is load-bearing (set_updated_at() before the triggers
// that use it, referenced tables before their FKs, ALTERs after their CREATE),
// which is why this is an explicit reviewable array and NOT a directory glob.
// tests/schemaConstraintIdempotency.test.ts asserts the directory and this
// list stay in exact sync, so a fragment on disk but missing here fails CI
// instead of being silently dropped from the migration.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA_FRAGMENTS = [
  '00-extensions.sql',
  '01-functions.sql',
  '10-sessions.sql',
  '11-interactions.sql',
  '12-identity.sql',
  '13-policies.sql',
  '14-admin-audit.sql',
  '15-roster.sql',
  '16-access-requests.sql',
  '17-prefs.sql',
  '18-member-notes.sql',
  '19-suggestions.sql',
  '20-moderation.sql',
  '21-knowledge.sql',
  '22-context-digests.sql',
  '23-knowledge-candidates.sql',
  '24-knowledge-gaps.sql',
  '25-answer-feedback.sql',
  '26-jobs-shortcuts.sql',
  '27-digest-state.sql',
  '50-member-discovery.sql',
  '51-projects.sql',
  '52-dev-team.sql',
  '53-docs-ingest.sql',
  '70-whatsapp.sql',
] as const;

// Fragments live next to this module in BOTH layouts — src/storage/schema/
// under tsx and dist/storage/schema/ in the built artifact (package.json's
// build script copies them there) — so resolve relative to the module URL,
// the same pattern migrate.ts used for the old schema.sql.
const schemaDir = dirname(fileURLToPath(import.meta.url));

/**
 * Read and concatenate the schema fragments in manifest order, each prefixed
 * with a separator comment naming it so a failed migration's error offset is
 * attributable to a fragment. The result is applied by migrate() exactly as
 * the monolith was: one :EMBEDDING_DIM substitution, ONE pool.query — the
 * single multi-statement query is what makes a mid-file failure roll back the
 * whole migration (atomicity is load-bearing; see
 * tests/schemaConstraintIdempotency.test.ts).
 */
export async function loadSchemaSql(): Promise<string> {
  const parts = await Promise.all(
    SCHEMA_FRAGMENTS.map(
      async (name) => `-- fragment: ${name}\n${await readFile(join(schemaDir, name), 'utf8')}`,
    ),
  );
  return parts.join('\n');
}
