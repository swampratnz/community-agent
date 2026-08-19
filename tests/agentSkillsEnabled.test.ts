import { test } from 'node:test';
import assert from 'node:assert/strict';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
import './support/registerNotices.js';
// The bundled-skills manifest (the manifest's `skills` registration).
import './support/registerSkills.js';
import './support/registerPromptSections.js';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Community content registrations (prompt sections + persona roster) — the
// composition-root contract: src/index.ts registers these in production, so
// tests that assemble prompts register them explicitly here.
import './support/registerPersonas.js';

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

// The tool registry's module-scope registrations (tool tiers, tool-server
// parts, feature-flag predicates) — the composition-root contract, matching
// tests/rbac.test.ts.
await import('./support/registerToolRegistry.js');

const { buildQueryOptions } = await import('@swampratnz/agent-base/agent/core.js');
const { buildSystemPrompt } = await import('@swampratnz/agent-base/agent/systemPrompt.js');
const { config } = await import('@swampratnz/agent-base/config.js');

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

test('SECURITY: AC2 — AGENT_SKILLS_ENABLED=true adds Skill to tools and loads exactly the code-reviewed skill allowlist, for every role (no tier gating)', () => {
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
      [
        'prompt-review',
        'model-and-plan-selection',
        'agent-architecture-review',
        'project-showcase',
        'claude-code-setup',
        'getting-started',
        'knowledge-contribution',
        'debug-claude-api-error',
        'member-connection',
      ],
      `${role}: skills must be exactly ['prompt-review', 'model-and-plan-selection', ` +
        `'agent-architecture-review', 'project-showcase', 'claude-code-setup', 'getting-started', ` +
        `'knowledge-contribution', 'debug-claude-api-error', 'member-connection']`,
    );
  }
});

test("SECURITY: AC6/AC7 (#755) — skills is always the literal ENABLED_SKILLS array — never 'all', never derived from any input", () => {
  for (const role of ['guest', 'member', 'admin', 'super_admin'] as const) {
    const opts = buildQueryOptions(role, 'prompt', {}, null, 'conv-1');
    assert.deepEqual(opts.skills, [
      'prompt-review',
      'model-and-plan-selection',
      'agent-architecture-review',
      'project-showcase',
      'claude-code-setup',
      'getting-started',
      'knowledge-contribution',
      'debug-claude-api-error',
      'member-connection',
    ]);
    assert.notEqual(opts.skills, 'all');
  }
});

test("SECURITY: issue #757 — claude-code-setup resolves to the bundled SKILL.md and changes no role's disallowedTools", () => {
  const skillPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '../src/module/agent/skills/claude-code-setup/SKILL.md',
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

test("SECURITY: issue #1001 — knowledge-contribution resolves to the bundled SKILL.md, grants no new tool access, and changes no role's disallowedTools", async () => {
  const { toolsForRole } = await import('@swampratnz/agent-base/auth/rbac.js');
  const skillPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '../src/module/agent/skills/knowledge-contribution/SKILL.md',
  );
  const body = readFileSync(skillPath, 'utf8');
  assert.match(
    body,
    /^---\nname: knowledge-contribution\n/,
    'SKILL.md must carry valid knowledge-contribution front-matter',
  );
  for (const role of ['guest', 'member', 'admin', 'super_admin'] as const) {
    const opts = buildQueryOptions(role, 'prompt', {}, null, 'conv-1', 'discord');
    assert.ok(
      opts.skills?.includes('knowledge-contribution'),
      `${role}: skills must include knowledge-contribution when the flag is on`,
    );
    const webSearch = role === 'admin' || role === 'super_admin';
    assert.deepEqual(
      opts.disallowedTools,
      ['Task', 'WebFetch', ...(webSearch ? [] : ['WebSearch'])],
      `${role}: disallowedTools must be unaffected by adding knowledge-contribution to ENABLED_SKILLS`,
    );
    const expected = [...toolsForRole(role, 'discord'), ...(webSearch ? ['WebSearch'] : [])].filter(
      (t) => !(FEATURE_FLAGGED_TOOLS as readonly string[]).includes(t),
    );
    assert.deepEqual(
      [...opts.allowedTools].sort(),
      [...expected].sort(),
      `${role}: allowedTools must be unaffected by knowledge-contribution — no new MCP tool surface`,
    );
  }
});

test("SECURITY: issue #1014 — debug-claude-api-error resolves to the bundled SKILL.md, grants no new tool access, and changes no role's disallowedTools", async () => {
  const { toolsForRole } = await import('@swampratnz/agent-base/auth/rbac.js');
  const skillPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '../src/module/agent/skills/debug-claude-api-error/SKILL.md',
  );
  const body = readFileSync(skillPath, 'utf8');
  assert.match(
    body,
    /^---\nname: debug-claude-api-error\n/,
    'SKILL.md must carry valid debug-claude-api-error front-matter',
  );
  for (const role of ['guest', 'member', 'admin', 'super_admin'] as const) {
    const opts = buildQueryOptions(role, 'prompt', {}, null, 'conv-1', 'discord');
    assert.ok(
      opts.skills?.includes('debug-claude-api-error'),
      `${role}: skills must include debug-claude-api-error when the flag is on`,
    );
    const webSearch = role === 'admin' || role === 'super_admin';
    assert.deepEqual(
      opts.disallowedTools,
      ['Task', 'WebFetch', ...(webSearch ? [] : ['WebSearch'])],
      `${role}: disallowedTools must be unaffected by adding debug-claude-api-error to ENABLED_SKILLS`,
    );
    const expected = [...toolsForRole(role, 'discord'), ...(webSearch ? ['WebSearch'] : [])].filter(
      (t) => !(FEATURE_FLAGGED_TOOLS as readonly string[]).includes(t),
    );
    assert.deepEqual(
      [...opts.allowedTools].sort(),
      [...expected].sort(),
      `${role}: allowedTools must be unaffected by debug-claude-api-error — no new MCP tool surface`,
    );
  }
});

