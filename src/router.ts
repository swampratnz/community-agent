import { config } from './config.js';
import { logger } from './logger.js';
import { isPureAcknowledgement } from './ackClassifier.js';
import { atLeast, type CallerContext, type Tier } from './auth/rbac.js';
import { resolveRole, superAdminIds } from './auth/roles.js';
import type { IncomingMessage, PlatformAdapter } from './platforms/types.js';
import { INTERNAL_ERROR_REPLY, MAX_TURNS_REPLY, runAgentTurn, type AgentReply } from './agent/core.js';
import { formatKnowledgeCitationNote } from './agent/tools.js';
import {
  cancelPendingAction,
  classifyConfirmReply,
  hasPendingAction,
  peekPendingAction,
  sweepExpiredPendingActions,
  takePendingAction,
} from './agent/pendingActions.js';
import { isPaused } from './storage/policies.js';
import {
  countRepliesToUser,
  getLanguagePreference,
  isKnowledgeLowRated,
  recordAccessRequest,
  recordInteraction,
  recordKnowledgeRetrieval,
  searchKnowledge,
} from './storage/repository.js';
import {
  RATE_LIMIT_NOTICE_TEXT,
  RATE_LIMIT_NOTICE_TEXT_MI,
  shouldNotifyRateLimited,
} from './rateLimitNotice.js';
import { PAUSE_NOTICE_TEXT, PAUSE_NOTICE_TEXT_MI, shouldNotifyPaused } from './pauseNotice.js';
import { DAILY_BUDGET_NOTICE_TEXT, DAILY_BUDGET_NOTICE_TEXT_MI } from './dailyBudgetNotice.js';
import { shouldNotifyBudgetCheckFailed } from './budgetCheckFailureNotice.js';
import { buildGatedNotice, GATED_NOTICE } from './gatedNotice.js';

// Fixed, human-authored te reo Māori variant (issue #363), served instead of
// GATED_NOTICE to a gated guest with a standing 'mi' language_prefs row
// (getLanguagePreference, issue #189) — e.g. a former member who set the
// preference before being removed. Same trust level as the English constant:
// no model call, no translation, no injection surface.
export const GATED_NOTICE_MI =
  'Kia ora! He kaupapa mema anake tēnei kaiāwhina. Tonoa he kaiwhakahaere hapori ki te tāpiri i a koe hei mema, kātahi ka taea e au te āwhina.';

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

// Prefix for a REPEAT_QUESTION_SHORTCUT_ENABLED replay (issue #259) — the
// cached text is a real (already-served) answer, not the ack shortcut's
// no-content courtesy reply, so it must be clearly labelled as a repeat
// rather than look like a fresh turn.
const REPEAT_SHORTCUT_NOTICE = "↩️ You asked this a moment ago — here's my answer again:\n\n";

// Prefix for a REPEAT_MAX_TURNS_SHORTCUT_ENABLED replay (issue #306) — makes
// clear this is a replayed prior failure, not a fresh attempt that also
// happened to hit the wall.
const REPEAT_MAX_TURNS_SHORTCUT_NOTICE =
  '↩️ Same request as a moment ago — it still needs breaking down:\n\n';

