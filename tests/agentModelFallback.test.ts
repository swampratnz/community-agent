import { test } from 'node:test';
import assert from 'node:assert/strict';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
import '../src/module/strings/notices.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/agentModelTiering.test.ts. AGENT_MODEL_FALLBACK must be
// set BEFORE config.js is first imported in this process (it resolves once,
// at import time), so this scenario needs its own file rather than reusing
// tests/agentOptions.test.ts (which asserts the unset/default baseline).
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
// Comma-separated, per the SDK's own accepted shape for Options.fallbackModel
// — this repo does no parsing of it, just forwards the string unchanged.
process.env.AGENT_MODEL_FALLBACK = 'claude-haiku-4-5-20251001,claude-sonnet-5';

// The tool registry's module-scope registrations (tool tiers, tool-server
// parts, feature-flag predicates) — the composition-root contract, matching
// tests/rbac.test.ts.
await import('../src/module/agent/tools/index.js');

const { config } = await import('../src/base/config.js');
const { buildQueryOptions } = await import('../src/base/agent/core.js');
const { toolsForRole } = await import('../src/base/auth/rbac.js');

// Same feature-flagged set as tests/agentOptions.test.ts — this process also
// leaves IMAGE_GEN_ENABLED/GITHUB_ISSUE_ENABLED/DEV_TEAM_ENABLED/
// FIND_HELPER_ENABLED unset (default off), so buildQueryOptions drops these
// from allowedTools too (issue #535, extended by issue #729).
const FEATURE_FLAGGED_TOOLS = [
  'mcp__community__generate_image',
  'mcp__community__suggest_issue',
  'mcp__community__dev_team_dispatch',
  'mcp__community__dev_team_status',
  'mcp__community__dev_team_result',
  'mcp__community__dev_team_backlog',
  'mcp__community__dev_team_findings',
  'mcp__community__dev_team_verify',
  'mcp__community__set_helper_availability',
  'mcp__community__find_helper',
] as const;

test('config: AGENT_MODEL_FALLBACK set resolves to config.llm.fallbackModel (issue #738)', () => {
  assert.equal(config.llm.fallbackModel, 'claude-haiku-4-5-20251001,claude-sonnet-5');
});

test('AGENT_MODEL_FALLBACK set: buildQueryOptions.fallbackModel equals the exact configured string, for every role (issue #738)', () => {
  for (const role of ['guest', 'member', 'admin', 'super_admin'] as const) {
    assert.equal(
      buildQueryOptions(role, 'prompt', {}, null, 'conv-1').fallbackModel,
      config.llm.fallbackModel,
      `${role} must resolve fallbackModel to config.llm.fallbackModel, unchanged`,
    );
  }
});

test('SECURITY: AGENT_MODEL_FALLBACK set ⇒ tools/allowedTools/disallowedTools/permissionMode/maxTurns are byte-identical to the unset baseline, for every role (issue #738)', () => {
  for (const role of ['guest', 'member', 'admin', 'super_admin'] as const) {
    const opts = buildQueryOptions(role, 'prompt', {}, null, 'conv-1');
    const webSearch = role === 'admin' || role === 'super_admin';
    assert.deepEqual(opts.tools, webSearch ? ['WebSearch'] : []);
    const expected = [...toolsForRole(role), ...(webSearch ? ['WebSearch'] : [])].filter(
      (t) => !(FEATURE_FLAGGED_TOOLS as readonly string[]).includes(t),
    );
    assert.deepEqual([...opts.allowedTools].sort(), [...expected].sort());
    assert.ok(opts.disallowedTools.includes('Task'));
    assert.ok(opts.disallowedTools.includes('WebFetch'));
    assert.equal(opts.disallowedTools.includes('WebSearch'), !webSearch);
    assert.equal(opts.permissionMode, 'default');
    assert.equal(
      opts.maxTurns,
      atLeastAdmin(role) ? config.llm.maxTurns : config.llm.memberMaxTurns,
      `${role} maxTurns must be unaffected by the fallback-model knob`,
    );
  }
});

function atLeastAdmin(role: 'guest' | 'member' | 'admin' | 'super_admin'): boolean {
  return role === 'admin' || role === 'super_admin';
}
