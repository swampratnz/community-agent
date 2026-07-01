import { config } from './config.js';
import { logger } from './logger.js';
import type { CallerContext, Tier } from './auth/rbac.js';
import { resolveRole } from './auth/roles.js';
import type { IncomingMessage, PlatformAdapter } from './platforms/types.js';
import { runAgentTurn } from './agent/core.js';
import { classifyConfirmReply, cancelPendingAction, takePendingAction } from './agent/pendingActions.js';
import { filterOutbound } from './agent/outbound.js';
import { getCodeAnswersPolicy, isPaused } from './storage/policies.js';
import { countRepliesToUser, recordInteraction } from './storage/repository.js';

const GATED_NOTICE =
  'Kia ora! This assistant is member-only. Ask a community admin to add you as a member and I can help.';

/**
 * Routes normalised messages to the agent and replies on the originating
 * platform. Responsibilities:
 *  - resolve the sender's tier (env super admins + membership DB)
 *  - gated mode: guests get a pointer to an admin, and their message content
 *    is NOT stored
 *  - intercept CONFIRM/CANCEL replies for pending destructive actions —
 *    executed deterministically, never through the model
 *  - respect the paused policy (super admins only while paused)
 *  - persist member+ messages (audit + learning) regardless of reply
 *  - per-user rate limit and daily reply budget
 *  - serialise turns per conversation (session resume is not concurrency-safe)
 *  - filter every outbound reply (secret redaction + code policy)
 */
export class Router {
  private readonly adapters = new Map<string, PlatformAdapter>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly userHits = new Map<string, number[]>();

  private readonly RATE_LIMIT = 8; // messages
  private readonly RATE_WINDOW_MS = 60_000; // per minute
  /** userKeys already told they hit today's budget (keyed by day). */
  private readonly budgetNotified = new Set<string>();

  /** Exact secret values that must never leave the process in a reply. */
  private readonly knownSecrets: string[] = [
    config.llm.oauthToken,
    config.discord.botToken,
    config.db.url,
  ];

  constructor() {
    setInterval(() => this.sweepRateLimits(), this.RATE_WINDOW_MS * 5).unref();
  }

  private sweepRateLimits(): void {
    const now = Date.now();
    for (const [key, hits] of this.userHits) {
      if (hits.every((t) => now - t >= this.RATE_WINDOW_MS)) this.userHits.delete(key);
    }
    const today = new Date().toDateString();
    for (const key of this.budgetNotified) {
      if (!key.endsWith(today)) this.budgetNotified.delete(key);
    }
  }

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

  private async send(adapter: PlatformAdapter, conversationId: string, text: string): Promise<void> {
    const codePolicy = await getCodeAnswersPolicy();
    await adapter.sendMessage({
      conversationId,
      text: filterOutbound(text, codePolicy, this.knownSecrets),
    });
  }

