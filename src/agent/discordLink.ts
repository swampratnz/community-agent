import type { MemoryHit } from '../storage/repository.js';

/**
 * Build a Discord message permalink. DMs use the special `@me` guild segment
 * instead of the actual guild id (issue #137) — a guild-form link never
 * resolves for a DM-origin message.
 */
export function discordJumpLink(opts: {
  guildId: string;
  channelId: string;
  messageId: string;
  isDirect: boolean;
}): string {
  const guildSegment = opts.isDirect ? '@me' : opts.guildId;
  return `https://discord.com/channels/${guildSegment}/${opts.channelId}/${opts.messageId}`;
}

/**
 * Jump link for a recalled/searched memory hit, or null when one doesn't
 * apply: WhatsApp has no stable public permalink scheme, and pre-archiving
 * rows (or any row where it was never captured) have no stored message id.
 */
export function memoryHitJumpLink(
  hit: Pick<MemoryHit, 'platform' | 'conversationId' | 'messageId' | 'isDirect'>,
  guildId: string,
): string | null {
  if (hit.platform !== 'discord' || !hit.messageId) return null;
  return discordJumpLink({
    guildId,
    channelId: hit.conversationId,
    messageId: hit.messageId,
    isDirect: hit.isDirect,
  });
}
