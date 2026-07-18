import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentOptions.test.ts. DEV_TEAM_ENABLED must be set
// (with an endpoint + token, which the config refine requires) BEFORE
// config.js is first imported in this process, so this scenario needs its
// own file/process (issue #535 acceptance criterion 2).
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.DEV_TEAM_ENABLED ??= 'true';
process.env.DEV_TEAM_ENDPOINT_URL ??= 'http://ubuntudevagent:8738';
process.env.DEV_TEAM_AUTH_TOKEN ??= 'dev-team-secret-token';

const { config } = await import('../src/config.js');
const { buildQueryOptions } = await import('../src/agent/core.js');
const { toolsForRole } = await import('../src/auth/rbac.js');

const DEV_TEAM_TOOLS = [
  'mcp__community__dev_team_dispatch',
  'mcp__community__dev_team_status',
  'mcp__community__dev_team_result',
  'mcp__community__dev_team_backlog',
  'mcp__community__dev_team_findings',
  'mcp__community__dev_team_verify',
];

test('issue #535 acceptance criterion 2 — DEV_TEAM_ENABLED=true (others default): all 6 dev_team_* tools are present and allowedTools is byte-identical to pre-#535 toolsForRole for the eligible tier/platform', () => {
  assert.equal(config.devTeam.enabled, true, 'precondition: dev-team is on in this test process');
  assert.equal(config.imageGen.enabled, false, 'precondition: image-gen stays off (default) in this process');
  assert.equal(
    config.github.enabled,
    false,
    'precondition: github-issue stays off (default) in this process',
  );
  const opts = buildQueryOptions('super_admin', 'prompt', {}, null, 'conv-1', 'discord');
  for (const t of DEV_TEAM_TOOLS) {
    assert.ok(opts.allowedTools.includes(t), `${t} must be present when DEV_TEAM_ENABLED=true`);
  }
  const expected = [...toolsForRole('super_admin', 'discord'), 'WebSearch'].filter(
    (t) => !['mcp__community__generate_image', 'mcp__community__suggest_issue'].includes(t),
  );
  assert.deepEqual(
    [...opts.allowedTools].sort(),
    [...expected].sort(),
    'super_admin allowedTools with DEV_TEAM_ENABLED=true must equal the pre-#535 toolsForRole list, ' +
      'minus the still-disabled image-gen/github-issue tools',
  );
});
