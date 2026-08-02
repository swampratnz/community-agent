#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Post-build smoke check for the schema fragments (runs at the end of
// `npm run build`): dist/storage/schema/ must contain exactly the .sql
// fragments the compiled manifest lists. `tsc` compiles manifest.ts but never
// copies .sql files, so the copy step in package.json's build script is what
// puts them there — and a forgotten or partial copy would otherwise surface
// only when `migrate:prod` crashes on the deploy box with ENOENT (or worse,
// silently applies a stale fragment left over from a previous build).
// ---------------------------------------------------------------------------
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distSchemaDir = path.join(repoRoot, 'dist', 'storage', 'schema');

const { SCHEMA_FRAGMENTS } = await import(pathToFileURL(path.join(distSchemaDir, 'manifest.js')).href);

const listed = [...SCHEMA_FRAGMENTS].sort();
const onDisk = readdirSync(distSchemaDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

if (JSON.stringify(onDisk) !== JSON.stringify(listed)) {
  const missing = listed.filter((f) => !onDisk.includes(f));
  const extra = onDisk.filter((f) => !listed.includes(f));
  console.error('check-dist-schema: dist/storage/schema/ does not match the compiled manifest.');
  if (missing.length > 0) console.error(`  missing from dist: ${missing.join(', ')}`);
  if (extra.length > 0) console.error(`  in dist but not in the manifest: ${extra.join(', ')}`);
  console.error('  The build script must copy src/storage/schema/*.sql into dist/storage/schema/.');
  process.exit(1);
}

console.log(`check-dist-schema: dist/storage/schema/ matches the manifest (${listed.length} fragments).`);