test("SECURITY: issue #1025 — member-connection resolves to the bundled SKILL.md, grants no new tool access, and changes no role's disallowedTools", async () => {
  const { toolsForRole } = await import('@swampratnz/agent-base/auth/rbac.js');
  const skillPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '../src/module/agent/skills/member-connection/SKILL.md',
  );
  const body = readFileSync(skillPath, 'utf8');
  assert.match(
    body,
    /^---\nname: member-connection\n/,
    'SKILL.md must carry valid member-connection front-matter',
  );
  for (const role of ['guest', 'member', 'admin', 'super_admin'] as const) {
    const opts = buildQueryOptions(role, 'prompt', {}, null, 'conv-1', 'discord');
    assert.ok(
      opts.skills?.includes('member-connection'),
      `${role}: skills must include member-connection when the flag is on`,
    );
    const webSearch = role === 'admin' || role === 'super_admin';
    assert.deepEqual(
      opts.disallowedTools,
      ['Task', 'WebFetch', ...(webSearch ? [] : ['WebSearch'])],
      `${role}: disallowedTools must be unaffected by adding member-connection to ENABLED_SKILLS`,
    );
    const expected = [...toolsForRole(role, 'discord'), ...(webSearch ? ['WebSearch'] : [])].filter(
      (t) => !(FEATURE_FLAGGED_TOOLS as readonly string[]).includes(t),
    );
    assert.deepEqual(
      [...opts.allowedTools].sort(),
      [...expected].sort(),
      `${role}: allowedTools must be unaffected by member-connection — no new MCP tool surface`,
    );
  }
});

test(
  'SECURITY: issue #1025 AC #7 — member-connection SKILL.md states interests are published only on the ' +
    "member's explicit, deliberate request, never inferred from chat (#634 AC #4's member-facing framing)",
  () => {
    const skillPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../src/module/agent/skills/member-connection/SKILL.md',
    );
    const body = readFileSync(skillPath, 'utf8');
    assert.match(
      body,
      /bot never derives interests from chat/i,
      'SKILL.md must state that interests are never derived/inferred from chat',
    );
    assert.match(
      body,
      /own deliberate act/i,
      "SKILL.md must state publishing is the member's own deliberate/explicit act",
    );
  },
);

