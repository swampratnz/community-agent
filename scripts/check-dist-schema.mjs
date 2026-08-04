#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Post-build smoke check for THIS MODULE's schema fragments (runs at the end
// of `npm run build`): dist/module/storage/schema/ must contain exactly the
// .sql fragments the compiled manifest lists. `tsc` compiles manifest.ts but
// never copies .sql files, so the copy step in package.json's build script is
// what puts them there — and a forgotten or partial copy would otherwise
// surface only when `migrate:prod` crashes on the deploy box with ENOENT (or
// worse, silently applies a stale fragment left over from a previous build).
//
// The BASE fragments are agent-base's problem now: they ship inside the
// installed package (its own build copies and checks them), which is why this
// only looks at the module half.
// ---------------------------------------------------------------------------
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distSchemaDir = path.join(repoRoot, 'dist', 'module', 'storage', 'schema');

const { COMMUNITY_SCHEMA_FRAGMENTS } = await import(
  pathToFileURL(path.join(distSchemaDir, 'manifest.js')).href
);

const listed = [...COMMUNITY_SCHEMA_FRAGMENTS].sort();
const onDisk = readdirSync(distSchemaDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

if (JSON.stringify(onDisk) !== JSON.stringify(listed)) {
  const missing = listed.filter((f) => !onDisk.includes(f));
  const extra = onDisk.filter((f) => !listed.includes(f));
  console.error('check-dist-schema: dist/module/storage/schema/ does not match the compiled manifest.');
  if (missing.length > 0) console.error(`  missing from dist: ${missing.join(', ')}`);
  if (extra.length > 0) console.error(`  in dist but not in the manifest: ${extra.join(', ')}`);
  console.error(
    '  The build script must copy src/module/storage/schema/*.sql into dist/module/storage/schema/.',
  );
  process.exit(1);
}

console.log(
  `check-dist-schema: dist/module/storage/schema/ matches the manifest (${listed.length} fragments).`,
);
