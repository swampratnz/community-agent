#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Freshness gate for the agent context pack (docs/agents/ — see its README).
//
// The pack exists so a COLD pipeline session (every GitHub Actions worker is
// one) can orient from a committed map instead of re-exploring ~90 source
// files and 160 test files on every single run. That only pays off if the map
// is TRUE. A stale map is strictly worse than no map: it sends an agent
// confidently to a path that moved, and the agent has no way to tell.
//
// So the map is not documentation-by-good-intentions — it is a manifest with a
// gate, exactly like tests/security-floor.json:
//
//   * every module the map is supposed to cover HAS an entry,
//   * every entry names a path that still EXISTS,
//   * entries are unique and SORTED (same anti-merge-conflict rationale as the
//     security floor: two PRs adding entries for different modules then land in
//     different hunks instead of colliding at a shared append point),
//   * no entry is left as an unwritten stub.
//
// Scope is deliberately `src/` only — the subsystem directories and the
// top-level modules. Workflows are already documented far better in
// docs/PIPELINE.md than a one-liner could manage, and gating tests/ would mean
// 160 entries of upkeep for little orientation value. The map file may describe
// anything it likes OUTSIDE the checked region; only the region is enforced.
//
// `--write` mechanises the boring half (add/drop/sort) but deliberately CANNOT
// make the gate green on its own: it inserts a TODO stub for a new module and
// the check still fails until someone writes the one-liner. That is the point —
// the gate's whole job is to stop a module entering the tree undescribed, and a
// fixer that auto-satisfied it would defeat itself. Contrast
// check-security-test-count.mjs's --write, which CAN finish the job because a
// count is derivable from the code and a description is not.
// ---------------------------------------------------------------------------
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// `--root <dir>` relocates BOTH the src scan and the map, so tests can drive
// every failure mode against a fixture tree instead of only ever seeing this
// repo's (passing) state. Nothing in CI passes it; the default is this repo.
const rootFlag = process.argv.indexOf('--root');
const repoRoot =
  rootFlag !== -1 && process.argv[rootFlag + 1]
    ? path.resolve(process.argv[rootFlag + 1])
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mapPath = path.join(repoRoot, 'docs', 'agents', 'module-map.md');
const REGION_BEGIN = '<!-- module-map:begin -->';
const REGION_END = '<!-- module-map:end -->';
const STUB = 'TODO: describe this module in one line.';

