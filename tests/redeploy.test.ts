import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REDEPLOY_ARGS, REDEPLOY_COMMAND, triggerRedeploy } from '../src/agent/redeploy.js';

test('SECURITY: triggerRedeploy runs only the fixed, non-configurable argv — nothing is interpolated into it', async () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  await triggerRedeploy(async (command, args) => {
    calls.push({ command, args });
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, REDEPLOY_COMMAND);
  assert.deepEqual(calls[0].args, REDEPLOY_ARGS);
  // The fixed argv itself: non-interactive sudo (never prompts/hangs),
  // no-block start (returns before the unit's own restart of
  // community-agent.service could tear down this call's process), the
  // exact flock-guarded unit the nightly timer also uses.
  assert.deepEqual(REDEPLOY_ARGS, [
    '-n',
    'systemctl',
    'start',
    '--no-block',
    'community-agent-redeploy.service',
  ]);
});

test('triggerRedeploy resolves with a status message on success', async () => {
  const result = await triggerRedeploy(async () => {});
  assert.match(result, /journalctl -u community-agent-redeploy/);
});

test('SECURITY: triggerRedeploy fails clearly and promptly (never hangs) when the runner rejects — e.g. the sudoers grant is absent', async () => {
  const runner = async () => {
    throw new Error('sudo: a password is required');
  };

  await assert.rejects(
    () =>
      Promise.race([
        triggerRedeploy(runner),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timed out — triggerRedeploy hung')), 1000),
        ),
      ]),
    /Could not start the redeploy unit/,
  );
});
