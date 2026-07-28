import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Off-CI posture gate for scripts/eval-answers.ts (issue #779,
 * docs/CAPABILITY-IDEAS.md §F1). This harness calls the real model on a
 * maintainer's own credential — the same posture docs/RED-TEAM.md already
 * establishes for the structurally identical red-team sweep. That posture
 * must be enforced as a regression gate, not just a doc convention, so a
 * later PR can't silently wire it into an automated, credentialed path (the
 * exact failure mode issue #227's original CI-integrated promptfoo draft was
 * rejected for).
 */

const HARNESS_PATTERN = /eval:answers|eval-answers/;

const workflowsDir = new URL('../.github/workflows/', import.meta.url);
const workflowFiles = readdirSync(fileURLToPath(workflowsDir)).filter((f) => f.endsWith('.yml'));

test('SECURITY: no .github/workflows file invokes eval:answers or the eval-answers script', () => {
  const offenders: string[] = [];
  for (const file of workflowFiles) {
    const content = readFileSync(new URL(file, workflowsDir), 'utf8');
    if (HARNESS_PATTERN.test(content)) offenders.push(file);
  }
  assert.deepEqual(
    offenders,
    [],
    `workflow file(s) reference the off-CI eval-answers harness, which must stay maintainer-run only: ${offenders.join(', ')}`,
  );
});

test('SECURITY: package.json "test" and "test:security" scripts do not invoke or chain eval:answers', () => {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as {
    scripts: Record<string, string>;
  };
  for (const scriptName of ['test', 'test:security']) {
    const script = pkg.scripts[scriptName];
    assert.ok(script, `package.json is missing the "${scriptName}" script`);
    assert.doesNotMatch(
      script,
      HARNESS_PATTERN,
      `package.json's "${scriptName}" script invokes/chains the off-CI eval-answers harness`,
    );
  }
});
