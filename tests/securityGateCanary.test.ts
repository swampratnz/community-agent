import { test } from 'node:test';
import assert from 'node:assert/strict';

// Canary for issue #109: check-security-test-count.mjs used to hardcode its
// own node:test runner flags, separately from the "test" script in
// package.json. The two drifted apart when --experimental-test-module-mocks
// was added to `npm test` for #93 but not to the security gate's spawn — the
// first SECURITY: test using t.mock.module would have crashed in the gate
// while passing in `npm test`. This test exercises t.mock.module so any
// future re-drift (a flag added to one runner but not the other) fails this
// SECURITY: test loudly in whichever command lacks it, instead of lying in
// wait. Mocking a throwaway fixture module, rather than a real one, keeps
// this test's only purpose being to pin the runner flags, not any behaviour.
test("SECURITY: t.mock.module works under this repo's node:test runner flags (module-mocks canary)", async (t) => {
  t.mock.module('./fixtures/canaryModule.js', {
    namedExports: {
      canaryValue: () => 'mocked',
    },
  });

  const { canaryValue } = await import('./fixtures/canaryModule.js');
  assert.equal(canaryValue(), 'mocked', 't.mock.module should replace the named export');
});
