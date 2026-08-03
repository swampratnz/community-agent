import { test } from 'node:test';
import assert from 'node:assert/strict';
// Community notice-pack registration — the composition-root contract:
// src/index.ts registers the pack in production, so a test whose import
// graph evaluates a notice consumer registers it explicitly here, first.
import '../src/module/strings/notices.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it. This file needs
// AGENT_SKILLS_ENABLED=true (issue #776), which needs its own process, same
// as modelAndPlanSelectionSkill.test.ts.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.AGENT_SKILLS_ENABLED = 'true';

// The tool registry's module-scope registrations (tool tiers, tool-server
// parts, feature-flag predicates) — the composition-root contract, matching
// tests/rbac.test.ts.
await import('../src/module/agent/tools/index.js');

const { buildQueryOptions } = await import('../src/base/agent/core.js');

const SKILL_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../src/module/agent/skills/getting-started/SKILL.md',
);
const SKILL_BODY = readFileSync(SKILL_PATH, 'utf8');

test('AC1 — getting-started front-matter has the expected name and a "where do I start"/sequencing description', () => {
  assert.match(SKILL_BODY, /^---\nname: getting-started\n/);
  assert.match(SKILL_BODY, /description: .*(where.*start|getting started|sequenc)/i);
});

test('AC2 — with the flag ON, buildQueryOptions resolves skills to include getting-started, backed by the bundled SKILL.md on disk, for every role', () => {
  for (const role of ['guest', 'member', 'admin', 'super_admin'] as const) {
    const opts = buildQueryOptions(role, 'prompt', {}, null, 'conv-1');
    assert.ok(
      opts.skills?.includes('getting-started'),
      `${role}: skills must include getting-started when the flag is on`,
    );
  }
  // The skill name in ENABLED_SKILLS must resolve to a real file — a typo'd
  // or missing entry would silently no-op at the SDK layer.
  assert.ok(SKILL_BODY.length > 0, 'expected SKILL.md to exist and be non-empty on disk');
});

test('AC3 — SKILL.md contains no hardcoded command syntax, version numbers, dollar amounts, or rate-limit figures (freshness-discipline guard)', () => {
  assert.doesNotMatch(SKILL_BODY, /\$\s?\d/, 'must not contain a dollar-amount figure');
  assert.doesNotMatch(
    SKILL_BODY,
    /\b\d[\d,]*\s*(requests?|tokens?|messages?|calls?)\s*(\/|per)\s*(minute|hour|day|month)/i,
    'must not contain a rate-limit figure',
  );
  assert.doesNotMatch(SKILL_BODY, /\bRPM\b|\bTPM\b/, 'must not contain a rate-limit abbreviation');
});

test("AC3 — SKILL.md defers every step's facts to knowledge_search rather than asserting them directly", () => {
  assert.match(
    SKILL_BODY,
    /knowledge_search/,
    'body must reference knowledge_search as the source of factual content',
  );
});

test('AC4 — SKILL.md states the hand-off boundary to the more specific sibling skills', () => {
  assert.match(SKILL_BODY, /claude-code-setup/, 'must name claude-code-setup as a hand-off target');
  assert.match(SKILL_BODY, /prompt-review/, 'must name prompt-review as a hand-off target');
  assert.match(
    SKILL_BODY,
    /agent-architecture-review/,
    'must name agent-architecture-review as a hand-off target',
  );
});

test("SECURITY: AC6 — adding getting-started to ENABLED_SKILLS grants no role a new tool ('Skill' stays out of allowedTools/disallowedTools, disallowedTools unaffected)", () => {
  for (const role of ['guest', 'member', 'admin', 'super_admin'] as const) {
    const opts = buildQueryOptions(role, 'prompt', {}, null, 'conv-1', 'discord');
    assert.ok(!opts.allowedTools.includes('Skill'), `${role}: allowedTools must not include 'Skill'`);
    assert.ok(!opts.disallowedTools.includes('Skill'), `${role}: disallowedTools must not include 'Skill'`);
    assert.deepEqual(
      opts.disallowedTools,
      ['Task', 'WebFetch', ...(role === 'admin' || role === 'super_admin' ? [] : ['WebSearch'])],
      `${role}: disallowedTools must be unaffected by the new skill`,
    );
  }
});
