import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it. This file's whole
// point is the AGENT_SKILLS_ENABLED=true path (issue #741), which needs its
// own process: config is read once at import time and can't be toggled
// mid-process, so the flag-off invariant lives in agentOptions.test.ts
// instead.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.AGENT_SKILLS_ENABLED = 'true';

const { buildQueryOptions } = await import('../src/agent/core.js');
const { buildSystemPrompt } = await import('../src/agent/systemPrompt.js');
const { config } = await import('../src/config.js');

const caller = {
  platform: 'discord' as const,
  userId: 'u1',
  userName: 'Chris',
  conversationId: 'chan1',
};

const STANDARD_POLICY = {
  codeAnswers: 'snippets' as const,
  responseStyle: 'standard' as const,
  languagePreference: 'auto' as const,
};

test('precondition: AGENT_SKILLS_ENABLED is on in this test process', () => {
  assert.equal(config.agentSkills.enabled, true);
});

test('SECURITY: AC2 — AGENT_SKILLS_ENABLED=true adds Skill to tools and loads exactly the bundled skills, for every role (no tier gating)', () => {
  for (const role of ['guest', 'member', 'admin', 'super_admin'] as const) {
    const opts = buildQueryOptions(role, 'prompt', {}, null, 'conv-1');
    assert.ok(opts.tools.includes('Skill'), `${role}: tools must include Skill when the flag is on`);
    assert.equal(opts.plugins?.length, 1, `${role}: plugins must be exactly one entry`);
    assert.equal(opts.plugins?.[0]?.type, 'local', `${role}: the one plugin entry must be type 'local'`);
    assert.match(
      opts.plugins?.[0]?.path ?? '',
      /[/\\]agent[/\\]skills$/,
      `${role}: plugin path must point at the bundled agent/skills directory`,
    );
    assert.deepEqual(
      opts.skills,
      ['prompt-review', 'project-showcase', 'claude-code-setup'],
      `${role}: skills must be exactly ['prompt-review', 'project-showcase', 'claude-code-setup']`,
    );
  }
});

test("SECURITY: AC6 — skills is always the literal array ['prompt-review', 'project-showcase', 'claude-code-setup'] — never 'all', never derived from any input", () => {
  for (const role of ['guest', 'member', 'admin', 'super_admin'] as const) {
    const opts = buildQueryOptions(role, 'prompt', {}, null, 'conv-1');
    assert.deepEqual(opts.skills, ['prompt-review', 'project-showcase', 'claude-code-setup']);
    assert.notEqual(opts.skills, 'all');
  }
});

test("SECURITY: issue #757 — claude-code-setup resolves to the bundled SKILL.md and changes no role's disallowedTools", () => {
  const skillPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '../src/agent/skills/claude-code-setup/SKILL.md',
  );
  const body = readFileSync(skillPath, 'utf8');
  assert.match(
    body,
    /^---\nname: claude-code-setup\n/,
    'SKILL.md must carry valid claude-code-setup front-matter',
  );
  for (const role of ['guest', 'member', 'admin', 'super_admin'] as const) {
    const opts = buildQueryOptions(role, 'prompt', {}, null, 'conv-1');
    assert.ok(
      opts.skills?.includes('claude-code-setup'),
      `${role}: skills must include claude-code-setup when the flag is on`,
    );
    const webSearch = role === 'admin' || role === 'super_admin';
    assert.deepEqual(
      opts.disallowedTools,
      ['Task', 'WebFetch', ...(webSearch ? [] : ['WebSearch'])],
      `${role}: disallowedTools must be unaffected by adding claude-code-setup to ENABLED_SKILLS`,
    );
  }
});

test('SECURITY: AC7 — enabling AGENT_SKILLS_ENABLED grants no tier Read, Bash, Glob, or Grep', () => {
  const FORBIDDEN = ['Read', 'Bash', 'Glob', 'Grep'];
  for (const role of ['guest', 'member', 'admin', 'super_admin'] as const) {
    const opts = buildQueryOptions(role, 'prompt', {}, null, 'conv-1');
    for (const t of FORBIDDEN) {
      assert.ok(!opts.tools.includes(t), `${role}: tools must not include ${t}`);
      assert.ok(!opts.allowedTools.includes(t), `${role}: allowedTools must not include ${t}`);
    }
  }
});

