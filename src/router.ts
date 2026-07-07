import { config } from './config.js';
import { logger } from './logger.js';
import { isPureAcknowledgement } from './ackClassifier.js';
import { atLeast, type CallerContext, type Tier } from './auth/rbac.js';
import { resolveRole, superAdminIds } from './auth/roles.js';
import type { IncomingMessage, PlatformAdapter } from './platforms/types.js';
import { INTERNAL_ERROR_REPLY, runAgentTurn, type AgentReply } from './agent/core.js';
import {
  cancelPendingAction,
  classifyConfirmReply,
  hasPendingAction,
  sweepExpiredPendingActions,
  takePendingAction,
} from './agent/pendingActions.js';
import { isPaused } from './storage/policies.js';
import {
  countRepliesToUser,
  recordAccessRequest,
  recordInteraction,
  recordKnowledgeRetrieval,
  searchKnowledge,
} from './storage/repository.js';
import { RATE_LIMIT_NOTICE_TEXT, shouldNotifyRateLimited } from './rateLimitNotice.js';
import { PAUSE_NOTICE_TEXT, shouldNotifyPaused } from './pauseNotice.js';
import { shouldNotifyBudgetCheckFailed } from './budgetCheckFailureNotice.js';

const GATED_NOTICE =
  'Kia ora! This assistant is member-only. Ask a community admin to add you as a member and I can help.';

// Static reply for the ACK_SHORTCUT_ENABLED short-circuit (see
// ackClassifier.ts). Sent via send() so outbound filtering still applies;
// deliberately not counted toward the daily reply budget (no outbound
// recordInteraction call for it — only respond() records outbound), since
// it isn't a real answer.
const ACK_REPLY_TEXT = 'No worries!';

// Suffix appended to a KNOWLEDGE_SHORTCUT_ENABLED reply so the member always
// has an escape hatch to a real agent turn (issue #162) — unlike the ack
// shortcut, this reply carries real content standing in for the model, so it
// must be attributed rather than look like the agent answered directly.
const KNOWLEDGE_SHORTCUT_SUFFIX =
  "\n\n— From our knowledge base; ask me to explain if this doesn't quite answer it.";

// Appended (instead of KNOWLEDGE_SHORTCUT_SUFFIX's member-facing escape
// hatch) when a GUEST_KNOWLEDGE_SHORTCUT_ENABLED hit is served to a gated
// guest (issue #165) — a guest can't "just ask again" for a real turn, so the
// nudge points at the actual unblock: getting added as a member.
const GUEST_KNOWLEDGE_SHORTCUT_NUDGE = '\n\nAsk a community admin to add you as a member to keep chatting.';

