import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentOptions.test.ts. GITHUB_ISSUE_ENABLED must be set
// (with a token, which the config refine requires) BEFORE config.js is first
// imported in this process, so this scenario needs its own file/process
// (issue #535 acceptance criterion 2).
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.GITHUB_ISSUE_ENABLED ??= 'true';
process.env.GITHUB_ISSUE_TOKEN ??= 'ghp_testtoken';

const { config } = await import('../src/config.js');
const { buildQueryOptions } = await import('../src/agent/core.js');
const { toolsForRole } = await import('../src/auth/rbac.js');

test('issue #535 acceptance criterion 2 — GITHUB_ISSUE_ENABLED=true (others default): suggest_issue is present and allowedTools is byte-identical to pre-#535 toolsForRole for the eligible tier/platform', () => {
  assert.equal(config.github.enabled, true, 'precondition: github-issue is on in this test process');
  assert.equal(config.imageGen.enabled, false, 'precondition: image-gen stays off (default) in this process');
  assert.equal(config.devTeam.enabled, false, 'precondition: dev-team stays off (default) in this process');
  const opts = buildQueryOptions('super_admin', 'prompt', {}, null, 'conv-1', 'discord');
  assert.ok(opts.allowedTools.includes('mcp__community__suggest_issue'));
  const expected = [...toolsForRole('super_admin', 'discord'), 'WebSearch'].filter(
    (t) =>
      ![
        'mcp__community__generate_image',
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
    'super_admin allowedTools with GITHUB_ISSUE_ENABLED=true must equal the pre-#535 toolsForRole list, ' +
      'minus the still-disabled image-gen/dev-team tools',
  );
});