/** The subset of a KnowledgeSearchHit the shortcut path carries through — just enough to render `formatKnowledgeCitationNote` (issue #214). */
interface KnowledgeShortcutHit {
  id: number;
  content: string;
  updatedAt: Date;
  lastRetrievedAt: Date | null;
  sourceUrl: string | null;
  sourceTitle: string | null;
  verifiedAt: Date | null;
}

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
  /**
   * `platform:conversationId:userId` -> the last successful reply served to
   * that exact caller (issue #259) — scoped to the caller, never just the
   * conversation, so a repeat can never replay one caller's answer to
   * another. Only populated with a genuine answer (`AgentReply.ok === true`)
   * that did not just register a new pending CONFIRM action; consumed by the
   * REPEAT_QUESTION_SHORTCUT_ENABLED short-circuit in `handle()`.
   */
  private readonly lastReply = new Map<string, { normalizedText: string; replyText: string; at: number }>();
  /**
   * `platform:conversationId:userId` -> the last `error_max_turns` failure
   * served to that exact caller (issue #306) — the sibling of `lastReply`
   * above, deliberately kept as its own map rather than folded into it:
   * `lastReply`'s doc comment and read site both assume a hit is "a genuine
   * answer to replay", which a max-turns failure is not. Same caller-scoped
   * key, same window, same sweep; only populated when `AgentReply.
   * maxTurnsExceeded === true`; consumed by the
   * REPEAT_MAX_TURNS_SHORTCUT_ENABLED short-circuit in `handle()`.
   */
  private readonly lastMaxTurnsFailure = new Map<string, { normalizedText: string; at: number }>();

  private readonly PAUSE_NOTIFY_WINDOW_MS = 3_600_000; // 1 hour — a pause is typically longer-lived than a rate-limit burst
  private readonly BUDGET_CHECK_FAILURE_ALERT_WINDOW_MS = 900_000; // 15 minutes — a DB recording failure is a systemic condition, not per-user
  private readonly REPEAT_SHORTCUT_WINDOW_MS = 120_000; // 2 minutes — long enough for a double-tap/impatient-resend, short enough that a genuinely new question with identical text is unlikely

  /**
   * `runTurn` defaults to the real agent core; `typingRefireMs` defaults to a
   * sane production cadence (Discord auto-clears its own indicator after
   * ~10s, so re-firing every 8s keeps it continuously visible). `checkPaused`
   * defaults to the real policy read. `searchKnowledgeForShortcut` and
   * `recordShortcutRetrieval` default to the real DB-backed implementations.
   * `countReplies` defaults to the real daily-budget read. `getLangPref`
   * defaults to the real standing-language-preference read (issue #300).
   * `checkLowRatedKnowledge` defaults to the real DB-backed low-rated check
   * (issue #337), consulted ONLY from the member `sendKnowledgeShortcut`
   * path. `getGatedNotice` defaults to the real TTL-cached, admin-naming
   * gated notice builder (issue #360). All are overridable in tests so the
   * typing-indicator, pause, knowledge-shortcut, budget-check-failure,
   * language-notice, and gated-notice behaviour can be exercised without
   * spawning a real Claude Code subprocess, waiting 8 real seconds, or a
   * live DB.
   */
  constructor(
    private readonly runTurn: typeof runAgentTurn = runAgentTurn,
    private readonly typingRefireMs = 8_000,
    private readonly checkPaused: typeof isPaused = isPaused,
    private readonly searchKnowledgeForShortcut: typeof searchKnowledge = searchKnowledge,
    private readonly recordShortcutRetrieval: typeof recordKnowledgeRetrieval = recordKnowledgeRetrieval,
    private readonly countReplies: typeof countRepliesToUser = countRepliesToUser,
    private readonly getLangPref: typeof getLanguagePreference = getLanguagePreference,
    private readonly checkLowRatedKnowledge: typeof isKnowledgeLowRated = isKnowledgeLowRated,
    private readonly getGatedNotice: typeof buildGatedNotice = buildGatedNotice,
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
    for (const [key, entry] of this.lastReply) {
      if (now - entry.at > this.REPEAT_SHORTCUT_WINDOW_MS) this.lastReply.delete(key);
    }
    for (const [key, entry] of this.lastMaxTurnsFailure) {
      if (now - entry.at > this.REPEAT_SHORTCUT_WINDOW_MS) this.lastMaxTurnsFailure.delete(key);
    }
    sweepExpiredPendingActions();
  }

  register(adapter: PlatformAdapter): void {
    this.adapters.set(adapter.platform, adapter);
    adapter.onMessage((msg) => this.handle(msg));
  }

  /**
   * Waits for every currently in-flight per-conversation chain to settle, or
   * `timeoutMs`, whichever is first (issue #210) — called from shutdown()
   * BEFORE adapter.stop(), so a reply generated during the drain window still
   * goes out on a live connection. `enqueue`'s tracked chain wraps the full
   * turn (generate → filter → send), so waiting on the snapshot already
   * covers the send, not just generation.
   *
   * Snapshots `this.chains.values()` exactly ONCE. Adapters are still
   * connected during the drain, so a message arriving mid-drain can start a
   * NEW chain — deliberately not waited on, or a chatty (or adversarial)
   * conversation could hold shutdown open for the full timeout every time.
   * That late turn is best-effort only; the timeout is the backstop that
   * still bounds total shutdown time regardless.
   */
  async drain(timeoutMs: number): Promise<void> {
    const inFlight = [...this.chains.values()];
    if (inFlight.length === 0) return;

    const timedOut = await Promise.race([
      Promise.allSettled(inFlight).then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), timeoutMs).unref()),
    ]);
    logger.info(
      { inFlight: inFlight.length, timedOut },
      timedOut
        ? 'Shutdown drain timed out with turns still in flight'
        : 'Shutdown drain: all in-flight turns settled',
    );
  }

  private convoKey(msg: IncomingMessage): string {
    return `${msg.platform}:${msg.conversationId}`;
  }

  /** Scoped to the individual caller (issue #259), unlike `convoKey` — so the repeat-question cache can never replay across users sharing a conversation. */
  private callerKey(msg: IncomingMessage): string {
    return `${msg.platform}:${msg.conversationId}:${msg.userId}`;
  }

  /** Whitespace-only normalization for the repeat-question shortcut (issue #259) — deliberately no case-folding or fuzzy matching, so it only ever catches a byte-for-byte resend. */
  private normalize(text: string): string {
    return text.trim().replace(/\s+/g, ' ');
  }

  private rateLimited(userKey: string): boolean {
    const now = Date.now();
    const hits = (this.userHits.get(userKey) ?? []).filter((t) => now - t < this.RATE_WINDOW_MS);
    hits.push(now);
    this.userHits.set(userKey, hits);
    return hits.length > this.RATE_LIMIT;
  }

  /**
   * Outbound filtering (secrets + code policy) lives in the adapters' send
   * paths. `language` is optional and threaded straight into
   * `adapter.sendMessage` (issue #339) — every call site except the main
   * reply send below omits it, so they stay byte-identical to before.
   */
  private async send(
    adapter: PlatformAdapter,
    conversationId: string,
    text: string,
    language?: 'mi',
  ): Promise<void> {
    await adapter.sendMessage({ conversationId, text, language });
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
            // Lookup fires only on this static-notice branch — never on the
            // guest-knowledge-shortcut-hit branch above, and never on the
            // rate-limited path (the `if (!this.rateLimited(userKey))` guard),
            // so no extra DB read is paid where no gated notice is sent
            // (issue #363 adversarial review). A standing 'mi' preference
            // gets the fixed, human-authored translation as-is (no admin-name
            // enumeration); everyone else gets the dynamic, admin-naming
            // English builder (issue #360), which already degrades to the
            // static GATED_NOTICE internally on a DB failure — the extra
            // catch here is defense-in-depth so an injected/future builder
            // can never turn a lookup failure into silence for a gated guest.
            const lang = await this.getLangPref(msg.platform, msg.userId).catch(() => 'auto' as const);
            const notice =
              lang === 'mi'
                ? GATED_NOTICE_MI
                : await this.getGatedNotice(msg.platform).catch((err) => {
                    logger.warn({ err }, 'Gated notice builder failed; using the static fallback');
                    return GATED_NOTICE;
                  });
            await this.send(adapter, msg.conversationId, notice).catch((err) =>
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
        // Lookup sits inside the debounce guard (issue #300) so a paused
        // channel's shed messages never pay a per-message DB read — at most
        // once per PAUSE_NOTIFY_WINDOW_MS per user, same as the send itself.
        const lang = await this.getLangPref(msg.platform, msg.userId).catch(() => 'auto' as const);
        await this.send(
          adapter,
          msg.conversationId,
          lang === 'mi' ? PAUSE_NOTICE_TEXT_MI : PAUSE_NOTICE_TEXT,
        ).catch(() => {});
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
        // Lookup sits inside the debounce guard (issue #300) — the
        // rate-limit path exists to shed load, so it must not add a
        // per-message DB read to every over-limit message.
        const lang = await this.getLangPref(msg.platform, msg.userId).catch(() => 'auto' as const);
        await this.send(
          adapter,
          msg.conversationId,
          lang === 'mi' ? RATE_LIMIT_NOTICE_TEXT_MI : RATE_LIMIT_NOTICE_TEXT,
        ).catch(() => {});
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
          // Lookup sits inside the debounce guard (issue #300) — the daily
          // budget path exists to shed load, so it must not add a
          // per-message DB read to every over-budget message.
          const lang = await this.getLangPref(msg.platform, msg.userId).catch(() => 'auto' as const);
          await this.send(
            adapter,
            msg.conversationId,
            lang === 'mi' ? DAILY_BUDGET_NOTICE_TEXT_MI : DAILY_BUDGET_NOTICE_TEXT,
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

    // Deterministic repeat-question short-circuit (issue #259): the same
    // caller (platform + conversation + user) sending the exact
    // whitespace-normalized text again inside REPEAT_SHORTCUT_WINDOW_MS gets
    // the cached reply from their own last successful turn instead of a
    // second full query() turn. Evaluated after both the ack and knowledge
    // shortcuts above. `lastReply` is only ever populated in `respond()` with
    // a genuine answer (`AgentReply.ok === true`) that did not just register
    // a new pending CONFIRM action, so there is never a stale confirm/error
    // reply to replay. Off by default.
    if (config.behaviour.repeatQuestionShortcutEnabled) {
      const cached = this.lastReply.get(this.callerKey(msg));
      if (
        cached &&
        cached.normalizedText === this.normalize(msg.text) &&
        Date.now() - cached.at < this.REPEAT_SHORTCUT_WINDOW_MS
      ) {
        logger.debug(
          { platform: msg.platform, conversationId: msg.conversationId },
          'repeat_question_shortcut_hit',
        );
        await this.enqueue(key, 'repeat-question shortcut reply', () =>
          this.sendRepeatShortcut(msg, adapter, cached.replyText),
        );
        return;
      }
    }

    // Deterministic max-turns repeat short-circuit (issue #306): the sibling
    // of the shortcut above, for the one outcome it deliberately excludes — a
    // turn that exhausted AGENT_MAX_TURNS. Same caller key, same normalized
    // text match, same window; guaranteed to hit the exact same wall again
    // (same input, tools, system prompt), so a second full turn is pure
    // wasted spend. Off by default.
    if (config.behaviour.repeatMaxTurnsShortcutEnabled) {
      const cachedFailure = this.lastMaxTurnsFailure.get(this.callerKey(msg));
      if (
        cachedFailure &&
        cachedFailure.normalizedText === this.normalize(msg.text) &&
        Date.now() - cachedFailure.at < this.REPEAT_SHORTCUT_WINDOW_MS
      ) {
        logger.debug(
          { platform: msg.platform, conversationId: msg.conversationId },
          'repeat_max_turns_shortcut_hit',
        );
        await this.enqueue(key, 'repeat-max-turns shortcut reply', () =>
          this.sendRepeatMaxTurnsShortcut(msg, adapter),
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
  ): Promise<KnowledgeShortcutHit | null> {
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
    return {
      id: top.id,
      content: top.content,
      updatedAt: top.updatedAt,
      lastRetrievedAt: top.lastRetrievedAt,
      sourceUrl: top.sourceUrl,
      sourceTitle: top.sourceTitle,
      verifiedAt: top.verifiedAt,
    };
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
    hit: KnowledgeShortcutHit,
  ): Promise<void> {
    logger.debug({ platform: msg.platform, conversationId: msg.conversationId }, 'knowledge_shortcut_hit');
    // Member-facing low-rated-answer caveat (issue #337) — opt-in, and
    // deliberately only ever computed on THIS path (never the guest
    // shortcut or knowledge_search): the extra count query is skipped
    // entirely when the feature is disabled (the default), and a lookup
    // failure falls back to `false` rather than blocking the reply.
    const lowRatedCaveat =
      config.behaviour.knowledgeLowRatedCaveatMinUnhelpful > 0
        ? await this.checkLowRatedKnowledge(
            hit.id,
            config.behaviour.knowledgeLowRatedCaveatMinUnhelpful,
          ).catch((err) => {
            logger.warn({ err }, 'Knowledge low-rated caveat lookup failed; omitting the caveat');
            return false;
          })
        : false;
    // Deterministic, send-path-only citation/freshness note (issue #214) — the
    // shortcut never involves the model, so this is formatted from stored
    // fields exactly like knowledge_search's own note.
    const note = formatKnowledgeCitationNote(hit, config.adminDigest.knowledgeStaleDays, lowRatedCaveat);
    const replyText = `${hit.content}${note}${KNOWLEDGE_SHORTCUT_SUFFIX}`;
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
      meta: { replyToUserId: msg.userId, knowledgeShortcut: true, knowledgeEntryId: hit.id },
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
    hit: KnowledgeShortcutHit,
  ): Promise<void> {
    logger.debug(
      { platform: msg.platform, conversationId: msg.conversationId },
      'guest_knowledge_shortcut_hit',
    );
    const note = formatKnowledgeCitationNote(hit, config.adminDigest.knowledgeStaleDays);
    const replyText = `${hit.content}${note}${KNOWLEDGE_SHORTCUT_SUFFIX}${GUEST_KNOWLEDGE_SHORTCUT_NUDGE}`;
    await this.send(adapter, msg.conversationId, replyText);
    this.recordShortcutRetrieval([hit.id]).catch((err) =>
      logger.warn({ err }, 'Guest knowledge shortcut retrieval count update failed'),
    );
  }

  /**
   * Sends a cached reply for a repeat-question shortcut hit (issue #259) and
   * records it exactly like a normal agent reply — counted toward
   * `dailyReplyLimitPerUser`, visible to admin history/digest views — mirroring
   * `sendKnowledgeShortcut`'s precedent (#162, point 4).
   */
  private async sendRepeatShortcut(
    msg: IncomingMessage,
    adapter: PlatformAdapter,
    cachedReplyText: string,
  ): Promise<void> {
    const replyText = `${REPEAT_SHORTCUT_NOTICE}${cachedReplyText}`;
    await this.send(adapter, msg.conversationId, replyText);
    await recordInteraction({
      platform: msg.platform,
      conversationId: msg.conversationId,
      userId: 'bot',
      userName: 'CommunityAgent',
      role: 'member',
      direction: 'outbound',
      content: replyText,
      meta: { replyToUserId: msg.userId, repeatShortcut: true },
    }).catch((err) => logger.error({ err }, 'Failed to record repeat-shortcut outbound interaction'));
  }

  /**
   * Sends the canned max-turns message for a repeat-max-turns shortcut hit
   * (issue #306) without spawning a second full agent turn, and records it
   * like a normal outbound reply — mirroring `sendRepeatShortcut`'s
   * precedent (#259).
   */
  private async sendRepeatMaxTurnsShortcut(msg: IncomingMessage, adapter: PlatformAdapter): Promise<void> {
    const replyText = `${REPEAT_MAX_TURNS_SHORTCUT_NOTICE}${MAX_TURNS_REPLY}`;
    await this.send(adapter, msg.conversationId, replyText);
    await recordInteraction({
      platform: msg.platform,
      conversationId: msg.conversationId,
      userId: 'bot',
      userName: 'CommunityAgent',
      role: 'member',
      direction: 'outbound',
      content: replyText,
      meta: { replyToUserId: msg.userId, repeatMaxTurnsShortcut: true },
    }).catch((err) =>
      logger.error({ err }, 'Failed to record repeat-max-turns-shortcut outbound interaction'),
    );
  }

  private async respond(msg: IncomingMessage, role: Tier, adapter: PlatformAdapter): Promise<void> {
    const caller: CallerContext = {
      platform: msg.platform,
      userId: msg.userId,
      userName: msg.userName,
      role,
      conversationId: msg.conversationId,
      isDirect: msg.isDirect,
      messageId: msg.messageId,
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
      // Snapshot any pre-existing pending action so we can tell a freshly
      // registered one (this turn) from one already waiting.
      const priorPending = peekPendingAction(msg.platform, msg.conversationId, msg.userId);

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
        // Explicit `ok: false` (never rely on the field being absent/falsy —
        // issue #259's repeat-question shortcut reads `reply.ok` directly).
        reply = { text: INTERNAL_ERROR_REPLY, ok: false };
      }

      // Only this call site — the real-agent-turn main reply — threads the
      // caller's language preference into the send (issue #339). Every other
      // `this.send(...)` in this file (gated notice, cancel, ack shortcuts,
      // pending notice, ...) intentionally omits it and stays English-only.
      await this.send(
        adapter,
        msg.conversationId,
        reply.text,
        reply.languagePreference === 'mi' ? 'mi' : undefined,
      );

      // If the turn registered a NEW pending destructive action, the model
      // composed the reply above and could have hidden or misrepresented the
      // action behind an innocuous "reply CONFIRM" (an injection lever). Emit
      // the authoritative pending description ourselves, deterministically, so
      // the human always sees the true action before they can confirm it
      // (issue: CONFIRM gate was request-side model-mediated).
      const pending = peekPendingAction(msg.platform, msg.conversationId, msg.userId);
      const registeredNewPending = Boolean(pending && pending !== priorPending);
      if (pending && registeredNewPending) {
        await this.send(
          adapter,
          msg.conversationId,
          `⚠️ Pending: ${pending.description}\nReply CONFIRM within 60 seconds to proceed, or CANCEL to abort. ` +
            `(This confirmation is handled outside the AI and must come from you in this conversation.)`,
        ).catch((err) => logger.warn({ err }, 'Failed to send deterministic pending notice'));
      }

      // Cache this reply for the repeat-question shortcut (issue #259):
      // only ever a genuine answer (never a fallback/error — reply.ok must
      // be exactly true) that did NOT just register a new pending CONFIRM
      // action, so a repeat can never replay stale "reply CONFIRM" text with
      // no live pending action behind it.
      if (config.behaviour.repeatQuestionShortcutEnabled && reply.ok === true && !registeredNewPending) {
        this.lastReply.set(this.callerKey(msg), {
          normalizedText: this.normalize(msg.text),
          replyText: reply.text,
          at: Date.now(),
        });
      }

      // Cache this failure for the max-turns repeat shortcut (issue #306):
      // only ever a genuine `error_max_turns` failure (`reply.maxTurnsExceeded
      // === true`, never a truthy-ish absent value) — never a success, never
      // any other kind of failure — so a repeat can only ever short-circuit
      // the one guaranteed-to-repeat outcome.
      if (config.behaviour.repeatMaxTurnsShortcutEnabled && reply.maxTurnsExceeded === true) {
        this.lastMaxTurnsFailure.set(this.callerKey(msg), {
          normalizedText: this.normalize(msg.text),
          at: Date.now(),
        });
      }

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
