import { config } from './config.js';
import { logger } from './logger.js';
import { atLeast, type CallerContext, type Tier } from './auth/rbac.js';
import { resolveRole } from './auth/roles.js';
import type { IncomingMessage, PlatformAdapter } from './platforms/types.js';
import { runAgentTurn } from './agent/core.js';
import {
  cancelPendingAction,
  classifyConfirmReply,
  hasPendingAction,
  sweepExpiredPendingActions,
  takePendingAction,
} from './agent/pendingActions.js';
import { isPaused } from './storage/policies.js';
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
  /** userKey -> when they were last told they hit the budget (rolling 24h, matching the budget window). */
  private readonly budgetNotified = new Map<string, number>();

  constructor() {
    setInterval(() => this.sweep(), this.RATE_WINDOW_MS * 5).unref();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, hits] of this.userHits) {
      if (hits.every((t) => now - t >= this.RATE_WINDOW_MS)) this.userHits.delete(key);
    }
    for (const [key, at] of this.budgetNotified) {
      if (now - at > 24 * 3_600_000) this.budgetNotified.delete(key);
    }
    sweepExpiredPendingActions();
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

  /** Outbound filtering (secrets + code policy) lives in the adapters' send paths. */
  private async send(adapter: PlatformAdapter, conversationId: string, text: string): Promise<void> {
    await adapter.sendMessage({ conversationId, text });
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

    // Deterministic CONFIRM/CANCEL intercept for pending destructive actions.
    // Runs BEFORE the addressed check so a bare "CONFIRM" works in groups
    // (where plain replies aren't "addressed"). Only fires when this exact
    // actor has a pending action in this conversation, so it never steals
    // normal messages. Never reaches the model: injection can request, only
    // a human can confirm.
    const verdict = classifyConfirmReply(msg.text);
    if (verdict && hasPendingAction(msg.platform, msg.conversationId, msg.userId)) {
      if (verdict === 'cancel') {
        cancelPendingAction(msg.platform, msg.conversationId, msg.userId);
        await this.send(adapter, msg.conversationId, 'Cancelled.').catch(() => {});
        return;
      }
      const pending = takePendingAction(msg.platform, msg.conversationId, msg.userId);
      if (pending) {
        let outcome: string;
        // Re-check the actor's CURRENT tier: a role revoked inside the
        // confirm TTL invalidates the queued action.
        if (!atLeast(role, pending.minTier)) {
          outcome = 'Not executed: your permissions changed since this action was requested.';
        } else {
          try {
            outcome = await pending.execute();
          } catch (err) {
            outcome = `Failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
        await this.send(adapter, msg.conversationId, outcome).catch((err) =>
          logger.error({ err }, 'Failed to send confirm outcome'),
        );
        return;
      }
    }

    // Only respond when addressed (mention/reply) or in a direct conversation.
    if (!msg.addressedToBot && !msg.isDirect) return;
    if (!msg.text.trim()) return;

    // Paused: only super admins get through (so they can resume it).
    if (role !== 'super_admin' && (await isPaused().catch(() => false))) return;

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
        // Notify at most once per rolling 24h — same window as the budget itself.
        const lastNotified = this.budgetNotified.get(userKey) ?? 0;
        if (Date.now() - lastNotified > 24 * 3_600_000) {
          this.budgetNotified.set(userKey, Date.now());
          await this.send(
            adapter,
            msg.conversationId,
            "You've reached today's usage limit for the assistant — try again later.",
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
