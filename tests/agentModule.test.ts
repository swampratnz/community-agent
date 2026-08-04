import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * The module manifest and its composition (agent-base package flip).
 *
 * `src/module/agentModule.ts` is the ONE place this deployment declares what it
 * fills, and `createAgent` is what turns that declaration into registrations,
 * in a fixed order, with a plan pass and a readiness probe either side. Before
 * the flip the same surface was a load-bearing list of side-effect imports in
 * `src/index.ts`, where a forgotten line surfaced as a blank notice in front of
 * a member rather than as a boot failure.
 *
 * What is worth pinning HERE (agent-base tests the mechanism itself):
 *
 *  - the composition is COMPLETE — `planComposition` accepts this manifest, so
 *    every required registry has a claimant. That is the regression guard for
 *    "someone exported a new content value and forgot to name it";
 *  - `init()` refuses a deployment whose display settings are not NZ, because
 *    the framework's defaults (UTC/en-GB) would otherwise silently re-render
 *    every member-facing event time;
 *  - the manifest supplies its own schema fragments rather than relying on the
 *    package to ship them.
 *
 * Deliberately does NOT call `createAgent()`: registration is once per process
 * and several other suites register slices of the same surface. `planComposition`
 * is the pure half, which is exactly what this file wants.
 */
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';
process.env.DISPLAY_TIMEZONE = 'Pacific/Auckland';
process.env.DISPLAY_LOCALE = 'en-NZ';

const { planComposition } = await import('@swampratnz/agent-base');
const { nzCommunityModule } = await import('../src/module/agentModule.js');

test('the community manifest is a complete composition on its own — every required registry has a claimant', () => {
  // Throws, naming each gap, if a once-per-process registry is claimed twice or
  // left unclaimed. A new content value that never made it into the manifest
  // fails here rather than at first use.
  planComposition([nzCommunityModule]);
});

test('the manifest claims every extension point this deployment fills', () => {
  // Spelled out rather than derived, so REMOVING one is a deliberate edit here
  // too — a silently dropped field would otherwise just narrow the surface.
  for (const field of [
    'notices',
    'toolTiers',
    'toolServerParts',
    'flaggedToolPredicates',
    'skills',
    'promptSections',
    'commands',
    'defaultBadWords',
    'personas',
    'turnStateFinalizers',
    'policyKeys',
    'migrations',
  ] as const) {
    assert.notEqual(nzCommunityModule[field], undefined, `manifest is missing '${field}'`);
  }
  assert.equal(nzCommunityModule.name, 'nz-claude-community');
});

test('the manifest contributes this deployment’s own schema fragments (base ships its own, this module ships the rest)', () => {
  const fragments = nzCommunityModule.migrations ?? [];
  assert.ok(fragments.length > 0, 'a module that adds constraints must contribute them');
  for (const fragment of fragments) {
    assert.match(fragment.name, /^nz-community\//, 'fragment names are attributable in a failed migration');
    assert.ok(fragment.sql.trim().length > 0, `${fragment.name} is empty`);
  }
});

test('SECURITY: init() refuses to boot when the display settings are not this deployment’s — a missing env var must not silently re-render times in UTC', () => {
  // The failure mode being guarded: agent-base defaults DISPLAY_TIMEZONE to
  // UTC, so an unset var renders every member-facing event time hours wrong,
  // with nothing in a test or a log to show for it. A refused boot is the loud
  // alternative. `init()` reads the config singleton, which parses once per
  // process at import time, so each case runs in its own child.
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const runWith = (display: Record<string, string>) =>
    spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'tests/fixtures/moduleInit.ts'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: 'test-token',
        DISCORD_BOT_TOKEN: 'test-token',
        DISCORD_GUILD_ID: '1',
        DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test',
        WHATSAPP_PROVIDER: 'disabled',
        ...display,
      },
    });

  const ok = runWith({ DISPLAY_TIMEZONE: 'Pacific/Auckland', DISPLAY_LOCALE: 'en-NZ' });
  assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`);
  assert.match(ok.stdout, /OK/);

  // The framework defaults, i.e. exactly what an operator who never set the
  // vars would get.
  const defaults = runWith({ DISPLAY_TIMEZONE: 'UTC', DISPLAY_LOCALE: 'en-GB' });
  assert.notEqual(defaults.status, 0, 'UTC/en-GB must fail startup, not be silently accepted');
  assert.match(`${defaults.stdout}${defaults.stderr}`, /DISPLAY_TIMEZONE must be 'Pacific\/Auckland'/);

  // One wrong half is still wrong.
  const halfWrong = runWith({ DISPLAY_TIMEZONE: 'Pacific/Auckland', DISPLAY_LOCALE: 'en-GB' });
  assert.notEqual(halfWrong.status, 0);
  assert.match(`${halfWrong.stdout}${halfWrong.stderr}`, /DISPLAY_LOCALE must be 'en-NZ'/);
});
