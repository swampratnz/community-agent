import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discordJumpLink, memoryHitJumpLink } from '../src/agent/discordLink.js';
import type { MemoryHit } from '../src/storage/repository.js';

test('discordJumpLink: guild channel hit uses the guild id segment', () => {
  assert.equal(
    discordJumpLink({ guildId: 'g1', channelId: 'c1', messageId: 'm1', isDirect: false }),
    'https://discord.com/channels/g1/c1/m1',
  );
});

test('discordJumpLink: DM hit uses the special @me segment, not the guild id (issue #137)', () => {
  assert.equal(
    discordJumpLink({ guildId: 'g1', channelId: 'c1', messageId: 'm1', isDirect: true }),
    'https://discord.com/channels/@me/c1/m1',
  );
});

function hit(
  overrides: Partial<MemoryHit> = {},
): Pick<MemoryHit, 'platform' | 'conversationId' | 'messageId' | 'isDirect'> {
  return {
    platform: 'discord',
    conversationId: 'c1',
    messageId: 'm1',
    isDirect: false,
    ...overrides,
  };
}

test('memoryHitJumpLink: builds a link for a Discord hit with a stored message id', () => {
  assert.equal(memoryHitJumpLink(hit(), 'g1'), 'https://discord.com/channels/g1/c1/m1');
});

test('memoryHitJumpLink: null for a WhatsApp hit even when a message id is present', () => {
  assert.equal(memoryHitJumpLink(hit({ platform: 'whatsapp' }), 'g1'), null);
});

test('memoryHitJumpLink: null when there is no stored message id (pre-archiving rows)', () => {
  assert.equal(memoryHitJumpLink(hit({ messageId: null }), 'g1'), null);
});
