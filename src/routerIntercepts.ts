import type { IncomingMessage, PlatformAdapter } from './platforms/types.js';
import type { Tier } from './auth/rbac.js';
import type { Router } from './router.js';

/**
 * The router's pre-turn intercept chain (agent-base plan §3 `intercepts` row,
 * Phase-1 item 7) — the explicit, ordered decomposition of what used to be
 * one long inline sequence in `Router.handle()`.
 *
 * SECURITY: this file is part of the security spine (docs/SECURITY.md). The
 * chain has two regions with different trust rules:
 *
 * 1. **The spine** (`PRE_TURN_SPINE`): the security-ordered steps — frozen,
 *    base-owned, non-reorderable. Their relative order is load-bearing (the
 *    CONFIRM intercept runs BEFORE the addressed check so a bare "CONFIRM"
 *    works in groups; pause runs before rate-limit so a paused user never
 *    sees both notices; the daily budget runs after both so shed messages
 *    never pay a budget read; ...). The Router builds this region itself from
 *    the frozen name list — there is NO registration API that can insert,
 *    remove, or reorder a spine step, and the `SECURITY:` chain test pins the
 *    exact order.
 * 2. **The post-spine region**: module-registered intercepts
 *    (`registerPreTurnIntercept`) — today the ack/knowledge/repeat shortcuts
 *    and the WhatsApp `!` text commands, registered by `router.ts` in their
 *    long-standing order. Registration can only ever APPEND here, after every
 *    spine step has passed, so nothing a module registers can run before
 *    block/role/gate/CONFIRM/pause/rate/budget or otherwise bypass them.
 */

/** What one intercept step decided: keep going, or the message is fully handled (stop the chain). */
export type InterceptOutcome = 'continue' | 'handled';

/**
 * Mutable per-message state threaded through the chain — spine steps populate
 * it (role resolution, the fire-and-forget inbound record, the reply-budget
 * read, the auto-answer candidacy/thread), later steps and the final
 * `respond()` dispatch read it. Fields are optional because each is only set
 * once its producing spine step has run; post-spine intercepts may rely on
 * every spine-produced field being present.
 */
export interface PreTurnState {
  /** Resolved caller tier — set by the `role-resolution` spine step, never from message content. */
  role?: Tier;
  /** The fire-and-forget inbound `recordInteraction` promise, awaited by the `memory-barrier` step. */
  recorded?: Promise<void>;
  /** `${platform}:${userId}` — set by the `rate-limit` step, reused by `daily-budget`. */
  userKey?: string;
  /** The already-fetched daily-budget read, threaded into `respond()` for the approaching-budget warning (issue #511). */
  replyBudget?: { used: number; limit: number };
  /** Whether this message qualifies for the auto-answer path (issue #477) — set by `addressed-gate`. */
  isAutoAnswerCandidate?: boolean;
  /** Parent channel id when the message arrived inside a live bot-opened auto-answer thread (issue #519). */
  autoAnswerThreadParent?: string;
  /** Where the reply should go when it differs from the origin (auto-answer thread) — set by `auto-answer-thread`. */
  replyConversationId?: string;
}

/** Everything an intercept step sees for one inbound message. */
export interface PreTurnContext {
  msg: IncomingMessage;
  adapter: PlatformAdapter;
  /** The owning Router — post-spine intercepts call back into its (public) shortcut helpers. */
  router: Router;
  state: PreTurnState;
}

export interface PreTurnIntercept {
  name: string;
  run(ctx: PreTurnContext): Promise<InterceptOutcome>;
}

/**
 * The security spine, in the exact order `Router.handle()` has always run it
 * (audited from the pre-split inline sequence — note the CONFIRM/escalation
 * intercepts sit BEFORE the addressed gate, and the auto-answer
 * reserve/thread machinery is spine too: it bounds an untrusted-input path's
 * cost and must not be reorderable around rate/budget). Frozen: nothing can
 * be inserted, removed, or reordered at runtime, and the `SECURITY:` chain
 * test asserts both the freeze and the exact order.
 */
export const PRE_TURN_SPINE = Object.freeze([
  'block-list',
  'role-resolution',
  'gated-guest',
  'record-inbound',
  'confirm-intercept',
  'escalation-confirm',
  'addressed-gate',
  'pause',
  'rate-limit',
  'daily-budget',
  'auto-answer-reserve',
  'memory-barrier',
  'auto-answer-thread',
] as const);

export type SpineStepName = (typeof PRE_TURN_SPINE)[number];

const SPINE_NAMES: ReadonlySet<string> = new Set(PRE_TURN_SPINE);

const postSpineIntercepts: PreTurnIntercept[] = [];

/**
 * Register a pre-turn intercept in the post-spine region. Append-only by
 * construction: the designated extension region starts after the last spine
 * step, so a registered intercept can never run before block/role/gate/
 * CONFIRM/pause/rate/budget. Reusing a spine step's name (or an
 * already-registered name) is rejected outright rather than shadowing it.
 */
export function registerPreTurnIntercept(intercept: PreTurnIntercept): void {
  if (SPINE_NAMES.has(intercept.name)) {
    throw new Error(`Pre-turn intercept name collides with a security-spine step: ${intercept.name}`);
  }
  if (postSpineIntercepts.some((existing) => existing.name === intercept.name)) {
    throw new Error(`Pre-turn intercept already registered: ${intercept.name}`);
  }
  postSpineIntercepts.push(intercept);
}

/** The post-spine intercepts in registration order — consumed by `Router.preTurnChain()`. */
export function registeredPreTurnIntercepts(): readonly PreTurnIntercept[] {
  return postSpineIntercepts;
}
