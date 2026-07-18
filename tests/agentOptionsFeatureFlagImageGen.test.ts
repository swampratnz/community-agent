import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentOptions.test.ts. IMAGE_GEN_ENABLED must be set
// BEFORE config.js is first imported in this process (it resolves once, at
// import time), so this scenario needs its own file/process rather than
// reusing tests/agentOptions.test.ts (which asserts the unset/default
// baseline for all three flags) — issue #535 acceptance criterion 2.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.IMAGE_GEN_ENABLED ??= 'true';
process.env.GROK_BIN ??= '/usr/bin/grok';

const { config } = await import('../src/config.js');
const { buildQueryOptions } = await import('../src/agent/core.js');
const { toolsForRole } = await import('../src/auth/rbac.js');

test('issue #535 acceptance criterion 2 — IMAGE_GEN_ENABLED=true (others default): generate_image is present and allowedTools is byte-identical to pre-#535 toolsForRole for the eligible tier/platform', () => {
  assert.equal(config.imageGen.enabled, true, 'precondition: image-gen is on in this test process');
  assert.equal(
    config.github.enabled,
    false,
    'precondition: github-issue stays off (default) in this process',
  );
  assert.equal(config.devTeam.enabled, false, 'precondition: dev-team stays off (default) in this process');
  for (const role of ['admin', 'super_admin'] as const) {
    const opts = buildQueryOptions(role, 'prompt', {}, null, 'conv-1', 'discord');
    assert.ok(opts.allowedTools.includes('mcp__community__generate_image'));
    const expected = [...toolsForRole(role, 'discord'), 'WebSearch'].filter(
      (t) =>
        ![
          'mcp__community__suggest_issue',
          'mcp__community__dev_team_dispatch',
          'mcp__community__dev_team_status',
          'mcp__community__dev_team_result',
          'mcp__community__dev_team_backlog',
          'mcp__community__dev_team_findings',
          'mcp__community__dev_team_verify',
        ].includes(t),
    );
    assert.deepEqual(
      [...opts.allowedTools].sort(),
      [...expected].sort(),
      `${role} allowedTools with IMAGE_GEN_ENABLED=true must equal the pre-#535 toolsForRole(${role}) list, ` +
        'minus the still-disabled github/dev-team tools',
    );
  }
});