/**
 * Routes normalised messages to the agent and replies on the originating
 * platform. Responsibilities:
 *  - resolve the sender's tier (env super admins + membership DB)
 *  - gated mode: guests get a global-scope FAQ shortcut answer (if enabled and
 *    matched) or else a pointer to an admin; their message content is NOT
 *    stored either way
 *  - intercept CONFIRM/CANCEL replies for pending destructive actions —
 *    executed deterministically, never through the model
 *  - respect the paused policy (super admins only while paused; everyone else
 *    gets a debounced notice instead of silence)
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
  /** userKey -> when they were last told they're rate-limited (debounced to the rate-limit window). */
  private readonly rateLimitNotified = new Map<string, number>();
  /** userKey -> when they were last told the bot is paused (debounced to PAUSE_NOTIFY_WINDOW_MS). */
  private readonly pauseNotified = new Map<string, number>();
  /** Process-wide (not per-user) debounce for the daily-budget check-failure super-admin alert. */
  private budgetCheckFailureNotifiedAt: number | undefined;

  private readonly PAUSE_NOTIFY_WINDOW_MS = 3_600_000; // 1 hour — a pause is typically longer-lived than a rate-limit burst
  private readonly BUDGET_CHECK_FAILURE_ALERT_WINDOW_MS = 900_000; // 15 minutes — a DB recording failure is a systemic condition, not per-user

  /**
   * `runTurn` defaults to the real agent core; `typingRefireMs` defaults to a
   * sane production cadence (Discord auto-clears its own indicator after
   * ~10s, so re-firing every 8s keeps it continuously visible). `checkPaused`
   * defaults to the real policy read. `searchKnowledgeForShortcut` and
   * `recordShortcutRetrieval` default to the real DB-backed implementations.
   * `countReplies` defaults to the real daily-budget read. All are
   * overridable in tests so the typing-indicator, pause, knowledge-shortcut,
   * and budget-check-failure behaviour can be exercised without spawning a
   * real Claude Code subprocess, waiting 8 real seconds, or a live DB.
   */
  constructor(
    private readonly runTurn: typeof runAgentTurn = runAgentTurn,
    private readonly typingRefireMs = 8_000,
    private readonly checkPaused: typeof isPaused = isPaused,
    private readonly searchKnowledgeForShortcut: typeof searchKnowledge = searchKnowledge,
    private readonly recordShortcutRetrieval: typeof recordKnowledgeRetrieval = recordKnowledgeRetrieval,
    private readonly countReplies: typeof countRepliesToUser = countRepliesToUser,
  ) {
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
    for (const [key, at] of this.rateLimitNotified) {
      if (now - at > this.RATE_WINDOW_MS) this.rateLimitNotified.delete(key);
    }
    for (const [key, at] of this.pauseNotified) {
      if (now - at > this.PAUSE_NOTIFY_WINDOW_MS) this.pauseNotified.delete(key);
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

  /**
   * Best-effort super-admin DM when countRepliesToUser itself fails (not
   * when it succeeds and finds the user over budget) — the daily reply
   * budget, the main per-user cost/abuse guardrail, is silently unenforced
   * for as long as the failure persists (issue #203). Static text only: no
   * message content, no per-user identifiers. Mirrors usageAlert.ts's
   * alertSuperAdmins loop shape.
   */
  private async alertSuperAdminsBudgetCheckFailed(): Promise<void> {
    const message =
      '⚠️ Daily reply-budget check failed (DB error) — the per-user daily limit is not being enforced until this clears. Check logs / DB health.';
    for (const adapter of this.adapters.values()) {
      if (!adapter.isConnected()) continue; // can't send through a dead connection
      for (const id of superAdminIds(adapter.platform)) {
        adapter
          .sendDirectMessage(id, message)
          .catch((err) =>
            logger.warn({ err, platform: adapter.platform, id }, 'Budget check failure alert DM failed'),
          );
      }
    }
  }

  /**
   * Serialise `task` behind whatever else is already queued for `key` (a
   * real turn or a prior ack reply), so a fast path can never overtake a
   * slower one already in flight for the same conversation.
   */
  private async enqueue(key: string, label: string, task: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(task).catch((err) => logger.error({ err }, `${label} failed`));
    const tracked = next.finally(() => {
      if (this.chains.get(key) === tracked) this.chains.delete(key);
    });
    this.chains.set(key, tracked);
    await tracked;
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
    // content; if they address the bot, point them at an admin (rate-limited)
    // and record the request (identity + count only) so admins have a queue.
    if (gated && role === 'guest') {
      // Ambient archiving (issue #48; WhatsApp parity issue #103): with
      // DISCORD_ARCHIVE_ALL_MESSAGES on, or the WhatsApp conversation JID in
      // WHATSAPP_ARCHIVE_GROUP_JIDS, guest messages in group/guild channels
      // ARE stored — a deliberate, documented posture change requiring
      // community notice (SECURITY.md). Guest DMs to the bot stay unstored
      // either way. Storage only: the addressed-check below still solely
      // decides whether the agent runs.
      const archiveAmbient =
        (msg.platform === 'discord' && config.discord.archiveAllMessages) ||
        (msg.platform === 'whatsapp' && config.whatsapp.archiveGroupJids.includes(msg.conversationId));
      if (archiveAmbient && !msg.isDirect && msg.text.trim()) {
        recordInteraction({
          platform: msg.platform,
          conversationId: msg.conversationId,
          userId: msg.userId,
          userName: msg.userName,
          role,
          direction: 'inbound',
          content: msg.text,
          addressedToBot: msg.addressedToBot,
          isDirect: msg.isDirect,
          messageId: msg.messageId,
          kind: msg.addressedToBot ? 'addressed' : 'ambient',
        }).catch((err) => logger.error({ err }, 'Failed to record ambient interaction'));
      }
      if ((msg.addressedToBot || msg.isDirect) && msg.text.trim()) {
        const userKey = `${msg.platform}:${msg.userId}`;
        recordAccessRequest({ platform: msg.platform, userId: msg.userId, userName: msg.userName }).catch(
          (err) => logger.warn({ err }, 'Failed to record access request'),
        );
        if (!this.rateLimited(userKey)) {
          // Guest knowledge shortcut (issue #165): before the static "ask an
          // admin" pointer, try a global-only near-exact FAQ match — same
          // zero-token local-embedding path as the member-tier shortcut, just
          // scope-restricted. Off by default; falls through to the static
          // notice on a miss, a lookup failure, or the flag being off.
          const hit = config.behaviour.guestKnowledgeShortcutEnabled
            ? await this.tryKnowledgeShortcut(msg, { scopeRestriction: 'global-only' })
            : null;
          if (hit) {
            await this.sendGuestKnowledgeShortcut(msg, adapter, hit).catch((err) =>
              logger.warn({ err }, 'Failed to send guest knowledge-shortcut reply'),
            );
          } else {
            await this.send(adapter, msg.conversationId, GATED_NOTICE).catch((err) =>
              logger.warn({ err }, 'Failed to send gated notice'),
            );
          }
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
      messageId: msg.messageId,
      kind: msg.addressedToBot || msg.isDirect ? 'addressed' : 'ambient',
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

    // Paused: only super admins get through (so they can resume it). Everyone
    // else gets a debounced notice instead of silence (issue #128, mirroring
    // the rate-limit/budget notices below) — at most once per
    // PAUSE_NOTIFY_WINDOW_MS per user, so a busy channel during a long pause
    // isn't spammed. This check runs BEFORE the rate-limit check below, so a
    // paused user who is also over the rate limit gets exactly the pause
    // notice, never both.
    if (role !== 'super_admin' && (await this.checkPaused().catch(() => false))) {
      const pauseKey = `${msg.platform}:${msg.userId}`;
      if (shouldNotifyPaused(this.pauseNotified.get(pauseKey), Date.now(), this.PAUSE_NOTIFY_WINDOW_MS)) {
        this.pauseNotified.set(pauseKey, Date.now());
        await this.send(adapter, msg.conversationId, PAUSE_NOTICE_TEXT).catch(() => {});
      }
      return;
    }

    const userKey = `${msg.platform}:${msg.userId}`;
    if (this.rateLimited(userKey)) {
      logger.warn({ userKey }, 'User rate limited');
      // Notify at most once per rate-limit window — a burst of over-limit
      // messages gets exactly one notice, not silence and not spam.
      if (shouldNotifyRateLimited(this.rateLimitNotified.get(userKey), Date.now(), this.RATE_WINDOW_MS)) {
        this.rateLimitNotified.set(userKey, Date.now());
        await this.send(adapter, msg.conversationId, RATE_LIMIT_NOTICE_TEXT).catch(() => {});
      }
      return;
    }

    // Daily reply budget (super admins exempt).
    const limit = config.behaviour.dailyReplyLimitPerUser;
    if (limit > 0 && role !== 'super_admin') {
      const used = await this.countReplies(msg.platform, msg.userId).catch((err) => {
        logger.error({ err, platform: msg.platform }, 'daily_reply_budget_check_failed');
        if (
          shouldNotifyBudgetCheckFailed(
            this.budgetCheckFailureNotifiedAt,
            Date.now(),
            this.BUDGET_CHECK_FAILURE_ALERT_WINDOW_MS,
          )
        ) {
          this.budgetCheckFailureNotifiedAt = Date.now();
          void this.alertSuperAdminsBudgetCheckFailed();
        }
        return 0;
      });
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

    const key = this.convoKey(msg);

    // Deterministic short-circuit for pure acknowledgements ("thanks", "👍")
    // that carry no information for the agent to act on: skip the expensive
    // turn (memory recall + a query() subprocess against the shared Max
    // pool) and send one static reply instead. Off by default. Routed
    // through the same per-conversation chain as a real turn so it can
    // never overtake one already in flight.
    if (config.behaviour.ackShortcutEnabled && isPureAcknowledgement(msg.text)) {
      logger.debug(
        { platform: msg.platform, conversationId: msg.conversationId },
        'ack_shortcut_skipped_turn',
      );
      await this.enqueue(key, 'ack reply', () => this.send(adapter, msg.conversationId, ACK_REPLY_TEXT));
      return;
    }

    // Deterministic-ish near-exact FAQ short-circuit (issue #162): if the
    // message scores at or above a strict floor against an existing
    // knowledge entry, reply with that entry's content instead of spawning a
    // full agent turn. Looked up here (before the per-conversation chain) so
    // a slow embed/DB round-trip never blocks other conversations, but the
    // actual send is still routed through `enqueue` so it can never overtake
    // a turn already in flight for THIS conversation, mirroring the ack
    // shortcut. A lookup/DB failure falls through to a normal turn rather
    // than dropping the message.
    if (config.behaviour.knowledgeShortcutEnabled) {
      const hit = await this.tryKnowledgeShortcut(msg);
      if (hit) {
        await this.enqueue(key, 'knowledge shortcut reply', () =>
          this.sendKnowledgeShortcut(msg, adapter, hit),
        );
        return;
      }
    }

    // Serialise per conversation so session resume stays consistent.
    await this.enqueue(key, 'respond', () => this.respond(msg, role, adapter));
  }

  /**
   * Top-1 knowledge-search lookup against the strict shortcut threshold
   * (separate from, and much stricter than, `knowledge_search`'s own
   * relevance floor — see config.ts). Returns null on a sub-threshold match
   * OR a lookup failure; either way the caller falls through (a full turn for
   * a member, the static gated notice for a guest).
   *
   * `opts.scopeRestriction: 'global-only'` (issue #165) is passed through
   * unchanged to `searchKnowledge` for the gated-guest shortcut, so a guest
   * can never be served a platform- or conversation-scoped entry.
   */
  private async tryKnowledgeShortcut(
    msg: IncomingMessage,
    opts: { scopeRestriction?: 'global-only' } = {},
  ): Promise<{ id: number; content: string } | null> {
    let hits: Awaited<ReturnType<typeof searchKnowledge>>;
    try {
      hits = await this.searchKnowledgeForShortcut(
        msg.text,
        { platform: msg.platform, conversationId: msg.conversationId },
        1,
        opts,
      );
    } catch (err) {
      logger.warn({ err }, 'Knowledge shortcut lookup failed; falling through to a full turn');
      return null;
    }
    const top = hits[0];
    if (!top || top.similarity < config.behaviour.knowledgeShortcutThreshold) return null;
    // Never direct-serve machine-researched (unreviewed) knowledge: the shortcut
    // bypasses the model and its untrusted-quarantine, so an 'auto' entry falls
    // through instead — to a full turn (members: knowledge_search quarantines it)
    // or the static gated notice (guests). The shortcut is for trusted,
    // human-authored FAQs only.
    if (top.autoGenerated) return null;
    return { id: top.id, content: top.content };
  }

  /**
   * Sends the shortcut's KB content and records it exactly like a normal
   * agent reply (issue #162, point 4): counted toward
   * `dailyReplyLimitPerUser`, visible to admin history/digest views, and
   * bumps the served entry's `retrieval_count`/`last_retrieved_at` — unlike
   * the ack shortcut, this reply stands in for a real answer, not a
   * no-content courtesy reply.
   */
  private async sendKnowledgeShortcut(
    msg: IncomingMessage,
    adapter: PlatformAdapter,
    hit: { id: number; content: string },
  ): Promise<void> {
    logger.debug({ platform: msg.platform, conversationId: msg.conversationId }, 'knowledge_shortcut_hit');
    const replyText = `${hit.content}${KNOWLEDGE_SHORTCUT_SUFFIX}`;
    await this.send(adapter, msg.conversationId, replyText);
    this.recordShortcutRetrieval([hit.id]).catch((err) =>
      logger.warn({ err }, 'Knowledge shortcut retrieval count update failed'),
    );
    await recordInteraction({
      platform: msg.platform,
      conversationId: msg.conversationId,
      userId: 'bot',
      userName: 'CommunityAgent',
      role: 'member',
      direction: 'outbound',
      content: replyText,
      meta: { replyToUserId: msg.userId, knowledgeShortcut: true },
    }).catch((err) => logger.error({ err }, 'Failed to record knowledge-shortcut outbound interaction'));
  }

  /**
   * Guest counterpart to `sendKnowledgeShortcut` (issue #165). Deliberately
   * does NOT call `recordInteraction`: gated-guest content — and the bot's
   * reply to it — is never stored, matching the invariant every other branch
   * of the gated-guest path already preserves (docs/SECURITY.md). Retrieval
   * count/last_retrieved_at is still bumped, same as any other shortcut hit.
   */
  private async sendGuestKnowledgeShortcut(
    msg: IncomingMessage,
    adapter: PlatformAdapter,
    hit: { id: number; content: string },
  ): Promise<void> {
    logger.debug(
      { platform: msg.platform, conversationId: msg.conversationId },
      'guest_knowledge_shortcut_hit',
    );
    const replyText = `${hit.content}${KNOWLEDGE_SHORTCUT_SUFFIX}${GUEST_KNOWLEDGE_SHORTCUT_NUDGE}`;
    await this.send(adapter, msg.conversationId, replyText);
    this.recordShortcutRetrieval([hit.id]).catch((err) =>
      logger.warn({ err }, 'Guest knowledge shortcut retrieval count update failed'),
    );
  }

  private async respond(msg: IncomingMessage, role: Tier, adapter: PlatformAdapter): Promise<void> {
    const caller: CallerContext = {
      platform: msg.platform,
      userId: msg.userId,
      userName: msg.userName,
      role,
      conversationId: msg.conversationId,
    };

    // Best-effort "processing…" signal, fired immediately and then re-fired
    // periodically since a turn can run longer than a single indicator lasts
    // (e.g. Discord auto-clears after ~10s). Never awaited: a hung or
    // rejecting indicator must not delay or break the actual reply. Cleared
    // in `finally` so a thrown turn can't leave a dangling timer.
    const fireTypingIndicator = (): void => {
      adapter.sendTypingIndicator?.(msg).catch((err) => logger.debug({ err }, 'Typing indicator failed'));
    };
    fireTypingIndicator();
    const typingTimer = setInterval(fireTypingIndicator, this.typingRefireMs).unref();

    try {
      // Backstop (issue #52): any unexpected failure between recall and the
      // reply-send must degrade to the same fallback text execTurn already
      // uses — the member always gets *some* reply, never silence. It wraps
      // ONLY the pre-send path: a failure during or after the send is not
      // retried, so at most one outbound reply ever goes out. The error is
      // still logged at error level, and a *persistent* DB outage still
      // trips /healthz + the startup healthcheck — this degradation is
      // per-request only.
      let reply: AgentReply;
      try {
        // Backs cross-platform resolution DMs (issue #157): a per-turn tool
        // handler can look up another platform's already-registered adapter
        // through this instead of only ever having its own turn's adapter.
        reply = await this.runTurn(caller, msg.text, adapter, (platform) => this.adapters.get(platform));
      } catch (err) {
        logger.error(
          { err, conversationId: msg.conversationId },
          'Turn failed before send; sending fallback reply',
        );
        reply = { text: INTERNAL_ERROR_REPLY };
      }

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
    } finally {
      clearInterval(typingTimer);
    }
  }
}
