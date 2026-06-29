import { logger } from './logger.js';
import type { CallerContext } from './auth/rbac.js';
import type { IncomingMessage, PlatformAdapter } from './platforms/types.js';
import { runAgentTurn } from './agent/core.js';
import { recordInteraction } from './storage/repository.js';

/**
 * Routes normalised messages to the agent and replies on the originating
 * platform. Responsibilities:
 *  - persist every inbound message (audit + learning) regardless of reply
 *  - decide whether the bot should respond (addressed, or direct chat)
 *  - serialise turns per conversation (session resume is not concurrency-safe)
 *  - apply a light per-user rate limit
 */
export class Router {
  private readonly adapters = new Map<string, PlatformAdapter>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly userHits = new Map<string, number[]>();

  private readonly RATE_LIMIT = 8; // messages
  private readonly RATE_WINDOW_MS = 60_000; // per minute

  register(adapter: PlatformAdapter): void {
    this.adapters.set(adapter.platform, adapter);
    adapter.onMessage((msg) => this.handle(msg));
  }

  private convoKey(msg: IncomingMessage): string {
    return `${msg.platform}:${msg.conversationId}`;
  }

  private rateLimited(userKey: string): boolean {
    const now = Date.now();
    const hits = (this.userHits.get(userKey) ?? []).filter((t) => now - t < this.RATE_WINDOW_MS);
    hits.push(now);
    this.userHits.set(userKey, hits);
    return hits.length > this.RATE_LIMIT;
  }

  private async handle(msg: IncomingMessage): Promise<void> {
    // Always record inbound for audit + learning, even if we won't reply.
    await recordInteraction({
      platform: msg.platform,
      conversationId: msg.conversationId,
      userId: msg.userId,
      userName: msg.userName,
      role: msg.role,
      direction: 'inbound',
      content: msg.text,
      addressedToBot: msg.addressedToBot,
      isDirect: msg.isDirect,
    }).catch((err) => logger.error({ err }, 'Failed to record inbound interaction'));

    // Only respond when addressed (mention/reply) or in a direct conversation.
    if (!msg.addressedToBot && !msg.isDirect) return;
    if (!msg.text.trim()) return;

    const userKey = `${msg.platform}:${msg.userId}`;
    if (this.rateLimited(userKey)) {
      logger.warn({ userKey }, 'User rate limited');
      return;
    }

    // Serialise per conversation so session resume stays consistent.
    const key = this.convoKey(msg);
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(() => this.respond(msg)).catch((err) => logger.error({ err }, 'respond failed'));
    this.chains.set(
      key,
      next.finally(() => {
        if (this.chains.get(key) === next) this.chains.delete(key);
      }),
    );
    await next;
  }

  private async respond(msg: IncomingMessage): Promise<void> {
    const adapter = this.adapters.get(msg.platform);
    if (!adapter) {
      logger.error({ platform: msg.platform }, 'No adapter registered for platform');
      return;
    }

    const caller: CallerContext = {
      platform: msg.platform,
      userId: msg.userId,
      userName: msg.userName,
      role: msg.role,
      conversationId: msg.conversationId,
    };

    const reply = await runAgentTurn(caller, msg.text, adapter);

    await adapter.sendMessage({ conversationId: msg.conversationId, text: reply.text });

    await recordInteraction({
      platform: msg.platform,
      conversationId: msg.conversationId,
      userId: 'bot',
      userName: 'CommunityAgent',
      role: 'admin',
      direction: 'outbound',
      content: reply.text,
      costUsd: reply.costUsd,
      meta: { replyToUserId: msg.userId },
    }).catch((err) => logger.error({ err }, 'Failed to record outbound interaction'));
  }
}
