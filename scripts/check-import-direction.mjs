#!/usr/bin/env node
// ---------------------------------------------------------------------------
// The one-way import rule between the two halves of src/ (agent-base plan
// §Phase-2).
//
//   src/base/    the community-agnostic framework
//   src/module/  this deployment's NZ-Claude-Community content and wiring
//   src/index.ts the composition root — the ONE file allowed to import both
//
// base may NEVER import module. That is the whole property Phase 3 depends on:
// src/base/ has to be liftable into the agent-base package on its own, and a
// single edge the wrong way makes it un-liftable. Registries exist for exactly
// this — base declares a slot, the module registers into it at its own import
// time, and index.ts carries the side-effect import.
//
// Enforced twice, on purpose. eslint's no-restricted-imports catches it in the
// editor and on `npm run lint`, but it is pattern matching over the specifier
// text: it cannot follow `../../module` back to a real path, and a config edit
// silently disables it. This script resolves every specifier against the file
// system, so it sees through any amount of `../`, and it is a plain node script
// with no config of its own to weaken. Neither layer is redundant — the first
// gives the fast local signal, the second is the one that is actually hard to
// get wrong.
//
// It also flags module importing src/index.ts: the composition root is the top
// of the graph, and a module file reaching back up to it would make the wiring
// circular and give module code a handle on base's startup sequence.
//
// `--root <dir>` relocates the scan so the tests can drive both directions
// against fixture trees instead of only ever seeing this repo's (passing)
// state. Nothing in CI passes it.
// ---------------------------------------------------------------------------
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const rootFlag = process.argv.indexOf('--root');
const repoRoot =
  rootFlag !== -1 && process.argv[rootFlag + 1]
    ? path.resolve(process.argv[rootFlag + 1])
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BASE_DIR = path.join(repoRoot, 'src', 'base');
const MODULE_DIR = path.join(repoRoot, 'src', 'module');
const INDEX_FILE = path.join(repoRoot, 'src', 'index.ts');

/** Every `.ts` file under `dir`, recursively; `[]` when the directory is absent. */
function tsFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(abs));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(abs);
  }
  return out.sort();
}

/**
 * Relative specifiers only — a bare package name can never resolve into the
 * tree. Covers `import`/`export … from`, bare side-effect `import '…'` and
 * dynamic `import('…')` alike, because all three are just a quoted specifier
 * and the check is about where it points, not how it is spelled.
 */
const SPECIFIER_RE = /(['"])(\.\.?\/[^'"]*)\1/g;

/** Resolve a specifier written in `fromFile` to a real path, honouring the .js -> .ts rewrite. */
function resolveSpecifier(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base.endsWith('.js') ? `${base.slice(0, -3)}.ts` : null,
    `${base}.ts`,
    path.join(base, 'index.ts'),
    base,
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const violations = [];

function scan(files, { forbid, label, hint }) {
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const match of lines[i].matchAll(SPECIFIER_RE)) {
        const resolved = resolveSpecifier(file, match[2]);
        if (resolved && forbid(resolved)) {
          violations.push({
            file: path.relative(repoRoot, file),
            line: i + 1,
            specifier: match[2],
            target: path.relative(repoRoot, resolved),
            label,
            hint,
          });
        }
      }
    }
  }
}

const inside = (dir) => (target) => target === dir || target.startsWith(dir + path.sep);

scan(tsFiles(BASE_DIR), {
  forbid: inside(MODULE_DIR),
  label: 'src/base/ must not import src/module/',
  hint:
    'Invert it: declare a registry slot in base and have the module register into it at its own ' +
    'import time (see src/base/agent/turnState.ts, src/base/strings/catalogue.ts), or declare the ' +
    'type structurally in base — a `typeof <community export>` is still a dependency. If it is a ' +
    'genuine framework concern, the file belongs in src/base/.',
});

scan(tsFiles(MODULE_DIR), {
  forbid: (target) => target === INDEX_FILE,
  label: 'src/module/ must not import the composition root',
  hint: 'src/index.ts sits above both halves; nothing it wires may reach back up to it.',
});

if (violations.length > 0) {
  console.error('check-import-direction: the one-way rule between src/base/ and src/module/ is broken.\n');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.specifier}  ->  ${v.target}`);
    console.error(`    ${v.label}`);
  }
  console.error('');
  for (const hint of new Set(violations.map((v) => v.hint))) console.error(`  ${hint}`);
  process.exit(1);
}

const scanned = tsFiles(BASE_DIR).length + tsFiles(MODULE_DIR).length;
console.log(
  `check-import-direction: ${scanned} files obey the one-way rule ` +
    '(src/base/ imports no src/module/; src/module/ imports no composition root).',
);
