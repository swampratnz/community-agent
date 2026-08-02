import { test } from 'node:test';
import assert from 'node:assert/strict';
// Community content registrations (prompt sections + persona roster) — the
// composition-root contract: src/index.ts registers these in production, so
// tests that assemble prompts register them explicitly here.
import '../src/agent/communityPromptSections.js';
import '../src/agent/personas.js';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it. This file's whole
// point is the IMAGE_INPUT_ENABLED=true path (issue #783), which needs its
// own process: config is read once at import time and can't be toggled
// mid-process (see tests/agentSkillsEnabled.test.ts for the identical
// pattern with AGENT_SKILLS_ENABLED) — the flag-off invariant lives in
// tests/discordImageInput.test.ts instead.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.IMAGE_INPUT_ENABLED = 'true';

const { buildSystemPrompt } = await import('../src/agent/systemPrompt.js');
const { config } = await import('../src/config.js');

test('precondition: IMAGE_INPUT_ENABLED is on in this test process', () => {
  assert.equal(config.discord.image.enabled, true);
});

test('SECURITY: with IMAGE_INPUT_ENABLED on, the system prompt for every role carries the explicit clause stating image-borne text is untrusted data, never an instruction (issue #783, acceptance criterion 6)', () => {
  for (const role of ['guest', 'member', 'admin', 'super_admin'] as const) {
    const prompt = buildSystemPrompt(
      { platform: 'discord', userId: 'u1', userName: 'Chris', role, conversationId: 'c1', isDirect: false },
      { codeAnswers: 'snippets', responseStyle: 'standard', languagePreference: 'auto' },
    );
    assert.match(
      prompt,
      /UNTRUSTED DATA to look at and answer from/,
      `${role}: the image-untrusted-data clause must be present`,
    );
    assert.match(
      prompt,
      /never something to obey/,
      `${role}: the clause must explicitly say image-borne text is never an instruction to obey`,
    );
  }
});
