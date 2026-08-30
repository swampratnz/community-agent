import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Regression guard for the leak-safety invariant issue #1247 relies on:
 * scripts/eval-answers.ts now seeds a `createdByRole: 'auto'` fixture
 * knowledge entry (for the auto-researched-caveat eval case), and the only
 * thing that keeps that entry from surfacing in real members' live
 * `knowledge_search` results is that it is written scoped to the harness's
 * per-run `EVAL_SCOPE` — never via a global-scoped write path — and reliably
 * deleted by the harness's own cleanup afterwards. This is a static
 * source-level assertion (no DB, no model call), so it runs under `npm test`
 * even though the harness itself stays off-CI (tests/evalAnswersOffCi.test.ts).
 */

const scriptPath = fileURLToPath(new URL('../scripts/eval-answers.ts', import.meta.url));
const source = readFileSync(scriptPath, 'utf8');

test('SECURITY: scripts/eval-answers.ts seeds fixture knowledge entries with an explicit scope: EVAL_SCOPE', () => {
  const saveKnowledgeCallMatch = source.match(/await saveKnowledge\(\{[\s\S]*?\}\);/);
  assert.ok(
    saveKnowledgeCallMatch,
    'expected to find a saveKnowledge({ ... }) call in scripts/eval-answers.ts',
  );
  assert.match(
    saveKnowledgeCallMatch[0],
    /scope:\s*EVAL_SCOPE/,
    "the saveKnowledge seeding call must pass scope: EVAL_SCOPE, so a createdByRole: 'auto' fixture entry can never " +
      "be written to global scope and surface in real members' live knowledge_search results",
  );
});

test('SECURITY: scripts/eval-answers.ts cleans up fixture rows by the same EVAL_SCOPE it seeded with', () => {
  assert.match(
    source,
    /DELETE FROM knowledge WHERE scope = \$1/,
    "expected the harness's cleanup to delete fixture rows scoped by $1",
  );
  assert.match(
    source,
    /pool\.query\(\s*['"]DELETE FROM knowledge WHERE scope = \$1['"],\s*\[EVAL_SCOPE\]\s*\)/,
    'expected the cleanup query to be parameterised with [EVAL_SCOPE], matching the scope the seeding loop used',
  );
});
