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
// AGENT_SKILLS_ENABLED=true (issue #758), which needs its own process, same
// as agentSkillsEnabled.test.ts.
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

const SKILL_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../src/module/agent/skills/model-and-plan-selection/SKILL.md',
);
const SKILL_BODY = readFileSync(SKILL_PATH, 'utf8');

test('AC5 — model-and-plan-selection front-matter has the expected name and a task-type description', () => {
  assert.match(SKILL_BODY, /^---\nname: model-and-plan-selection\n/);
  assert.match(SKILL_BODY, /description: .*model.*plan/i);
});

test('AC1/AC5 — with the flag ON, buildQueryOptions resolves skills to include model-and-plan-selection, backed by the bundled SKILL.md on disk', () => {
  for (const role of ['guest', 'member', 'admin', 'super_admin'] as const) {
    const opts = buildQueryOptions(role, 'prompt', {}, null, 'conv-1');
    assert.ok(
      opts.skills?.includes('model-and-plan-selection'),
      `${role}: skills must include model-and-plan-selection when the flag is on`,
    );
  }
  // The skill name in ENABLED_SKILLS must resolve to a real file — a typo'd
  // or missing entry would silently no-op at the SDK layer.
  assert.ok(SKILL_BODY.length > 0, 'expected SKILL.md to exist and be non-empty on disk');
});

test('AC3 — SKILL.md contains no hardcoded pricing, rate-limit, or plan-inclusion figures (freshness-discipline guard)', () => {
  assert.doesNotMatch(SKILL_BODY, /\$\s?\d/, 'must not contain a dollar-amount figure');
  assert.doesNotMatch(
    SKILL_BODY,
    /\b\d[\d,]*\s*(requests?|tokens?|messages?|calls?)\s*(\/|per)\s*(minute|hour|day|month)/i,
    'must not contain a rate-limit figure',
  );
  assert.doesNotMatch(SKILL_BODY, /\bRPM\b|\bTPM\b/, 'must not contain a rate-limit abbreviation');
});

test('AC3 — SKILL.md references, but does not restate or remove, the always-on fast-moving-facts rule', () => {
  assert.match(SKILL_BODY, /fast-moving-facts rule in GUIDELINES/i);
  assert.doesNotMatch(
    SKILL_BODY,
    /your training\s*\n?\s*data may predate/i,
    'must not restate the GUIDELINES fast-moving-facts caveat text verbatim — it should reference it, not duplicate it',
  );
});

test("SECURITY: AC7 — adding model-and-plan-selection to ENABLED_SKILLS grants no role a new MCP tool via allowedTools/disallowedTools ('Skill' stays out of both)", () => {
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
