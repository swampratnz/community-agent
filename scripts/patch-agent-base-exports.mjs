#!/usr/bin/env node
// ---------------------------------------------------------------------------
// TEMPORARY SHIM — delete this script (and the `postinstall` hook that runs
// it) as soon as @swampratnz/agent-base ships subpath exports of its own.
//
// The package lifted community-agent's whole `src/base/` tree into its `dist/`
// (53 modules this app imports: the router, the repository barrel, config,
// the platform adapters, the tool-registry types, …) but its package.json
// `exports` map publishes exactly two entries:
//
//     "." -> ./dist/index.js        (a ~15-symbol barrel: createAgent, the
//                                    notice catalogue, migrate, the schema
//                                    manifest)
//     "./package.json"
//
// Node's exports map is an ALLOW-LIST: with no `"./*"` entry, every deeper
// specifier — `@swampratnz/agent-base/router.js` and friends — fails at
// resolution with ERR_PACKAGE_PATH_NOT_EXPORTED, and TypeScript reports the
// same gap as TS2307. There is no consumer-side workaround: `imports`
// (`#agent-base/*`) cannot target a path inside `node_modules` (Node rejects
// it with ERR_INVALID_PACKAGE_TARGET), and a bare `tsconfig` `paths` entry
// fixes the types while leaving the runtime broken.
//
// So until the package exports its own tree, we add the one missing line to
// the INSTALLED copy: `"./*": "./dist/*"`. That is precisely the entry the
// upstream fix should carry, which is why every import site in this repo is
// already written in its final form — when agent-base ships it, deleting this
// script is the whole migration.
//
// Idempotent, and a no-op the moment the published package grows any subpath
// export of its own. Never fails the install: a missing package (the state a
// CI job is in before the first publish) just prints a note.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = path.join(repoRoot, 'node_modules', '@swampratnz', 'agent-base', 'package.json');

if (!existsSync(pkgPath)) {
  console.log('patch-agent-base-exports: @swampratnz/agent-base is not installed — nothing to patch.');
  process.exit(0);
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const exportsMap = pkg.exports;

if (typeof exportsMap !== 'object' || exportsMap === null) {
  console.log('patch-agent-base-exports: no exports map to patch.');
  process.exit(0);
}

const subpaths = Object.keys(exportsMap).filter((key) => key !== '.' && key !== './package.json');
if (subpaths.length > 0) {
  console.log(
    `patch-agent-base-exports: agent-base already exports ${subpaths.length} subpath(s) — no patch needed. ` +
      'Delete this script and the postinstall hook.',
  );
  process.exit(0);
}

exportsMap['./*'] = './dist/*';
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`patch-agent-base-exports: added "./*" -> "./dist/*" to @swampratnz/agent-base@${pkg.version}.`);
