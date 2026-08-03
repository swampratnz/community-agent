import { z } from 'zod';
import type { EnvRefinement } from './env.js';

/** Behaviour slice (config.behaviour): runtime knobs on the reply hot path. */
export const behaviourSlice = {
  // Behaviour
  MEMORY_TOP_K: z.coerce.number().int().nonnegative().default(6),
  // Cosine-similarity floor for automatic memory recall and remember_search
  // (issue #474), mirroring KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD's shape but
  // kept separate and tunable rather than hardcoded, since memory recall has
  // no eval fixture yet to derive a production-safe always-on default from.
  // Default 0 = no floor (byte-identical to today's behaviour), matching this
  // repo's convention for opt-in knobs (e.g. KNOWLEDGE_CANDIDATE_STALE_DAYS).
  MEMORY_RELEVANCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0),
  // Max agent replies per user per rolling 24h (0 = unlimited).
  DAILY_REPLY_LIMIT_PER_USER: z.coerce.number().int().nonnegative().default(50),
  // Session hygiene: start a fresh Claude session past either cap.
  SESSION_MAX_TURNS: z.coerce.number().int().positive().default(30),
  SESSION_MAX_AGE_HOURS: z.coerce.number().positive().default(24),
  // Fresh-session continuity: when a turn can't resume a prior session
  // (rollover past either cap above, a cleared session, or a failed resume),
  // backfill this many of the conversation's most recent messages into the
  // first turn as quarantined reference context — otherwise the bot goes
  // amnesiac mid-conversation, with only semantic recall (keyed on the
  // CURRENT message text) to reconstruct what was just said. 0 = disabled.
  SESSION_ROLLOVER_TAIL_COUNT: z.coerce.number().int().nonnegative().default(10),
  // Wall-clock ceiling on a single Agent SDK `query()` turn (issue #826): a
  // hung iteration (network partition, wedged CLI subprocess) never rejects,
  // so nothing but a race against this timer unblocks it — and because turns
  // are serialised per conversation (router.ts's enqueue()), an unbounded
  // hang here wedges that conversation's entire chain, not just one reply.
  // Same "a .catch() only fires on rejection" gap #502 closed for the DB pool
  // (DB_QUERY_TIMEOUT_MS). Default must stay strictly greater than
  // IMAGE_GEN_TIMEOUT_MS (180_000): image generation is a tool call that runs
  // *inside* this turn loop, so an outer ceiling at or below the inner tool's
  // own timeout would kill a legitimately in-flight image-gen turn first.
  AGENT_TURN_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  // Ceiling on the member's own message text reaching the paid model call
  // (runAgentTurn's local `userText` copy only — never `msg.text` itself, so
  // archiving/classification/echo still see the full original). 0 = disabled
  // (byte-identical to today's unbounded behaviour). 8,000 chars (~2,000
  // tokens) is generous for a real snippet while bounding a pasted log/code
  // dump, which otherwise inflates one turn's cost and, via session resume,
  // the cached prefix every subsequent turn re-reads.
  MAX_INCOMING_MESSAGE_CHARS: z.coerce.number().int().nonnegative().default(8_000),
  // Age-based purge of raw `interactions` content. Unset/0 = disabled (no
  // behaviour change on upgrade). knowledge/admin_audit/sessions are never
  // touched by this — see storage/repository.ts:purgeOldInteractions.
  INTERACTION_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(0),
  // Age-based purge of `server_roster` rows for members who have LEFT
  // (left_at IS NOT NULL). Unset/0 = disabled (no behaviour change on
  // upgrade). Currently-present members (left_at IS NULL) are never touched
  // regardless of this setting — see storage/repository.ts:purgeDepartedRoster.
  ROSTER_DEPARTED_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(0),
  // Age-based purge of PENDING `access_requests` rows that have gone quiet
  // (issue #939). Unset/0 = disabled (no behaviour change on upgrade). Clock
  // runs off last_requested_at, so a guest who is still asking is never
  // purged; an approved requester's row is already deleted on add_member.
  // See storage/repository.ts:purgeOldAccessRequests.
  ACCESS_REQUEST_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(0),
  // Sustained platform disconnect -> one debounced super-admin DM alert.
  HEALTH_ALERT_AFTER_MINUTES: z.coerce.number().positive().default(5),
  // Proactive super-admin alert when rolling-24h outbound reply count
  // reaches this threshold — a coarse proxy for shared Max-pool draw (short
  // vs long replies draw differently; tune to your traffic). Unset/0 =
  // disabled (no timer, no behaviour change on upgrade).
  USAGE_ALERT_DAILY_REPLIES: z.coerce.number().int().nonnegative().default(0),
  // Debounced super-admin DM when an agent turn fails on an upstream Claude
  // usage-limit/overload condition (issue #131) — distinct from usage-alert's
  // proactive threshold on successful replies. Off by default, consistent
  // with this repo's convention for new proactive DMs.
  UPSTREAM_LIMIT_ALERT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),

  // Skip the agent turn entirely for pure acknowledgements ("thanks", "👍")
  // with no other content — sends one static reply instead. Off by default;
  // an operator opts in after confirming the canned reply tone fits their
  // community. See src/ackClassifier.ts.
  ACK_SHORTCUT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Skip the agent turn entirely when a message near-exactly matches an
  // existing knowledge entry — replies with that entry's content directly
  // instead of spawning a query() turn. Off by default; see src/router.ts
  // and docs/ARCHITECTURE.md "Known cost/latency characteristic".
  KNOWLEDGE_SHORTCUT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Cosine-similarity floor for the knowledge shortcut above — deliberately
  // much stricter than KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD (0.35, the
  // `knowledge_search` tool's "worth mentioning" floor): this bar gates an
  // unsupervised full-turn skip, not a suggestion the model can hedge on, so
  // it must only fire on a near-exact match. Tuned against
  // tests/fixtures/knowledgeEval.json's negativeQueries.
  KNOWLEDGE_SHORTCUT_THRESHOLD: z.coerce.number().min(0).max(1).default(0.9),
  // Member-facing low-rated-answer caveat (issue #337): when serving a
  // knowledge entry via the member knowledge shortcut, append a fixed
  // caveat clause if the entry's global unhelpfulCount is at/above this
  // threshold. Unset/0 = disabled (no extra query, byte-identical output),
  // matching the KNOWLEDGE_STALE_DAYS opt-in convention above. When set, it
  // must be >= 2 — refined below — so a single rater can never trigger it.
  KNOWLEDGE_LOW_RATED_CAVEAT_MIN_UNHELPFUL: z.coerce.number().int().nonnegative().default(0),
  // Cap on how many titles `list_knowledge_topics` (issue #437) returns in
  // one reply — a member-facing browse tool, unlike KNOWLEDGE_STALE_DAYS'
  // opt-in-at-0 convention this is always-on with a sane default, matching
  // EVENTS_LIST_LIMIT's "cap KB growth never produces an unbounded reply"
  // reasoning but env-configurable per the approved proposal.
  KNOWLEDGE_TOPICS_LIST_LIMIT: z.coerce.number().int().positive().default(50),
  // Extend the knowledge shortcut above to gated guests (issue #165),
  // restricted to `scope='global'` entries only, before the static "ask an
  // admin" pointer. Reuses KNOWLEDGE_SHORTCUT_THRESHOLD — no separate knob to
  // tune. Off by default: with it unset, the gated-guest path is
  // byte-for-byte unchanged. See src/router.ts.
  GUEST_KNOWLEDGE_SHORTCUT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Skip the agent turn entirely when the SAME caller (platform + conversation
  // + user) sends the exact same whitespace-normalized text twice within a
  // short window (double-tap/impatient-resend/client retry) — replies with
  // the cached answer from the first turn instead of spawning a second
  // query() turn. Off by default; see src/router.ts (issue #259).
  REPEAT_QUESTION_SHORTCUT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Sibling to REPEAT_QUESTION_SHORTCUT_ENABLED (issue #306): skip the agent
  // turn entirely when the SAME caller sends the exact same whitespace-
  // normalized text twice within REPEAT_SHORTCUT_WINDOW_MS of a turn that
  // failed on `error_max_turns` — replies with the same canned max-turns
  // message instead of spending a second full (guaranteed-to-repeat)
  // AGENT_MAX_TURNS budget. Deliberately a separate flag/map from the
  // success-only #259 shortcut. Off by default; see src/router.ts.
  REPEAT_MAX_TURNS_SHORTCUT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // WhatsApp-only, zero-model-call text commands (issue #859) — the WhatsApp
  // counterpart to Discord's slash commands (DISCORD_SLASH_COMMANDS_ENABLED
  // above), re-keyed for a platform with no native command UI: `!whois
  // <query>`, `!projects [query]`, `!guidelines`, `!digest`. `!kb` is
  // deliberately not added — KNOWLEDGE_SHORTCUT_ENABLED already gives
  // WhatsApp an equivalent. Off by default, same convention as the other
  // shortcut flags above; checked in Router.handle() alongside them. See
  // src/router.ts and docs/ARCHITECTURE.md.
  WHATSAPP_TEXT_COMMANDS_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Real-time admin escalation after a max-turns failure (issue #479): when a
  // turn ends with `reply.maxTurnsExceeded === true`, append a "reply yes to
  // flag this for a community admin" offer to the fixed MAX_TURNS_REPLY/_MI
  // fallback and register a matching pending entry (same caller-key/TTL shape
  // as `lastMaxTurnsFailure` above). A confirmed "yes"/"y"/"āe" within the
  // window notifies every `listAdmins()` row via `notifyAdmins` — entirely
  // router-level, never routed through the model. Off by default; see
  // src/router.ts.
  ESCALATION_TO_ADMIN_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Push-side complement to #444's pull-only `my_data` budget figure (issue
  // #511): once a non-super-admin caller's remaining daily replies fall to
  // DAILY_REPLY_BUDGET_WARN_REMAINING or fewer, append one fixed line to the
  // real reply naming the remaining count, debounced to once per rolling 24h
  // (mirrors budgetNotified's window). Off by default: with it unset, the
  // reply is byte-identical to today's for every used/limit combination. See
  // src/router.ts.
  DAILY_REPLY_BUDGET_WARN_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // How many replies remain (inclusive) before the warning above fires.
  // Always a positive count — unlike the "0 disabled" knobs above, disabling
  // this feature is DAILY_REPLY_BUDGET_WARN_ENABLED=false, not a 0 here.
  DAILY_REPLY_BUDGET_WARN_REMAINING: z.coerce.number().int().positive().default(5),
  // Auto-retract the bot's own reply when the member deletes the message it
  // answered (issue #575) — a native platform delete/revoke event, server-
  // side plumbing only, never model-reachable. Off by default: with it
  // unset, deleting a message the bot replied to leaves the reply untouched
  // and calls no adapter deletion method (byte-identical to today). See
  // src/replyRetraction.ts, src/router.ts, and the Discord/WhatsApp Baileys
  // adapters' delete/revoke listeners.
  AUTO_RETRACT_REPLY_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // How long shutdown() waits for in-flight per-conversation turns to settle
  // before proceeding to adapter.stop()/closeDb() (issue #210). Comfortably
  // inside systemd's default 90s TimeoutStopSec for community-agent.service
  // (see docs/DEPLOYMENT.md), so a normal restart never needs tuning this.
  SHUTDOWN_DRAIN_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  // /healthz + /readyz endpoints (native http, no auth). Unset = disabled.
  HEALTH_PORT: z.coerce.number().int().positive().optional(),
  // Interface the health server binds to. Defaults to loopback so the
  // unauthenticated endpoint is NOT reachable off-box unless the operator
  // deliberately fronts it with a reverse proxy or sets 0.0.0.0 (issue #220).
  HEALTH_HOST: z.string().min(1).default('127.0.0.1'),
};

// Retention must stay well clear of the active-conversation window
// (SESSION_MAX_AGE_HOURS) so a low value can't silently gut memory recall
// for users still mid-conversation.
const MIN_INTERACTION_RETENTION_DAYS = 7;

// list_roster's churn windows ("joined/left this week") are 7 days; a 30-day
// floor comfortably preserves that pulse while still bounding retention.
const MIN_ROSTER_DEPARTED_RETENTION_DAYS = 30;

// A pending access request is a person waiting on a human decision, so the
// floor is set by how long admins can plausibly take to make one, not by how
// fast the data could be dropped. 30 days matches the roster floor and keeps
// this comfortably clear of the admin digest's own nag horizon — enabling
// retention must never delete a backlog out from under the digest that exists
// to surface it. It also bounds `oldestAccessRequestAgeDays` from above (see
// its doc comment), which is only honest if the bound is generous.
const MIN_ACCESS_REQUEST_RETENTION_DAYS = 30;

// A single rater must never be able to trigger the member-facing low-rated
// caveat (issue #337) — the effective minimum is 2 so the signal always
// reflects more than one identifiable person's opinion.
const MIN_KNOWLEDGE_LOW_RATED_CAVEAT_MIN_UNHELPFUL = 2;

export type BehaviourEnv = z.infer<z.ZodObject<typeof behaviourSlice>>;

export const behaviourRefinements: EnvRefinement<BehaviourEnv>[] = [
  {
    check: (e) =>
      e.INTERACTION_RETENTION_DAYS === 0 || e.INTERACTION_RETENTION_DAYS >= MIN_INTERACTION_RETENTION_DAYS,
    params: {
      message: `INTERACTION_RETENTION_DAYS must be 0 (disabled) or at least ${MIN_INTERACTION_RETENTION_DAYS}`,
      path: ['INTERACTION_RETENTION_DAYS'],
    },
  },
  {
    check: (e) =>
      e.ROSTER_DEPARTED_RETENTION_DAYS === 0 ||
      e.ROSTER_DEPARTED_RETENTION_DAYS >= MIN_ROSTER_DEPARTED_RETENTION_DAYS,
    params: {
      message: `ROSTER_DEPARTED_RETENTION_DAYS must be 0 (disabled) or at least ${MIN_ROSTER_DEPARTED_RETENTION_DAYS}`,
      path: ['ROSTER_DEPARTED_RETENTION_DAYS'],
    },
  },
  {
    check: (e) =>
      e.ACCESS_REQUEST_RETENTION_DAYS === 0 ||
      e.ACCESS_REQUEST_RETENTION_DAYS >= MIN_ACCESS_REQUEST_RETENTION_DAYS,
    params: {
      message: `ACCESS_REQUEST_RETENTION_DAYS must be 0 (disabled) or at least ${MIN_ACCESS_REQUEST_RETENTION_DAYS}`,
      path: ['ACCESS_REQUEST_RETENTION_DAYS'],
    },
  },
  {
    check: (e) =>
      e.KNOWLEDGE_LOW_RATED_CAVEAT_MIN_UNHELPFUL === 0 ||
      e.KNOWLEDGE_LOW_RATED_CAVEAT_MIN_UNHELPFUL >= MIN_KNOWLEDGE_LOW_RATED_CAVEAT_MIN_UNHELPFUL,
    params: {
      message: `KNOWLEDGE_LOW_RATED_CAVEAT_MIN_UNHELPFUL must be 0 (disabled) or at least ${MIN_KNOWLEDGE_LOW_RATED_CAVEAT_MIN_UNHELPFUL}`,
      path: ['KNOWLEDGE_LOW_RATED_CAVEAT_MIN_UNHELPFUL'],
    },
  },
];
