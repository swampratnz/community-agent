import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCitedUrls } from '../scripts/eval-answers.js';

/**
 * Unit tests for `checkCitedUrls` (issue #1381), the pure grading function
 * `scripts/eval-answers.ts` uses to catch a hallucinated/invented citation
 * URL in a graded reply. Importing the script here does NOT run the harness
 * — its DB/model-call/process.exit body is guarded behind an
 * `invokedDirectly` check specifically so this file can exercise the pure
 * function in normal `npm test`/CI, no DATABASE_URL or CLAUDE_CODE_OAUTH_TOKEN
 * needed. The off-CI posture of the harness itself stays pinned by
 * tests/evalAnswersOffCi.test.ts.
 */

test('SECURITY: checkCitedUrls returns no offending URLs when the reply cites exactly the expected URL', () => {
  const reply = 'You can file it here: https://github.com/swampratnz/community-agent/issues';
  assert.deepEqual(checkCitedUrls(reply, 'https://github.com/swampratnz/community-agent/issues'), []);
});

test('SECURITY: checkCitedUrls flags a different URL than the expected one', () => {
  const reply = 'You can file it here: https://github.com/swampratnz/agent-base/issues';
  assert.deepEqual(checkCitedUrls(reply, 'https://github.com/swampratnz/community-agent/issues'), [
    'https://github.com/swampratnz/agent-base/issues',
  ]);
});

test('SECURITY: checkCitedUrls flags any URL when no citation is expected', () => {
  const reply = 'Sure, see https://example.com/made-up for more.';
  assert.deepEqual(checkCitedUrls(reply, undefined), ['https://example.com/made-up']);
});

test('SECURITY: checkCitedUrls returns no offending URLs when no citation is expected and none is present', () => {
  const reply = 'Office hours are every second Wednesday at 7pm NZT.';
  assert.deepEqual(checkCitedUrls(reply, undefined), []);
});

test('SECURITY: checkCitedUrls matches a URL with trailing sentence punctuation against the bare URL', () => {
  const reply = 'File it at https://github.com/swampratnz/community-agent/issues.';
  assert.deepEqual(checkCitedUrls(reply, 'https://github.com/swampratnz/community-agent/issues'), []);
});