test('flag on: the assembled system prompt no longer contains the prompt-review checklist text — the skill replaces it, never duplicates it', () => {
  for (const role of ['guest', 'member', 'admin', 'super_admin'] as const) {
    const prompt = buildSystemPrompt({ ...caller, role }, STANDARD_POLICY);
    assert.doesNotMatch(
      prompt,
      /Reviewing a member's own prompt\/system prompt\/tool schema/,
      `${role}: checklist text must be absent from GUIDELINES when the skill is active`,
    );
  }
});

// Mirrors agentOptions.test.ts's FEATURE_FLAGGED_TOOLS: this test process
// never sets IMAGE_GEN_ENABLED/GITHUB_ISSUE_ENABLED/DEV_TEAM_ENABLED/
// FIND_HELPER_ENABLED, so those tools are dropped from allowedTools
// regardless of AGENT_SKILLS_ENABLED — unrelated to this issue, just the
// pre-existing #535 feature-flag filter this test must account for too.
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

test('SECURITY: enabling the flag does not alter allowedTools beyond the base tools array — no new MCP tool surface', async () => {
  const { toolsForRole } = await import('../src/auth/rbac.js');
  for (const role of ['guest', 'member', 'admin', 'super_admin'] as const) {
    const opts = buildQueryOptions(role, 'prompt', {}, null, 'conv-1', 'discord');
    const webSearch = role === 'admin' || role === 'super_admin';
    const expected = [...toolsForRole(role, 'discord'), ...(webSearch ? ['WebSearch'] : [])].filter(
      (t) => !(FEATURE_FLAGGED_TOOLS as readonly string[]).includes(t),
    );
    assert.deepEqual(
      [...opts.allowedTools].sort(),
      [...expected].sort(),
      `${role}: allowedTools must be unaffected by AGENT_SKILLS_ENABLED — 'Skill' is not added there`,
    );
  }
});

// Guards the "is omitting 'Skill' from allowedTools a bug?" review question
// (issue #741 PR review) with evidence rather than assertion: the installed
// SDK's own type declarations document that the `skills` option is a
// self-sufficient pre-approval path and that passing 'Skill' into
// `allowedTools` directly is deprecated. This test pins that exact documented
// contract against the vendored .d.ts, so an SDK upgrade that silently drops
// or narrows the guarantee fails CI here instead of shipping a Skill tool
// that's granted in `tools` but never actually approved to fire.
test('SECURITY: AC8 — the installed SDK still documents that skills pre-approves Skill without needing it in allowedTools', () => {
  const sdkDtsPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '../node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts',
  );
  const dts = readFileSync(sdkDtsPath, 'utf8');
  assert.match(
    dts,
    /you do not need to add `'Skill'` to `allowedTools` yourself\s*\n\s*\* when using this option/,
    "the SDK's Options.skills doc must still state that allowedTools does not need 'Skill' added — if this text changed, re-verify the allowedTools omission above is still safe before merging an SDK bump",
  );
  assert.match(
    dts,
    /Note: passing `'Skill'` here is deprecated — use the `skills` option instead\./,
    "the SDK's Options.allowedTools doc must still mark passing 'Skill' there as deprecated",
  );
});

// AC5 — the bundled skill plugin directory can load nothing beyond the one
// static skill: no hooks/, agents/, commands/, or .mcp.json anywhere in it.

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

test('SECURITY: AC5 — the bundled skill plugin directory contains no hooks/, agents/, commands/, or .mcp.json path', () => {
  const skillsDir = join(dirname(fileURLToPath(import.meta.url)), '../src/agent/skills');
  const files = listFilesRecursive(skillsDir);
  for (const f of files) {
    assert.doesNotMatch(
      f,
      /[/\\](hooks|agents|commands)[/\\]/,
      `${f}: must not sit under a hooks/agents/commands directory`,
    );
    assert.doesNotMatch(f, /\.mcp\.json$/, `${f}: must not be an .mcp.json file`);
  }
  // Sanity: the walk actually found the files these proposals ship, so an
  // empty/misconfigured directory can't pass this test vacuously.
  assert.ok(
    files.some((f) => f.endsWith('plugin.json')),
    'expected the plugin manifest to be present',
  );
  assert.ok(
    files.some((f) => f.endsWith(join('prompt-review', 'SKILL.md'))),
    'expected prompt-review/SKILL.md to be present',
  );
  assert.ok(
    files.some((f) => f.endsWith(join('project-showcase', 'SKILL.md'))),
    'expected project-showcase/SKILL.md to be present',
  );
  assert.ok(
    files.some((f) => f.endsWith(join('claude-code-setup', 'SKILL.md'))),
    'expected claude-code-setup/SKILL.md to be present',
  );
});
