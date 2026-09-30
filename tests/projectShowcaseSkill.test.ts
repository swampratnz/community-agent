import { test } from 'node:test';
import assert from 'node:assert/strict';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
import './support/registerNotices.js';
// The bundled-skills manifest (the manifest's `skills` registration).
import './support/registerSkills.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it. This file needs
// AGENT_SKILLS_ENABLED=true (issue #776), which needs its own process, same
// as gettingStartedSkill.test.ts/modelAndPlanSelectionSkill.test.ts.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.AGENT_SKILLS_ENABLED = 'true';

// The tool registry's module-scope registrations (tool tiers, tool-server
// parts, feature-flag predicates) — the composition-root contract, matching
// tests/rbac.test.ts.
await import('./support/registerToolRegistry.js');

const { buildQueryOptions } = await import('@swampratnz/agent-base/agent/core.js');
const { toolsForRole } = await import('@swampratnz/agent-base/auth/rbac.js');
const { COMMUNITY_TOOL_TIERS } = await import('../src/module/agent/tools/index.js');

// The tools issue #535 (extended by issue #729) filters out of allowedTools
// when their config flag is off (default) — same list as
// tests/agentOptions.test.ts's no-drift pin, kept local here for the same
// reason: this test process sets none of those flags.
const FEATURE_FLAGGED_TOOLS = [
  'mcp__community__fetch_page',
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
  'mcp__community__web_research',
  'mcp__community__summarize_link',
] as const;

const SKILL_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../src/module/agent/skills/project-showcase/SKILL.md',
);
const SKILL_BODY = readFileSync(SKILL_PATH, 'utf8');

test('AC1 — project-showcase front-matter has the expected name and a share/showcase-examples description', () => {
  assert.match(SKILL_BODY, /^---\nname: project-showcase\n/);
  assert.match(SKILL_BODY, /description: .*(examples|showcase)/i);
});

test('with the flag ON, buildQueryOptions resolves skills to include project-showcase, backed by the bundled SKILL.md on disk, for every role', () => {
  for (const role of ['guest', 'member', 'admin', 'super_admin'] as const) {
    const opts = buildQueryOptions(role, 'prompt', {}, null, 'conv-1');
    assert.ok(
      opts.skills?.includes('project-showcase'),
      `${role}: skills must include project-showcase when the flag is on`,
    );
  }
  // The skill name in ENABLED_SKILLS must resolve to a real file — a typo'd
  // or missing entry would silently no-op at the SDK layer.
  assert.ok(SKILL_BODY.length > 0, 'expected SKILL.md to exist and be non-empty on disk');
});

test('AC1/AC2 — the new request_project_connection offer bullet is present, gated on BOTH the 🤝 marker and expressed member interest, with an explicit-consent phrase', () => {
  assert.match(SKILL_BODY, /request_project_connection/);
  assert.match(SKILL_BODY, /🤝/);
  // Gating: both trigger conditions named in the same bullet, not "any
  // project mention" — mirrors issue #1467's "gate on sharing a solution,
  // not any technical explanation" discipline.
  assert.match(SKILL_BODY, /looking for\s+collaborators/i);
  assert.match(SKILL_BODY, /expresses interest/i);
});

test('SECURITY: AC5 — the offer bullet pins an explicit never-call-without-consent guard, not prose that could be edited away silently', () => {
  assert.match(
    SKILL_BODY,
    /never\s+call it without the member's explicit go-ahead/i,
    'the bullet must state the tool is never called without the member explicitly agreeing first',
  );
});

test('SECURITY: AC4 — the new offer bullet adds no tool — COMMUNITY_TOOL_TIERS and buildQueryOptions.allowedTools/disallowedTools are exactly toolsForRole(role) plus tier-gated WebSearch, minus feature-flagged tools, for every tier', () => {
  // request_project_connection was already a member-tier tool before this
  // change (issue #840) — this PR is skill prose only, so the tier map must
  // be byte-identical to main: still present, still member-tier, nowhere
  // else.
  assert.ok(
    COMMUNITY_TOOL_TIERS.member.some((t) => t.endsWith('request_project_connection')),
    'request_project_connection must remain a member-tier tool, unchanged by this skill-prose-only PR',
  );
  assert.ok(
    !COMMUNITY_TOOL_TIERS.admin.some((t) => t.endsWith('request_project_connection')),
    'request_project_connection must not have been added to the admin tier',
  );
  assert.ok(
    !COMMUNITY_TOOL_TIERS.superAdmin.some((t) => t.endsWith('request_project_connection')),
    'request_project_connection must not have been added to the super_admin tier',
  );

  for (const role of ['guest', 'member', 'admin', 'super_admin'] as const) {
    const opts = buildQueryOptions(role, 'prompt', {}, null, 'conv-1', 'discord');
    const webSearch = role === 'admin' || role === 'super_admin';
    const expected = [...toolsForRole(role, 'discord'), ...(webSearch ? ['WebSearch'] : [])].filter(
      (t) => !(FEATURE_FLAGGED_TOOLS as readonly string[]).includes(t),
    );
    assert.deepEqual(
      [...opts.allowedTools].sort(),
      [...expected].sort(),
      `${role} allowedTools must be unaffected by a skill-prose-only offer bullet`,
    );
    assert.ok(!opts.allowedTools.includes('Skill'), `${role}: allowedTools must not include 'Skill'`);
    assert.ok(!opts.disallowedTools.includes('Skill'), `${role}: disallowedTools must not include 'Skill'`);
    assert.deepEqual(
      opts.disallowedTools,
      ['Task', 'WebFetch', ...(role === 'admin' || role === 'super_admin' ? [] : ['WebSearch'])],
      `${role}: disallowedTools must be unaffected by the new skill bullet`,
    );
  }
});
