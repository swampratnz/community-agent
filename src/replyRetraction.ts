import type { Platform } from './platforms/types.js';

/**
 * In-memory, TTL'd, size-capped mapping from an inbound addressed message to
 * the bot's own reply to it (issue #575's auto-retraction feature): the
 * router records an entry here right after sending the real-agent-turn main
 * reply, and the Discord/WhatsApp Baileys adapters consult it when their
 * native gateway reports the ORIGINAL message was deleted/revoked, so the
 * bot's reply can be retracted along with it.
 *
 * A directly-imported shared module rather than Router instance state
 * (despite the map's shape mirroring Router's own `lastReply`/
 * `pendingEscalations`): the write side (the router, after a send) and the
 * read side (an adapter's native delete/revoke listener) both need direct
 * access, and adapters hold no reference back to the Router — this mirrors
 * the codebase's existing convention of a directly-imported shared module
 * (e.g. storage/repository.ts's `deleteInteractionByMessageId`, already
 * called straight from the adapters) over new Router<->Adapter coupling.
 *
 * In-memory only by design (no schema/migration — see the issue's proposal):
 * a restart merely means a reply sent just before it can no longer be
 * auto-retracted, the same best-effort/volatile tradeoff WhatsApp's own
 * "delete for everyone" already has.
 */

const TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 1000;

export interface ReplyMapping {
  /**
   * Conversation id the bot's reply actually landed in. Usually identical to
   * the inbound conversation id, but kept separate since a reply can be
   * redirected (e.g. issue #477's auto-answer thread) — this is always the
   * id `deleteOwnMessage` must be called with, not necessarily the id the
   * delete/revoke event itself reports.
   */
  replyConversationId: string;
  /**
   * Platform message id(s) of the bot's own reply — the thing(s) to retract.
   * A single logical reply can span multiple platform messages (e.g. Discord
   * chunking a long reply past its 2000-char cap via `chunkText`), so this is
   * always an array, even when a platform only ever sends one message per
   * reply; a retraction must delete every chunk, not just the last one.
   */
  botReplyMessageIds: string[];
  /**
   * The original message's sender. Carried so WhatsApp's revoke-authorship
   * check (issue #48/#103's spoofed-revoke discipline) never has to depend
   * on an archived `interactions` row existing — this mapping alone is
   * enough to verify who is allowed to trigger the retraction.
   */
  senderId: string;
  at: number;
}

const mappings = new Map<string, ReplyMapping>();

function mapKey(platform: Platform, conversationId: string, messageId: string): string {
  return `${platform}:${conversationId}:${messageId}`;
}

/**
 * Drop everything past TTL_MS, then trim to MAX_ENTRIES oldest-first (a Map
 * iterates in insertion order) — same sweep shape as baileysAdapter.ts's
 * `remember()` cache for sent messages.
 */
function sweep(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [key, entry] of mappings) {
    if (entry.at >= cutoff && mappings.size <= MAX_ENTRIES) break;
    mappings.delete(key);
  }
}

/** Record the mapping for a just-sent reply. Overwrites any stale entry for the same key. */
export function recordReplyMapping(
  platform: Platform,
  conversationId: string,
  messageId: string,
  entry: Omit<ReplyMapping, 'at'>,
): void {
  mappings.set(mapKey(platform, conversationId, messageId), { ...entry, at: Date.now() });
  sweep();
}

/**
 * Look up the mapping for `messageId` in `conversationId` WITHOUT evicting
 * it. Used where the caller must verify something (WhatsApp's revoke-
 * authorship check) before deciding whether to actually retract — a failed
 * check must never consume the entry, or a single forged/non-author revoke
 * could permanently deny a later LEGITIMATE retraction of the same reply
 * (a griefing vector). Returns undefined for no mapping, or one that's past
 * its TTL (an expired entry is evicted as a side effect either way, since
 * it's dead weight regardless of who's asking).
 */
export function peekReplyMapping(
  platform: Platform,
  conversationId: string,
  messageId: string,
): ReplyMapping | undefined {
  const key = mapKey(platform, conversationId, messageId);
  const entry = mappings.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > TTL_MS) {
    mappings.delete(key);
    return undefined;
  }
  return entry;
}

/** Explicitly evict the mapping for `messageId` — call once a retraction has actually happened (or been decided against). */
export function evictReplyMapping(platform: Platform, conversationId: string, messageId: string): void {
  mappings.delete(mapKey(platform, conversationId, messageId));
}

/**
 * Look up and unconditionally evict (single-use: a delete event retracts at
 * most once) the mapping for `messageId`. Only safe for a caller with no
 * authorship check of its own to fail (Discord: any successful delete of the
 * source message is itself already a legitimate trigger, so every lookup
 * that finds a mapping WILL retract) — see `peekReplyMapping`/
 * `evictReplyMapping` for a caller (WhatsApp) that must verify before
 * consuming the entry.
 */
export function takeReplyMapping(
  platform: Platform,
  conversationId: string,
  messageId: string,
): ReplyMapping | undefined {
  const entry = peekReplyMapping(platform, conversationId, messageId);
  if (!entry) return undefined;
  evictReplyMapping(platform, conversationId, messageId);
  return entry;
}

export const REPLY_RETRACTION_TTL_MS = TTL_MS;
export const REPLY_RETRACTION_MAX_ENTRIES = MAX_ENTRIES;

/** Test-only: clear all state between tests (this module is a process-wide singleton). */
export function resetReplyMappingsForTests(): void {
  mappings.clear();
}
