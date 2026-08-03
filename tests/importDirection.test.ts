import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * scripts/check-import-direction.mjs — the composition-direction rules.
 *
 * Since the agent-base package flip the gate enforces three things: `src/base/`
 * must not exist (the framework is a package; a local copy forks it silently),
 * `src/module/` may never import the composition root, and only the
 * composition root may call `createAgent`. The base→module rule is kept in the
 * script — the fixtures below still pin it — because it is what a two-halves
 * tree needs and what makes a lift possible in the first place.
 *
 * eslint enforces the same rules from the specifier TEXT; this script resolves
 * each relative specifier against the file system, which is what makes it proof
 * against any depth of `../`.
 *
 * These tests drive the gate against fixture trees (via its `--root` flag) so
 * every rule is pinned, rather than only ever observing this repo's passing
 * state. `--root` also suppresses the "no src/base/" rule, since the fixtures
 * deliberately build a two-halves tree.
 */

const SCRIPT = fileURLToPath(new URL('../scripts/check-import-direction.mjs', import.meta.url));

type Fixture = { root: string; cleanup: () => void };

/** A minimal two-package tree: `files` is a map of src-relative path -> contents. */
function fixture(files: Record<string, string>): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'import-direction-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, 'src', rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function check(root: string) {
  const result = spawnSync('node', [SCRIPT, '--root', root], { encoding: 'utf8' });
  // A spawn failure is an environment problem, not a gate verdict — surface it
  // as itself rather than as a confusing "expected 1, got null".
  assert.equal(result.error, undefined, `could not spawn the gate: ${result.error}`);
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

/** The legal shape: module reaches down into base, base reaches nowhere but itself. */
const LEGAL = {
  'index.ts': "import './base/kernel.js';\nimport './module/content.js';\n",
  'base/kernel.ts': "import './util.js';\nexport const kernel = 1;\n",
  'base/util.ts': 'export const util = 1;\n',
  'module/content.ts': "import { kernel } from '../base/kernel.js';\nexport const content = kernel;\n",
};

test('a tree where only module imports base passes', () => {
  const f = fixture(LEGAL);
  const { status, out } = check(f.root);
  assert.equal(status, 0, out);
  // Three scanned files: the two under base/ and the one under module/. The
  // composition root is deliberately not scanned — it is the one file allowed
  // both edges.
  assert.match(out, /3 files obey the composition-direction rules/);
  f.cleanup();
});

test('base importing module fails, naming the file, line and specifier', () => {
  const f = fixture({
    ...LEGAL,
    'base/kernel.ts':
      "import './util.js';\nimport { content } from '../module/content.js';\nexport const kernel = content;\n",
  });
  const { status, out } = check(f.root);
  assert.equal(status, 1, out);
  assert.match(out, /src\/base\/kernel\.ts:2/);
  assert.match(out, /\.\.\/module\/content\.js/);
  assert.match(out, /src\/base\/ must not import src\/module\//);
  f.cleanup();
});

test('base importing module from a nested directory is caught through any depth of ../', () => {
  const f = fixture({
    ...LEGAL,
    'base/agent/tools/types.ts':
      "import { content } from '../../../module/content.js';\nexport const t = content;\n",
  });
  const { status, out } = check(f.root);
  assert.equal(status, 1, out);
  assert.match(out, /src\/base\/agent\/tools\/types\.ts:1/);
  assert.match(out, /-> {2}src\/module\/content\.ts/);
  f.cleanup();
});

test('a type-only import from base into module is still a violation', () => {
  const f = fixture({
    ...LEGAL,
    'base/kernel.ts':
      "import type { content } from '../module/content.js';\nexport type K = typeof content;\n",
  });
  const { status, out } = check(f.root);
  assert.equal(status, 1, out);
  assert.match(out, /src\/base\/kernel\.ts:1/);
  f.cleanup();
});

test('a bare side-effect import and a dynamic import from base are both violations', () => {
  const bare = fixture({ ...LEGAL, 'base/kernel.ts': "import '../module/content.js';\n" });
  assert.equal(check(bare.root).status, 1);
  bare.cleanup();

  const dynamic = fixture({
    ...LEGAL,
    'base/kernel.ts': "export const load = async () => await import('../module/content.js');\n",
  });
  assert.equal(check(dynamic.root).status, 1);
  dynamic.cleanup();
});

test('module importing the composition root fails', () => {
  const f = fixture({
    ...LEGAL,
    'module/content.ts': "import '../index.js';\nexport const content = 1;\n",
  });
  const { status, out } = check(f.root);
  assert.equal(status, 1, out);
  assert.match(out, /src\/module\/content\.ts:1/);
  assert.match(out, /src\/module\/ must not import the composition root/);
  f.cleanup();
});

test('the composition root may import both halves', () => {
  const f = fixture(LEGAL);
  const { status } = check(f.root);
  // index.ts is not scanned at all — it is the one file allowed both edges,
  // and LEGAL already has it importing base and module.
  assert.equal(status, 0);
  f.cleanup();
});

test('a specifier that resolves nowhere is ignored rather than crashing the gate', () => {
  const f = fixture({ ...LEGAL, 'base/kernel.ts': "import './does-not-exist.js';\n" });
  const { status, out } = check(f.root);
  assert.equal(status, 0, out);
  f.cleanup();
});

test('a module file that imports createAgent fails — only the composition root composes', () => {
  const f = fixture({
    ...LEGAL,
    'module/content.ts':
      "import { createAgent } from '@swampratnz/agent-base';\nexport const content = createAgent;\n",
  });
  const { status, out } = check(f.root);
  assert.equal(status, 1, out);
  assert.match(out, /src\/module\/content\.ts:1/);
  assert.match(out, /only the composition root may compose the agent/);
  f.cleanup();
});

test('a module file may still import ordinary package symbols and the manifest TYPE', () => {
  const f = fixture({
    ...LEGAL,
    'module/content.ts':
      "import type { AgentModuleManifest } from '@swampratnz/agent-base';\n" +
      "import { notice } from '@swampratnz/agent-base/strings/catalogue.js';\n" +
      'export const content: AgentModuleManifest = { name: notice as unknown as string };\n',
  });
  const { status, out } = check(f.root);
  assert.equal(status, 0, out);
  f.cleanup();
});

test('this repository obeys the rules — including having no src/base/ at all', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync('node', [SCRIPT], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(existsSync(path.join(repoRoot, 'src', 'base')), false, 'src/base/ must stay gone');
});

test('a re-created src/base/ fails the gate outright, even with no bad import in it', () => {
  // Driven against a FIXTURE tree with --forbid-base, never against the real
  // repo. An earlier version created src/base/ under the actual repo root and
  // deleted it in a finally: `node:test` runs test FILES in parallel, so that
  // window was visible to every other file scanning the real tree — including
  // contextPack's "the real module-map is in sync" case, which fails the
  // moment an undescribed src/base/ appears. A gate test must not be able to
  // redden an unrelated one.
  const dir = mkdtempSync(path.join(tmpdir(), 'import-direction-base-'));
  try {
    mkdirSync(path.join(dir, 'src', 'base'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'base', 'kernel.ts'), 'export const kernel = 1;\n');
    const result = spawnSync('node', [SCRIPT, '--root', dir, '--forbid-base'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}${result.stderr}`, /src\/base\/ exists again/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