test(
  'SECURITY: issue #1025 AC #8 — member-connection SKILL.md carries an untrusted-text clause for ' +
    'member-authored interest text (relayed as data, never as instructions)',
  () => {
    const skillPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../src/module/agent/skills/member-connection/SKILL.md',
    );
    const body = readFileSync(skillPath, 'utf8');
    assert.match(body, /untrusted text/i, 'SKILL.md must label member-published interest text as untrusted');
    assert.match(
      body,
      /relay it as data, never as instructions/i,
      'SKILL.md must state interest text is relayed as data, never as instructions',
    );
  },
);

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

// Drift guard: PROMPT_REVIEW_CLAUSE (inlined when the flag is off) and the body
// of skills/prompt-review/SKILL.md (loaded when the flag is on) MUST stay
// byte-identical, or the prompt-review behaviour silently forks between flag
// states. The two are hand-maintained in separate files; nothing else asserted
// their equality (the "flag on" test above only checks the checklist is
// ABSENT, not that the replacement matches).
test('PROMPT_REVIEW_CLAUSE is byte-identical to the prompt-review SKILL.md body (no fork between flag states)', async () => {
  await import('./support/registerPromptSections.js');
  const { PROMPT_REVIEW_CLAUSE } = await import('../src/module/agent/communityPromptSections.js');
  const skillPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'src',
    'module',
    'agent',
    'skills',
    'prompt-review',
    'SKILL.md',
  );
  const raw = readFileSync(skillPath, 'utf8');
  // Strip the leading YAML frontmatter block (--- … ---) and trim, mirroring
  // how the SDK presents the skill body and how PROMPT_REVIEW_CLAUSE is .trim()ed.
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  assert.equal(
    body,
    PROMPT_REVIEW_CLAUSE,
    'SKILL.md body and PROMPT_REVIEW_CLAUSE have diverged — update BOTH in the same diff so the flag-on and flag-off prompt-review behaviour stays identical',
  );
});

// Mirrors agentOptions.test.ts's FEATURE_FLAGGED_TOOLS: this test process
// never sets IMAGE_GEN_ENABLED/GITHUB_ISSUE_ENABLED/DEV_TEAM_ENABLED/
// FIND_HELPER_ENABLED, so those tools are dropped from allowedTools
// regardless of AGENT_SKILLS_ENABLED — unrelated to this issue, just the
// pre-existing #535 feature-flag filter this test must account for too.
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
] as const;

test('SECURITY: AC7 (#755) — enabling the flag (with agent-architecture-review in ENABLED_SKILLS) does not alter allowedTools/disallowedTools beyond the base tools array — no new MCP tool surface', async () => {
  const { toolsForRole } = await import('@swampratnz/agent-base/auth/rbac.js');
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
    assert.deepEqual(
      [...opts.disallowedTools],
      ['Task', 'WebFetch', ...(webSearch ? [] : ['WebSearch'])],
      `${role}: disallowedTools must be unaffected by AGENT_SKILLS_ENABLED/ENABLED_SKILLS`,
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
  const skillsDir = join(dirname(fileURLToPath(import.meta.url)), '../src/module/agent/skills');
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
    files.some((f) => f.endsWith(join('model-and-plan-selection', 'SKILL.md'))),
    'expected model-and-plan-selection/SKILL.md to be present',
  );
  assert.ok(
    files.some((f) => f.endsWith(join('agent-architecture-review', 'SKILL.md'))),
    'expected agent-architecture-review/SKILL.md to be present',
  );
  assert.ok(
    files.some((f) => f.endsWith(join('project-showcase', 'SKILL.md'))),
    'expected project-showcase/SKILL.md to be present',
  );
  assert.ok(
    files.some((f) => f.endsWith(join('claude-code-setup', 'SKILL.md'))),
    'expected claude-code-setup/SKILL.md to be present',
  );
  assert.ok(
    files.some((f) => f.endsWith(join('getting-started', 'SKILL.md'))),
    'expected getting-started/SKILL.md to be present',
  );
  assert.ok(
    files.some((f) => f.endsWith(join('knowledge-contribution', 'SKILL.md'))),
    'expected knowledge-contribution/SKILL.md to be present',
  );
  assert.ok(
    files.some((f) => f.endsWith(join('debug-claude-api-error', 'SKILL.md'))),
    'expected debug-claude-api-error/SKILL.md to be present',
  );
  assert.ok(
    files.some((f) => f.endsWith(join('member-connection', 'SKILL.md'))),
    'expected member-connection/SKILL.md to be present',
  );
});
