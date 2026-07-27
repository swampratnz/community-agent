import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * scripts/check-context-pack.mjs — the freshness gate on docs/agents/.
 *
 * The pack only pays for itself if it is TRUE: a stale map sends a cold
 * pipeline session confidently to a path that moved, and the session has no
 * way to tell. These tests drive the gate against fixture trees (via its
 * `--root` flag) so every failure mode is pinned, rather than only ever
 * observing this repo's passing state.
 */

const SCRIPT = fileURLToPath(new URL('../scripts/check-context-pack.mjs', import.meta.url));

const DESC_A = 'the first fixture module, described at a believable length';
const DESC_B = 'the second fixture subsystem, also described properly';

type Fixture = { root: string; mapPath: string; cleanup: () => void };

/** A minimal repo: one top-level module, one subsystem, and a map. */
function fixture(entries: string[], { srcFiles = ['alpha.ts'], srcDirs = ['beta'] } = {}): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'context-pack-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  for (const f of srcFiles) writeFileSync(path.join(root, 'src', f), '// fixture\n');
  for (const d of srcDirs) {
    mkdirSync(path.join(root, 'src', d), { recursive: true });
    writeFileSync(path.join(root, 'src', d, 'index.ts'), '// fixture\n');
  }
  const mapDir = path.join(root, 'docs', 'agents');
  mkdirSync(mapDir, { recursive: true });
  const mapPath = path.join(mapDir, 'module-map.md');
  writeFileSync(
    mapPath,
    [
      '# Fixture map',
      '',
      '<!-- module-map:begin -->',
      '',
      ...entries,
      '',
      '<!-- module-map:end -->',
      '',
    ].join('\n'),
  );
  return { root, mapPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function check(root: string, args: string[] = []) {
  const result = spawnSync('node', [SCRIPT, '--root', root, ...args], { encoding: 'utf8' });
  // A spawn failure is an environment problem, not a gate verdict — surface it
  // as itself rather than as a confusing "expected 1, got null".
  assert.equal(result.error, undefined, `could not spawn the gate: ${result.error}`);
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const good = [`- \`src/alpha.ts\` — ${DESC_A}`, `- \`src/beta/\` — ${DESC_B}`];

test('a complete, sorted map passes', () => {
  const f = fixture(good);
  const { status, out } = check(f.root);
  assert.equal(status, 0, out);
  assert.match(out, /covers all 2 required paths/);
  f.cleanup();
});

test('a module with no entry fails the gate', () => {
  const f = fixture([`- \`src/beta/\` — ${DESC_B}`]);
  const { status, out } = check(f.root);
  assert.equal(status, 1);
  assert.match(out, /src\/alpha\.ts has no entry/);
  f.cleanup();
});

test('an entry for a path that no longer exists fails the gate', () => {
  const f = fixture([...good, `- \`src/deleted.ts\` — a module that was removed in some earlier change`]);
  const { status, out } = check(f.root);
  assert.equal(status, 1);
  assert.match(out, /src\/deleted\.ts is described .* but no longer exists/);
  f.cleanup();
});

test('a module that became a subsystem (or vice versa) is caught, not passed on the name', () => {
  // `src/beta/` exists as a directory; describing it as a file must fail.
  const f = fixture([`- \`src/alpha.ts\` — ${DESC_A}`, `- \`src/beta\` — ${DESC_B}`]);
  const { status, out } = check(f.root);
  assert.equal(status, 1);
  assert.match(out, /changed between file and directory|no longer exists/);
  f.cleanup();
});

test('an unsorted region fails, because sorted order is what keeps entries merge-clean', () => {
  const f = fixture([`- \`src/beta/\` — ${DESC_B}`, `- \`src/alpha.ts\` — ${DESC_A}`]);
  const { status, out } = check(f.root);
  assert.equal(status, 1);
  assert.match(out, /not sorted by path/);
  f.cleanup();
});

test('a duplicated entry fails', () => {
  const f = fixture([...good, `- \`src/beta/\` — ${DESC_B}`]);
  const { status, out } = check(f.root);
  assert.equal(status, 1);
  assert.match(out, /appears more than once/);
  f.cleanup();
});

test('an unwritten TODO stub fails — the description is the whole point', () => {
  const f = fixture([
    `- \`src/alpha.ts\` — TODO: describe this module in one line.`,
    `- \`src/beta/\` — ${DESC_B}`,
  ]);
  const { status, out } = check(f.root);
  assert.equal(status, 1);
  assert.match(out, /still has a TODO stub/);
  f.cleanup();
});

test('a too-short description fails rather than technically satisfying the gate', () => {
  const f = fixture([`- \`src/alpha.ts\` — stuff`, `- \`src/beta/\` — ${DESC_B}`]);
  const { status, out } = check(f.root);
  assert.equal(status, 1);
  assert.match(out, /Too short to orient anyone/);
  f.cleanup();
});

test('a malformed line in the checked region fails loudly instead of being ignored', () => {
  const f = fixture([...good, 'some prose that wandered inside the markers']);
  const { status, out } = check(f.root);
  assert.equal(status, 1);
  assert.match(out, /unparseable line in the checked region/);
  f.cleanup();
});

test('a map missing its region markers fails', () => {
  const f = fixture(good);
  writeFileSync(f.mapPath, '# Fixture map\n\nno markers here at all\n');
  const { status, out } = check(f.root);
  assert.equal(status, 1);
  assert.match(out, /missing its checked region/);
  f.cleanup();
});

test('--write adds a stub for a new module, drops a dead entry, and sorts', () => {
  const f = fixture([
    `- \`src/beta/\` — ${DESC_B}`,
    `- \`src/gone.ts\` — an entry left behind by a module that was deleted`,
  ]);
  const { status, out } = check(f.root, ['--write']);
  assert.equal(status, 0, out);
  const rewritten = readFileSync(f.mapPath, 'utf8');
  assert.match(rewritten, /- `src\/alpha\.ts` — TODO/);
  assert.doesNotMatch(rewritten, /src\/gone\.ts/);
  assert.ok(
    rewritten.indexOf('src/alpha.ts') < rewritten.indexOf('src/beta/'),
    '--write must leave the region sorted',
  );
  assert.match(out, /still need a one-line description/);
  f.cleanup();
});

test('--write cannot make the gate green on its own — that is deliberate', () => {
  // A fixer that auto-satisfied the gate would let modules enter the tree
  // undescribed, which is exactly the rot the gate exists to prevent.
  const f = fixture([`- \`src/beta/\` — ${DESC_B}`]);
  assert.equal(check(f.root, ['--write']).status, 0);
  const after = check(f.root);
  assert.equal(after.status, 1);
  assert.match(after.out, /TODO stub/);
  f.cleanup();
});

test('--write preserves an author-added entry for a path outside the required set', () => {
  // The map is allowed to be MORE complete than the gate demands (e.g. a
  // notable nested file); --write must not delete that work.
  const f = fixture([
    ...good,
    `- \`src/beta/index.ts\` — a nested file the author chose to call out explicitly`,
  ]);
  assert.equal(check(f.root, ['--write']).status, 0);
  assert.match(readFileSync(f.mapPath, 'utf8'), /src\/beta\/index\.ts/);
  assert.equal(check(f.root).status, 0);
  f.cleanup();
});

test('the real docs/agents/module-map.md is in sync with the real tree', () => {
  // Belt and braces: CI runs `npm run context:check` in the lint job, but a
  // contributor running only `npm test` should still see a stale pack.
  const result = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});
