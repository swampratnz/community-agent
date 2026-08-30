import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Regression guard for scripts/eval-answers.ts (issue #1235): the file's
 * dynamic imports once pointed at the deleted `src/base/` tree, invisible to
 * every gate — the guard clauses `process.exit(0)` before the imports
 * whenever DATABASE_URL/CLAUDE_CODE_OAUTH_TOKEN are absent, `scripts/` is
 * outside tsconfig.json's `include`, and tests/importDirection.test.ts only
 * checks that the `src/base` *directory* doesn't exist, not that a script
 * string still references it. This is a plain filesystem read + string
 * match, no DB and no model call, so it runs under `npm test`.
 */

const scriptPath = fileURLToPath(new URL('../scripts/eval-answers.ts', import.meta.url));
const source = readFileSync(scriptPath, 'utf8');

test('scripts/eval-answers.ts has no src/base import-position reference', () => {
  const offendingLines = source
    .split('\n')
    .filter((line) => /\b(?:import|require)\b[^\n]*['"]\.\.\/src\/base\//.test(line));
  assert.deepEqual(
    offendingLines,
    [],
    `scripts/eval-answers.ts still imports from the deleted src/base/ tree: ${JSON.stringify(offendingLines)}`,
  );
});

test('scripts/eval-answers.ts uses the @swampratnz/agent-base package for its runtime deps', () => {
  for (const specifier of [
    '@swampratnz/agent-base/storage/db.js',
    '@swampratnz/agent-base/storage/repository.js',
    '@swampratnz/agent-base/agent/core.js',
    '@swampratnz/agent-base/auth/rbac.js',
    '@swampratnz/agent-base/platforms/types.js',
  ]) {
    assert.ok(source.includes(specifier), `expected scripts/eval-answers.ts to import from "${specifier}"`);
  }
});

test('scripts/eval-answers.ts header comment does not cite the deleted src/base path', () => {
  assert.doesNotMatch(
    source,
    /src\/base\/agent\/core\.ts/,
    'header comment still cites src/base/agent/core.ts instead of the package path',
  );
});
