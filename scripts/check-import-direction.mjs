#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Composition-direction gate.
//
//   @swampratnz/agent-base  the framework, consumed as a package
//   src/module/             this deployment's NZ-Claude-Community content
//   src/index.ts            the composition root — the ONE file that composes
//
// Three rules, each still real after the package flip:
//
//  1. `src/base/` MUST NOT EXIST. The framework is the published package now;
//     re-creating a local copy would fork it silently — the same file compiling
//     in two places, with only one of them getting upstream fixes. (Before the
//     flip this rule read "base may never import module", which is what made
//     the lift possible; the fixture tests below still pin that half, so the
//     check keeps working for a tree that has both halves.)
//  2. `src/module/` may never import the composition root. index.ts sits at the
//     top of the graph; a module file reaching back up to it would make the
//     wiring circular and hand module code a handle on the startup sequence.
//  3. Only the composition root may call `createAgent` (or the other
//     composition entry points). A module CONTRIBUTES a manifest — it must not
//     compose one, because composition is exactly the ordering guarantee
//     createAgent exists to own: plan, init, singletons, additive
//     registrations, readiness probe, migrate, start.
//
// Enforced twice, on purpose. eslint's no-restricted-imports catches rules 2
// and 3 in the editor and on `npm run lint`, but it is pattern matching over
// the specifier text: it cannot follow `../../index.js` back to a real path,
// and a config edit silently disables it. This script resolves every relative
// specifier against the file system, so it sees through any amount of `../`,
// and it is a plain node script with no config of its own to weaken.
//
// `--root <dir>` relocates the scan so the tests can drive every rule against
// fixture trees instead of only ever seeing this repo's (passing) state.
// Nothing in CI passes it.
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
    'import time, or declare the type structurally in base — a `typeof <community export>` is ' +
    'still a dependency. (This repo has no src/base/ any more; the rule is kept because the gate ' +
    'is also run against fixture trees that do.)',
});

scan(tsFiles(MODULE_DIR), {
  forbid: (target) => target === INDEX_FILE,
  label: 'src/module/ must not import the composition root',
  hint: 'src/index.ts sits at the top of the graph; nothing it wires may reach back up to it.',
});

// Rule 3: only the composition root composes. A bare package specifier can
// never resolve into this tree, so `scan()` (which resolves relative
// specifiers) cannot see it — this is a specifier-text check on the package's
// composition entry points, which are only ever imported by name.
const COMPOSITION_EXPORTS = ['createAgent', 'planComposition', 'assertRegistrationsComplete'];
const PACKAGE_IMPORT_RE = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'@swampratnz\/agent-base'/gs;
for (const file of tsFiles(MODULE_DIR)) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(PACKAGE_IMPORT_RE)) {
    const named = match[1].split(',').map((n) =>
      n
        .trim()
        .split(/\s+as\s+/)[0]
        .replace(/^type\s+/, ''),
    );
    for (const name of named.filter((n) => COMPOSITION_EXPORTS.includes(n))) {
      const line = source.slice(0, match.index).split('\n').length;
      violations.push({
        file: path.relative(repoRoot, file),
        line,
        specifier: `@swampratnz/agent-base (${name})`,
        target: 'the framework composition entry point',
        label: 'only the composition root may compose the agent',
        hint:
          'A module CONTRIBUTES an AgentModule manifest (src/module/agentModule.ts); src/index.ts is ' +
          'the only file that hands it to createAgent. Composing from inside a module would move the ' +
          'registration ORDER — the thing createAgent exists to own — back into an import list.',
      });
    }
  }
}

// Rule 1: the framework must stay a package. Skipped under `--root`, where the
// fixtures deliberately build a two-halves tree to exercise the rules above.
if (rootFlag === -1 && existsSync(BASE_DIR)) {
  console.error(
    'check-import-direction: src/base/ exists again.\n\n' +
      '  The framework lives in @swampratnz/agent-base now. A local src/base/ forks it silently: the ' +
      'same file compiles in two places and only one of them gets upstream fixes.\n' +
      '  Framework-level changes belong in the package (and reach this repo through a version bump); ' +
      "this deployment's content belongs in src/module/.\n",
  );
  process.exit(1);
}

if (violations.length > 0) {
  console.error('check-import-direction: the composition-direction rules are broken.\n');
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
  `check-import-direction: ${scanned} files obey the composition-direction rules ` +
    '(no src/base/; src/module/ imports no composition root and composes no agent).',
);
