import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModuleMigrationFragment } from '@swampratnz/agent-base/storage/migrate.js';

/**
 * This module's schema contribution (plan §3 `migrations` row).
 *
 * Everything the community used to keep in `src/base/storage/schema/` moved
 * into the package: fragments 00–27, the 50–53 feature tables and the 70
 * adapter fragment are shipped by agent-base byte-verbatim, so this deployment
 * must NOT re-declare them — `createAgent` concatenates base's fragments first
 * and these after, as one atomic query (storage/migrate.ts).
 *
 * What is left is genuinely community content: the two standing-preference
 * VALUE allowlists that agent-base generalised into shape checks. The 80 band
 * is deliberately past base's highest (70), so a module fragment can never be
 * mistaken for one of base's.
 *
 * Read SYNCHRONOUSLY at import: `AgentModule.migrations` is plain data, and
 * this happens once, at composition, before anything can serve a turn. The
 * fragments sit next to this module in BOTH layouts (src/module/storage/schema/
 * under tsx, dist/module/storage/schema/ in the built artifact — package.json's
 * build script copies them and scripts/check-dist-schema.mjs verifies the copy),
 * so resolve them relative to the module URL exactly as base's manifest does.
 */
export const COMMUNITY_SCHEMA_FRAGMENTS = [
  '80-preference-values.sql',
  '81-access-request-resolutions.sql',
] as const;

const schemaDir = dirname(fileURLToPath(import.meta.url));

export const COMMUNITY_MIGRATIONS: readonly ModuleMigrationFragment[] = COMMUNITY_SCHEMA_FRAGMENTS.map(
  (name) => ({
    name: `nz-community/${name}`,
    sql: readFileSync(join(schemaDir, name), 'utf8'),
  }),
);
