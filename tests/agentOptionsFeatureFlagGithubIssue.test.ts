import { test } from 'node:test';
import assert from 'node:assert/strict';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
import './support/registerNotices.js';

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

// The tool registry's module-scope registrations (tool tiers, tool-server
// parts, feature-flag predicates) — the composition-root contract, matching
// tests/rbac.test.ts.
await import('./support/registerToolRegistry.js');

const { config } = await import('@swampratnz/agent-base/config.js');
const { buildQueryOptions } = await import('@swampratnz/agent-base/agent/core.js');
const { toolsForRole } = await import('@swampratnz/agent-base/auth/rbac.js');

test('issue #535 acceptance criterion 2 — GITHUB_ISSUE_ENABLED=true (others default): suggest_issue is present and allowedTools is byte-identical to pre-#535 toolsForRole for the eligible tier/platform', () => {
  assert.equal(config.github.enabled, true, 'precondition: github-issue is on in this test process');
  assert.equal(config.imageGen.enabled, false, 'precondition: image-gen stays off (default) in this process');
  assert.equal(config.devTeam.enabled, false, 'precondition: dev-team stays off (default) in this process');
  const opts = buildQueryOptions('super_admin', 'prompt', {}, null, 'conv-1', 'discord');
  assert.ok(opts.allowedTools.includes('mcp__community__suggest_issue'));
  const expected = [...toolsForRole('super_admin', 'discord'), 'WebSearch'].filter(
    (t) =>
      ![
        'mcp__community__fetch_page',
        'mcp__community__generate_image',
        'mcp__community__dev_team_dispatch',
        'mcp__community__dev_team_status',
        'mcp__community__dev_team_result',
        'mcp__community__dev_team_backlog',
        'mcp__community__dev_team_findings',
        'mcp__community__dev_team_verify',
        'mcp__community__set_helper_availability',
        'mcp__community__find_helper',
      ].includes(t),
  );
  assert.deepEqual(
    [...opts.allowedTools].sort(),
    [...expected].sort(),
    'super_admin allowedTools with GITHUB_ISSUE_ENABLED=true must equal the pre-#535 toolsForRole list, ' +
      'minus the still-disabled image-gen/dev-team/find-helper tools',
  );
});