/** `- \`path\` — description` — the em dash is the separator, matching repo prose style. */
const ENTRY_RE = /^- `([^`]+)` — (.+)$/;

// ---- What the map must cover ----------------------------------------------
// Directories are listed as `src/<name>/` (trailing slash) so a reader can tell
// at a glance whether an entry is a subsystem or a single module.
function requiredPaths() {
  const srcDir = path.join(repoRoot, 'src');
  const entries = readdirSync(srcDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => `src/${e.name}/`);
  const files = entries.filter((e) => e.isFile() && e.name.endsWith('.ts')).map((e) => `src/${e.name}`);
  return [...dirs, ...files].sort();
}

function pathExists(rel) {
  const abs = path.join(repoRoot, rel);
  if (!existsSync(abs)) return false;
  // A directory entry must still BE a directory (and vice versa), so a module
  // that turned into a subsystem — or collapsed back — is caught rather than
  // quietly passing on the name alone.
  const isDir = statSync(abs).isDirectory();
  return rel.endsWith('/') ? isDir : !isDir;
}

// ---- Parse the checked region ---------------------------------------------
const source = readFileSync(mapPath, 'utf8');
const beginAt = source.indexOf(REGION_BEGIN);
const endAt = source.indexOf(REGION_END);
if (beginAt === -1 || endAt === -1 || endAt < beginAt) {
  console.error(
    `check-context-pack: docs/agents/module-map.md is missing its checked region. It must contain ` +
      `${REGION_BEGIN} and ${REGION_END} (in that order) around the module list.`,
  );
  process.exit(1);
}

const head = source.slice(0, beginAt + REGION_BEGIN.length);
const tail = source.slice(endAt);
const regionBody = source.slice(beginAt + REGION_BEGIN.length, endAt);

const parsed = [];
const malformed = [];
for (const line of regionBody.split('\n')) {
  const trimmed = line.trim();
  if (trimmed === '') continue;
  const m = trimmed.match(ENTRY_RE);
  if (!m) {
    malformed.push(trimmed);
    continue;
  }
  parsed.push({ path: m[1], description: m[2].trim() });
}

const required = requiredPaths();
const byPath = new Map();
const duplicates = [];
for (const entry of parsed) {
  if (byPath.has(entry.path)) duplicates.push(entry.path);
  else byPath.set(entry.path, entry);
}

// ---- --write: add, drop, sort ---------------------------------------------
if (process.argv.includes('--write')) {
  const next = [];
  for (const rel of required) {
    const existing = byPath.get(rel);
    next.push({ path: rel, description: existing ? existing.description : STUB });
  }
  // Keep any entry the author added for a path outside the required set, as
  // long as it still exists — the map is allowed to be MORE complete than the
  // gate demands (e.g. a notable nested file).
  for (const entry of parsed) {
    if (required.includes(entry.path)) continue;
    if (pathExists(entry.path)) next.push(entry);
  }
  next.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const rendered = next.map((e) => `- \`${e.path}\` — ${e.description}`).join('\n');
  writeFileSync(mapPath, `${head}\n\n${rendered}\n\n${tail}`);
  const stubs = next.filter((e) => e.description === STUB);
  const dropped = parsed.filter((e) => !next.some((n) => n.path === e.path)).map((e) => e.path);
  console.log(`check-context-pack --write: normalised ${next.length} entries in docs/agents/module-map.md.`);
  if (dropped.length > 0) console.log(`  dropped (path no longer exists): ${dropped.join(', ')}`);
  if (stubs.length > 0) {
    console.log(
      `  ${stubs.length} entr${stubs.length === 1 ? 'y' : 'ies'} still need a one-line description:`,
    );
    for (const s of stubs) console.log(`    ${s.path}`);
    console.log('  Write those, then re-run `npm run context:check`. --write cannot invent a description.');
  }
  process.exit(0);
}

// ---- Check ----------------------------------------------------------------
const problems = [];

for (const line of malformed) {
  problems.push(
    `unparseable line in the checked region: "${line}". Entries must read exactly ` +
      '``- `path` — description``  (backticked path, em dash, description). ' +
      'Prose belongs outside the region markers.',
  );
}

for (const rel of required) {
  if (!byPath.has(rel)) {
    problems.push(
      `${rel} has no entry in docs/agents/module-map.md. A new module must be described in the same ` +
        'diff that adds it, or the next cold pipeline session gets a map it cannot trust. ' +
        'Run `npm run context:fix` to insert a stub, then write the one-liner.',
    );
  }
}

for (const entry of parsed) {
  if (!pathExists(entry.path)) {
    problems.push(
      `${entry.path} is described in docs/agents/module-map.md but no longer exists (or changed between ` +
        'file and directory). Remove or update the entry in the same diff as the move — ' +
        '`npm run context:fix` drops dead entries for you.',
    );
  }
  if (entry.description.includes('TODO')) {
    problems.push(
      `${entry.path} still has a TODO stub for a description. Write one line saying what it is for — ` +
        'that line is the whole point of the map.',
    );
  } else if (entry.description.length < 20) {
    problems.push(
      `${entry.path} has a ${entry.description.length}-character description ("${entry.description}"). ` +
        'Too short to orient anyone; say what it does and, where it matters, what it must not do.',
    );
  }
}

for (const dup of new Set(duplicates)) {
  problems.push(`${dup} appears more than once in the checked region — keep exactly one entry per path.`);
}

const order = parsed.map((e) => e.path);
const sorted = [...order].sort();
if (order.some((p, i) => p !== sorted[i])) {
  const firstOff = order.findIndex((p, i) => p !== sorted[i]);
  problems.push(
    `the checked region is not sorted by path (first out-of-order entry: ${order[firstOff]}). Sorted order ` +
      'gives every entry a stable home, so two PRs describing different new modules land in different ' +
      'hunks instead of conflicting — run `npm run context:fix` to normalise.',
  );
}

if (problems.length > 0) {
  console.error('check-context-pack: docs/agents/module-map.md is out of sync with the tree:');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

console.log(
  `check-context-pack: docs/agents/module-map.md covers all ${required.length} required paths ` +
    `(${parsed.length} entries total, sorted, no stubs).`,
);