  private async handle(msg: IncomingMessage): Promise<void> {
    const adapter = this.adapters.get(msg.platform);
    if (!adapter) return;

    let role: Tier;
    try {
      role = await resolveRole(msg.platform, msg.userId);
    } catch (err) {
      logger.error({ err }, 'Role resolution failed; treating sender as guest');
      role = 'guest';
    }

    const gated = config.rbac.accessMode[msg.platform] === 'gated';

    // Gated mode: guests are not part of the community — do not store their
    // content; if they address the bot, point them at an admin (rate-limited).
    if (gated && role === 'guest') {
      if ((msg.addressedToBot || msg.isDirect) && msg.text.trim()) {
        const userKey = `${msg.platform}:${msg.userId}`;
        if (!this.rateLimited(userKey)) {
          await this.send(adapter, msg.conversationId, GATED_NOTICE).catch((err) =>
            logger.warn({ err }, 'Failed to send gated notice'),
          );
        }
      }
      return;
    }

    // Record member+ (and open-mode guest) traffic for audit + learning.
    // Fire-and-forget so embedding CPU never blocks channels we won't answer.
    const recorded = recordInteraction({
      platform: msg.platform,
      conversationId: msg.conversationId,
      userId: msg.userId,
      userName: msg.userName,
      role,
      direction: 'inbound',
      content: msg.text,
      addressedToBot: msg.addressedToBot,
      isDirect: msg.isDirect,
    }).catch((err) => logger.error({ err }, 'Failed to record inbound interaction'));

    // Only respond when addressed (mention/reply) or in a direct conversation.
    if (!msg.addressedToBot && !msg.isDirect) return;
    if (!msg.text.trim()) return;

    // Paused: only super admins get through (so they can resume it).
    if (role !== 'super_admin' && (await isPaused().catch(() => false))) return;

    // Deterministic CONFIRM/CANCEL intercept for pending destructive actions.
    // Never reaches the model: injection can request, only a human can confirm.
    const verdict = classifyConfirmReply(msg.text);
    if (verdict === 'confirm') {
      const pending = takePendingAction(msg.platform, msg.conversationId, msg.userId);
      if (pending) {
        let outcome: string;
        try {
          outcome = await pending.execute();
        } catch (err) {
          outcome = `Failed: ${err instanceof Error ? err.message : String(err)}`;
        }
        await this.send(adapter, msg.conversationId, outcome).catch((err) =>
          logger.error({ err }, 'Failed to send confirm outcome'),
        );
        return;
      }
    } else if (verdict === 'cancel') {
      if (cancelPendingAction(msg.platform, msg.conversationId, msg.userId)) {
        await this.send(adapter, msg.conversationId, 'Cancelled.').catch(() => {});
        return;
      }
    }

    const userKey = `${msg.platform}:${msg.userId}`;
    if (this.rateLimited(userKey)) {
      logger.warn({ userKey }, 'User rate limited');
      return;
    }

    // Daily reply budget (super admins exempt).
    const limit = config.behaviour.dailyReplyLimitPerUser;
    if (limit > 0 && role !== 'super_admin') {
      const used = await countRepliesToUser(msg.platform, msg.userId).catch(() => 0);
      if (used >= limit) {
        const noticeKey = `${userKey}:${new Date().toDateString()}`;
        if (!this.budgetNotified.has(noticeKey)) {
          this.budgetNotified.add(noticeKey);
          await this.send(
            adapter,
            msg.conversationId,
            "You've reached today's usage limit for the assistant — try again tomorrow.",
          ).catch(() => {});
        }
        return;
      }
    }

    // If we ARE replying, make sure this message is in memory before the
    // agent turn runs (so recall can see it and ordering stays sane).
    await recorded;

    // Serialise per conversation so session resume stays consistent.
    const key = this.convoKey(msg);
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev
      .then(() => this.respond(msg, role, adapter))
      .catch((err) => logger.error({ err }, 'respond failed'));
    const tracked = next.finally(() => {
      if (this.chains.get(key) === tracked) this.chains.delete(key);
    });
    this.chains.set(key, tracked);
    await tracked;
  }

  private async respond(msg: IncomingMessage, role: Tier, adapter: PlatformAdapter): Promise<void> {
    const caller: CallerContext = {
      platform: msg.platform,
      userId: msg.userId,
      userName: msg.userName,
      role,
      conversationId: msg.conversationId,
    };

    const reply = await runAgentTurn(caller, msg.text, adapter);

    await this.send(adapter, msg.conversationId, reply.text);

    await recordInteraction({
      platform: msg.platform,
      conversationId: msg.conversationId,
      userId: 'bot',
      userName: 'CommunityAgent',
      role: 'member',
      direction: 'outbound',
      content: reply.text,
      costUsd: reply.costUsd,
      meta: { replyToUserId: msg.userId },
    }).catch((err) => logger.error({ err }, 'Failed to record outbound interaction'));
  }
}
