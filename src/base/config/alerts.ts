import { z } from 'zod';
import type { EnvRefinement } from './env.js';

/**
 * Alerts & digests slice (config.adminDigest + config.departedAdminAlert +
 * config.engagementAlert + config.adminLeverageAlert +
 * config.knowledgeGapAlert + config.knowledgeStaleAlert +
 * config.repeatQuestionAlert + config.accessRequestAlert +
 * config.usageCostDigest + config.backgroundJobCostAlert +
 * config.memberDigest): every proactive push surface.
 */
export const alertsSlice = {
  // Proactive super-admin alert (issue #472) when listAdminRoster() shows one
  // or more current admins have left the server/group but still hold
  // admin-tier privilege via DM — closes #428's own named deferred growth
  // path from passive (list_admins, pull) to active (DM, push). Off by
  // default, consistent with this repo's convention for new proactive DMs.
  DEPARTED_ADMIN_ALERT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Real-time admin alert (issue #480) fired the moment a gated guest's
  // FIRST-EVER addressed message creates a fresh `access_requests` row — the
  // discrete-event complement to the weekly digest's passive
  // `pendingAccessRequests` count, same "push what was pullable" precedent as
  // `notifyReportFiled` (#90). Router-only side effect off
  // `recordAccessRequest`'s insert-vs-update `RETURNING` value; never routed
  // through the agent/model loop. Off by default, consistent with this repo's
  // convention for new proactive DMs.
  ACCESS_REQUEST_ALERT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Weekly super-admin cost-trend DM (issue #578): compares this week's
  // usageStats(7) total against last week's persisted total and DMs the
  // signed delta. Complementary to USAGE_ALERT_DAILY_REPLIES's reactive
  // volume latch — this always reports the trend on a weekly cadence. Off by
  // default, consistent with this repo's convention for new proactive DMs.
  USAGE_COST_DIGEST_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Proactive super-admin DM when a background job's (moderation_llm/
  // context_builder/knowledge_refresh) trailing-24h cost spikes far above its
  // own trailing 7-day daily average (issue #610) — the one aggregate in
  // usage_stats' backgroundCostByJob breakdown with zero proactive push. Off
  // by default, consistent with this repo's convention for new proactive DMs.
  BACKGROUND_JOB_COST_ALERT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // A job alerts only when BOTH hold: today's cost exceeds multiplier ×
  // (trailing 7-day total ÷ 7) for that job, AND exceeds the absolute floor
  // below. The floor stops a job going from $0.01 to $0.05 (technically 5×)
  // from paging anyone over noise.
  BACKGROUND_JOB_COST_ALERT_MULTIPLIER: z.coerce.number().positive().default(3),
  BACKGROUND_JOB_COST_ALERT_MIN_USD: z.coerce.number().positive().default(1),
  // Proactive super-admin alert (issue #568) pushing engagement_stats' (issue
  // #419) guild-wide engagement percentage on a weekly cadence — closes the
  // same pull-only gap #472/#480 closed for other super-admin-only signals.
  // Off by default, consistent with this repo's convention for new proactive
  // DMs.
  ENGAGEMENT_ALERT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Proactive super-admin alert (issue #785) pushing adminActivitySummary()'
  // (issue #488) per-actor admin_audit rollup, aggregated into a weekly
  // actions-per-admin rate — closes the same pull-only gap #472/#568 closed
  // for other super-admin-only signals, moving VISION's "Admin leverage"
  // north star from pull (the on-demand admin_activity tool) to push. Off
  // by default, consistent with this repo's convention for new proactive
  // DMs.
  ADMIN_LEVERAGE_ALERT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Real-time admin nudge (issue #650) fired the moment a knowledge-gap
  // cluster (recordKnowledgeGap + recentKnowledgeGapClusters, issue #208)
  // crosses KNOWLEDGE_GAP_ALERT_THRESHOLD unresolved, not-yet-alerted rows —
  // the "asked N times, never confidently answered → worth a FAQ?" signal
  // promoted from the weekly digest's bare count to an instant, rate-limited
  // notifyAdmins DM, same promote-to-instant-DM precedent as #479/#480. Off
  // by default, consistent with this repo's convention for new proactive DMs.
  KNOWLEDGE_GAP_ALERT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Cluster size (unresolved, unalerted rows) that triggers the alert.
  KNOWLEDGE_GAP_ALERT_THRESHOLD: z.coerce.number().int().positive().default(3),
  // Guild-wide rolling-hour cap on knowledge-gap-cluster alerts, same
  // sliding-window shape as ACCESS_REQUEST_ALERT_RATE_LIMIT_PER_HOUR — bounds
  // worst-case admin DM volume from an organic or adversarial query burst.
  // Once exhausted within the trailing hour, a further threshold crossing is
  // still recorded (and still counted by the weekly digest) but does not
  // notify; the row is left unalerted so it can retry once the window frees.
  KNOWLEDGE_GAP_ALERT_RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(5),
  // Real-time admin nudge (issue #701) fired the moment a served
  // knowledge_search hit or knowledge shortcut is stale (isKnowledgeStale)
  // and unalerted since its last edit (stale_alerted_at IS NULL OR
  // stale_alerted_at < updated_at) — the per-entry counterpart to the weekly
  // digest's bare staleKnowledgeCount, promoted to an instant, rate-limited
  // notifyAdmins DM, identical mechanism shape to KNOWLEDGE_GAP_ALERT_ENABLED
  // above (#650). Off by default, consistent with this repo's convention for
  // new proactive DMs.
  KNOWLEDGE_STALE_ALERT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Guild-wide rolling-hour cap on stale-knowledge alerts, same sliding-window
  // shape as KNOWLEDGE_GAP_ALERT_RATE_LIMIT_PER_HOUR. Unlike that sibling cap,
  // once exhausted within the trailing hour the served row is still
  // stale_alerted_at-stamped (see markStaleKnowledgeAlerted's doc comment) so
  // a rate-limited entry does not retry-storm on every subsequent serve.
  KNOWLEDGE_STALE_ALERT_RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(5),
  // Real-time admin nudge (issue #887) for the third and last signal #650
  // explicitly deferred: a plain "members keep asking near-identical things"
  // cluster (recentQuestionClusters, already consumed by the weekly digest
  // and the on-demand question_digest tool) crossing
  // REPEAT_QUESTION_ALERT_THRESHOLD in a single conversation, promoted from
  // weekly-digest-only to an instant, rate-limited notifyAdmins DM — same
  // promote-to-instant-DM shape as KNOWLEDGE_GAP_ALERT_ENABLED (#650) and
  // KNOWLEDGE_STALE_ALERT_ENABLED (#701). Off by default, consistent with
  // this repo's convention for new proactive DMs.
  REPEAT_QUESTION_ALERT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Cluster size (matching recentQuestionClusters' own count) that triggers
  // the alert. Same default as KNOWLEDGE_GAP_ALERT_THRESHOLD.
  REPEAT_QUESTION_ALERT_THRESHOLD: z.coerce.number().int().positive().default(3),
  // Guild-wide rolling-hour cap on repeat-question-cluster alerts, identical
  // sliding-window shape to KNOWLEDGE_GAP_ALERT_RATE_LIMIT_PER_HOUR. Once
  // exhausted within the trailing hour, a further crossed cluster still does
  // not notify, but the underlying weekly-digest/question_digest signal is
  // unaffected — this cap only ever drops the extra DM, never data.
  REPEAT_QUESTION_ALERT_RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(5),
  // Per-conversation cooldown, in minutes, between recentQuestionClusters
  // checks (issue #887). Unlike KNOWLEDGE_GAP_ALERT/KNOWLEDGE_STALE_ALERT,
  // whose triggering events are cheap pre-bounded inserts/flags,
  // recentQuestionClusters scans and clusters every addressed-to-bot inbound
  // message in its window — running it on every turn would scale query
  // volume with raw message volume. This cooldown also doubles as the
  // anti-repeat mechanism (no persisted per-cluster alerted_at, since
  // `interactions` has no stable cluster identity to stamp): once a
  // conversation has been checked, whether or not it alerted, it can't be
  // checked again until the cooldown elapses.
  REPEAT_QUESTION_ALERT_COOLDOWN_MINUTES: z.coerce.number().int().positive().default(15),
  // Weekly member-facing digest post (issue #645): widens the audience of
  // already-admin-visible k-floored `context_digests` topics + curated
  // "new in the knowledge base" titles to a Discord channel, so a member who
  // missed the week can see what was discussed without asking. Off by
  // default — no timer, no send, byte-identical to today when unset (same
  // convention as every other proactive push above). MEMBER_DIGEST_CHANNEL_ID
  // is config-set only — never model- or message-supplied — and is the
  // Discord channel the weekly post targets.
  MEMBER_DIGEST_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  MEMBER_DIGEST_CHANNEL_ID: z.string().optional(),
  // Independent k-anonymity floor for the member digest (PR #651 review):
  // this surface is a public Discord channel, more exposed than either
  // existing `context_digests` consumer (admin-only `list_context_digests`,
  // and the export's own CONTEXT_EXPORT_MIN_DISTINCT_USERS), so it gets its
  // own floor rather than inheriting whichever value CONTEXT_BUILDER_MIN_
  // DISTINCT_USERS happens to be configured with. Same >=2, default 3 as
  // the export's floor.
  MEMBER_DIGEST_MIN_DISTINCT_USERS: z.coerce.number().int().min(2).default(3),

  // Guild-wide rolling-hour cap on access-request alerts (issue #480), same
  // sliding-window shape as ANNOUNCE_RATE_LIMIT_PER_HOUR/
  // AGENT_WEB_SEARCH_RATE_LIMIT_PER_HOUR — bounds worst-case admin DM volume
  // under a raid or a channel getting linked somewhere. Once exhausted within
  // the trailing hour, further first-time requests are still recorded in
  // `access_requests` (visible via list_access_requests/the digest) but do
  // not notify; a fresh hour resumes notifying.
  ACCESS_REQUEST_ALERT_RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(10),

  // Weekly proactive per-admin DM digest of recurring-question clusters in
  // their own scoped conversations (issue #97) — a push companion to the
  // on-demand `question_digest` tool. Off by default (no timer, no extra
  // queries). Recipients are `community_users` admins only; super admins keep
  // the on-demand tool instead (see storage/repository.ts:listAdmins).
  ADMIN_DIGEST_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Week-over-week trend suffix on every digest count (issue #497). Off by
  // default: when unset, `getLastDigestCounts` is never called and no digest
  // line ever gains a trend suffix — output stays byte-identical to today.
  // The `last_counts` snapshot itself is still written every run regardless
  // of this flag (see adminDigest.ts), so flipping it on is retroactively
  // useful from the very next weekly tick.
  ADMIN_DIGEST_TRENDS_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  // Fifth admin-digest signal (issue #199): nudge admins toward knowledge
  // entries neither edited nor retrieved in this many days. Unset/0 =
  // disabled (no extra query, no behaviour change on upgrade), matching the
  // "0 disabled, else a sane minimum" convention of
  // INTERACTION_RETENTION_DAYS/ROSTER_DEPARTED_RETENTION_DAYS above.
  KNOWLEDGE_STALE_DAYS: z.coerce.number().int().nonnegative().default(0),
  // Absolute content-age ceiling (issue #380): fires regardless of retrieval
  // activity, closing the gap where a popular entry's `last_retrieved_at`
  // resets KNOWLEDGE_STALE_DAYS's clock forever. Unset/0 = disabled, same
  // convention as KNOWLEDGE_STALE_DAYS. OR-ed into the exact same shared
  // `isKnowledgeStale` predicate — not a second staleness concept.
  KNOWLEDGE_STALE_MAX_AGE_DAYS: z.coerce.number().int().nonnegative().default(0),
  // Review-queue age signal for `knowledge_candidates` (issue #398) — a
  // separate concern from KNOWLEDGE_STALE_DAYS/KNOWLEDGE_STALE_MAX_AGE_DAYS
  // above (content-freshness of *accepted* knowledge): this flags a
  // never-reviewed *pending* candidate, whose `hasQueuedCandidateForTopic`
  // dedup guard otherwise locks its topic out of re-drafting forever with no
  // signal. Own knob, own (lower) floor — candidates should turn over in
  // days/weeks, not the months KNOWLEDGE_STALE_DAYS tolerates. Unset/0 =
  // disabled, same "0 disabled, else a sane minimum" convention.
  KNOWLEDGE_CANDIDATE_STALE_DAYS: z.coerce.number().int().nonnegative().default(0),
};

// A threshold below a month would flag entries an admin just as plausibly
// hasn't gotten around to re-checking yet rather than ones that are stale.
const MIN_KNOWLEDGE_STALE_DAYS = 30;

// 3x KNOWLEDGE_STALE_DAYS's own floor: this ceiling must fire even for
// content still in active use, so it needs a generous grace period, not a
// twitchy one.
const MIN_KNOWLEDGE_STALE_MAX_AGE_DAYS = 90;

// Deliberately below MIN_KNOWLEDGE_STALE_DAYS (30): a review queue should
// turn over far sooner than curated knowledge goes stale, so this is its own,
// lower floor rather than a reuse of that constant.
const MIN_KNOWLEDGE_CANDIDATE_STALE_DAYS = 14;

export type AlertsEnv = z.infer<z.ZodObject<typeof alertsSlice>>;

export const alertsRefinements: EnvRefinement<AlertsEnv>[] = [
  {
    check: (e) => e.KNOWLEDGE_STALE_DAYS === 0 || e.KNOWLEDGE_STALE_DAYS >= MIN_KNOWLEDGE_STALE_DAYS,
    params: {
      message: `KNOWLEDGE_STALE_DAYS must be 0 (disabled) or at least ${MIN_KNOWLEDGE_STALE_DAYS}`,
      path: ['KNOWLEDGE_STALE_DAYS'],
    },
  },
  {
    check: (e) =>
      e.KNOWLEDGE_STALE_MAX_AGE_DAYS === 0 ||
      e.KNOWLEDGE_STALE_MAX_AGE_DAYS >= MIN_KNOWLEDGE_STALE_MAX_AGE_DAYS,
    params: {
      message: `KNOWLEDGE_STALE_MAX_AGE_DAYS must be 0 (disabled) or at least ${MIN_KNOWLEDGE_STALE_MAX_AGE_DAYS}`,
      path: ['KNOWLEDGE_STALE_MAX_AGE_DAYS'],
    },
  },
  {
    check: (e) =>
      e.KNOWLEDGE_STALE_MAX_AGE_DAYS === 0 ||
      e.KNOWLEDGE_STALE_DAYS === 0 ||
      e.KNOWLEDGE_STALE_MAX_AGE_DAYS >= e.KNOWLEDGE_STALE_DAYS,
    params: {
      // The absolute ceiling should never be shorter than the
      // popularity-aware window when both are set, or the two would fight
      // rather than compose.
      message: 'KNOWLEDGE_STALE_MAX_AGE_DAYS must not be smaller than a nonzero KNOWLEDGE_STALE_DAYS',
      path: ['KNOWLEDGE_STALE_MAX_AGE_DAYS'],
    },
  },
  {
    check: (e) =>
      e.KNOWLEDGE_CANDIDATE_STALE_DAYS === 0 ||
      e.KNOWLEDGE_CANDIDATE_STALE_DAYS >= MIN_KNOWLEDGE_CANDIDATE_STALE_DAYS,
    params: {
      message: `KNOWLEDGE_CANDIDATE_STALE_DAYS must be 0 (disabled) or at least ${MIN_KNOWLEDGE_CANDIDATE_STALE_DAYS}`,
      path: ['KNOWLEDGE_CANDIDATE_STALE_DAYS'],
    },
  },
];
