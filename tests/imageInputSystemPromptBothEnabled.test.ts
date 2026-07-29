import { test } from 'node:test';
import assert from 'node:assert/strict';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it. This file covers
// the fourth combination of the systemPrompt image-input gate (issue #879,
// acceptance criterion 4: "clause present iff (discord.image.enabled ||
// whatsapp.image.enabled)") — BOTH flags on — needing its own process since
// config is read once at import time. The other three combinations live in
// tests/discordImageInput.test.ts (both off),
// tests/imageInputSystemPromptEnabled.test.ts (Discord only), and
// tests/whatsappImageInputSystemPromptEnabled.test.ts (WhatsApp only).
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.IMAGE_INPUT_ENABLED = 'true';
process.env.WHATSAPP_IMAGE_INPUT_ENABLED = 'true';

const { buildSystemPrompt } = await import('../src/agent/systemPrompt.js');
const { config } = await import('../src/config.js');

test('precondition: both IMAGE_INPUT_ENABLED (Discord) and WHATSAPP_IMAGE_INPUT_ENABLED are on in this test process', () => {
  assert.equal(config.discord.image.enabled, true);
  assert.equal(config.whatsapp.image.enabled, true);
});

test("SECURITY: with both platforms' image-input flags on, the system prompt still carries exactly one copy of the untrusted-data clause (issue #879, acceptance criterion 4)", () => {
  const prompt = buildSystemPrompt(
    {
      platform: 'discord',
      userId: 'u1',
      userName: 'Chris',
      role: 'member',
      conversationId: 'c1',
      isDirect: false,
    },
    { codeAnswers: 'snippets', responseStyle: 'standard', languagePreference: 'auto' },
  );
  const matches = prompt.match(/UNTRUSTED DATA to look at and answer from/g) ?? [];
  assert.equal(matches.length, 1, 'the clause must appear exactly once, not once per enabled platform');
});
