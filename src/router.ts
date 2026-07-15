import { config } from './config.js';
import { logger } from './logger.js';
import { isPureAcknowledgement } from './ackClassifier.js';
import { atLeast, type CallerContext, type Tier } from './auth/rbac.js';
import { resolveRole, superAdminIds } from './auth/roles.js';
import type { IncomingMessage, Platform, PlatformAdapter } from './platforms/types.js';
import { sanitizeName } from './agent/systemPrompt.js';
import {
  INTERNAL_ERROR_REPLY,
  MAX_TURNS_REPLY,
  MAX_TURNS_REPLY_MI,
  runAgentTurn,
  type AgentReply,
} from './agent/core.js';
import { formatKnowledgeCitationNote, notifyAdmins, truncateForEcho } from './agent/tools.js';
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
  getResponseStyle,
  isKnowledgeLowRated,
  listAdmins,
  recordAccessRequest,
  recordEscalatedKnowledgeGap,
  recordInteraction,
  recordKnowledgeRetrieval,
  recordShortcutHit as recordShortcutHitDefault,
  searchKnowledge,
} from './storage/repository.js';
import {
  RATE_LIMIT_NOTICE_TEXT,
  RATE_LIMIT_NOTICE_TEXT_MI,
  RATE_LIMIT_NOTICE_TEXT_PLAIN,
  shouldNotifyRateLimited,
} from './rateLimitNotice.js';
import {
  PAUSE_NOTICE_TEXT,
  PAUSE_NOTICE_TEXT_MI,
  PAUSE_NOTICE_TEXT_PLAIN,
  shouldNotifyPaused,
} from './pauseNotice.js';
import {
  DAILY_BUDGET_NOTICE_TEXT,
  DAILY_BUDGET_NOTICE_TEXT_MI,
  DAILY_BUDGET_NOTICE_TEXT_PLAIN,
} from './dailyBudgetNotice.js';
import {
  DAILY_REPLY_BUDGET_WARNING_TEXT,
  DAILY_REPLY_BUDGET_WARNING_TEXT_MI,
  DAILY_REPLY_BUDGET_WARNING_TEXT_PLAIN,
} from './dailyReplyBudgetWarning.js';
import { shouldNotifyBudgetCheckFailed } from './budgetCheckFailureNotice.js';
import { buildGatedNotice, GATED_NOTICE } from './gatedNotice.js';

// Fixed, human-authored te reo Māori variant (issue #363), served instead of
// GATED_NOTICE to a gated guest with a standing 'mi' language_prefs row
// (getLanguagePreference, issue #189) — e.g. a former member who set the
// preference before being removed. Same trust level as the English constant:
// no model call, no translation, no injection surface.
export const GATED_NOTICE_MI =
  'Kia ora! He kaupapa mema anake tēnei kaiāwhina. Tonoa he kaiwhakahaere hapori ki te tāpiri i a koe hei mema, kātahi ka taea e au te āwhina.';

// Fixed, human-authored plain-language variant (issue #430) of the static
// GATED_NOTICE fallback ONLY — `getGatedNotice`'s dynamic admin-name
// interpolation (gatedNotice.ts's `renderGatedNotice`) is unchanged; see the
// gated-notice call site below for how the two are told apart. Served to a
// gated guest with a standing 'plain' response-style preference
// (getResponseStyle, issue #126) whose language preference is NOT 'mi' —
// 'mi' takes precedence over 'plain'.
export const GATED_NOTICE_PLAIN =
  'Kia ora! Only members can use this assistant. Please ask a community admin to add you as a member — then I can help.';

// The three fixed strings the CONFIRM/CANCEL intercept itself authors (issue
// #405) — the one deterministic path #300/#363's own sweep of this file
// missed. Same `_MI` + `getLanguagePreference` pattern as every constant
// above: no model call, no translation, no injection surface, and `.catch(()
// => 'auto')` at each call site fails safe to the English default.
export const CANCEL_TEXT = 'Cancelled.';
export const CANCEL_TEXT_MI = 'Kua whakakorea.';
// Deliberately no CANCEL_TEXT_PLAIN (issue #430): already at the floor of
// simplicity, so a plain variant would be change for change's sake.

export const PERMISSIONS_CHANGED_TEXT =
  'Not executed: your permissions changed since this action was requested.';
export const PERMISSIONS_CHANGED_TEXT_MI =
  'Kāore i whakahaerehia: kua rerekē ō mana whakaaetanga mai i te wā i tonoa ai tēnei mahi.';
// Fixed, human-authored plain-language variant (issue #430) — rewords the
// English constant's passive-voice, negation-first construction into a
// short, direct statement. Same trust level as the English constant.
export const PERMISSIONS_CHANGED_TEXT_PLAIN =
  'I did not do this. Your permission level changed after you asked, so I can no longer do it.';

// Fixed, human-authored te reo Māori substitute for the literal `'Failed: '`
// shell prefix a CONFIRM-gated `requireConfirm` outcome falls back to on a
// thrown execute() (issue #490 — closing the one gap #405 named out of
// scope: "the per-tool requireConfirm outcome/failure strings ... stay out
// of scope and English-only"). Only this fixed shell is translated; the
// dynamic `result`/error text after it is untouched, same "translate the
// shell, not the payload" discipline as CODE_TRUNCATED_NOTE_MI (#339) and
// every other constant in this file. Deliberately no `Done: ` counterpart
// here — ARCHITECTURE.md doesn't name that shell as an open gap, and several
// requireConfirm tools return fully bespoke (non-`Done:`) success strings, so
// translating only the `Done:`-templated subset would read unevenly; left as
// a named follow-up.
export const FAILED_PREFIX_MI = 'I hapa: ';

// Wrapper around the deterministic pending-action notice (issue #405),
// mirroring the "translate the shell, leave the dynamic payload alone"
// pattern `agent/outbound.ts`'s CODE_TRUNCATED_NOTE_MI already established
// for its own interpolated placeholder (issue #339) — `description` is a
// tool-authored action summary (e.g. "delete knowledge entry #5"), not
// free-form member text, and is embedded unchanged in both variants. `CONFIRM`
// and `CANCEL` must stay literal, untranslated tokens in the `_MI` variant:
// `classifyConfirmReply` matches exactly those strings, so translating them
// would break the confirm protocol itself.
export const PENDING_NOTICE = (description: string) =>
  `⚠️ Pending: ${description}\nReply CONFIRM within 60 seconds to proceed, or CANCEL to abort. ` +
  `(This confirmation is handled outside the AI and must come from you in this conversation.)`;
export const PENDING_NOTICE_MI = (description: string) =>
  `⚠️ Kei te tatari: ${description}\nWhakahokia mai te CONFIRM i roto i te 60 hēkona kia haere tonu ai, ` +
  `CANCEL rānei kia whakakorehia. (Ka whakahaeretia tēnei whakaūnga i waho o te AI, ā, me ahu mai i a koe ` +
  `i roto i tēnei kōrerorero.)`;
// Fixed, human-authored plain-language variant (issue #430) — same
// "translate the shell, leave CONFIRM/CANCEL and `description` literal"
// treatment as PENDING_NOTICE_MI, but also rewords the meta, abstract
// parenthetical into something concrete a plain-language reader can act on.
export const PENDING_NOTICE_PLAIN = (description: string) =>
  `⚠️ Waiting for you: ${description}\nReply CONFIRM within 60 seconds to go ahead, or CANCEL to stop. ` +
  `(A person must reply CONFIRM or CANCEL — I cannot do this step myself.)`;

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

// Fixed, human-authored te reo Māori variants (issue #435) of the five
// opt-in shortcut-reply strings above, served instead of the English
// constant to a caller with a standing 'mi' language_prefs row
// (getLanguagePreference, issue #189) — the closing installment of the
// #266 series, a scope #363/#396/#405 each named and deliberately deferred
// as "a different file's call sites... a materially lower-reach path" since
// every one of these five sits behind an off-by-default flag. Same trust
// level as every English constant above: no model call, no translation, no
// injection surface, and `.catch(() => 'auto')` at each call site fails safe
// to the English default.
const ACK_REPLY_TEXT_MI = 'Kāore he raru!';

const KNOWLEDGE_SHORTCUT_SUFFIX_MI =
  '\n\n— Nō tā mātou pātengi mōhiotanga; pātai mai kia whakamāramatia mehemea kāore tēnei e tino whakautu ana i tāu pātai.';

const GUEST_KNOWLEDGE_SHORTCUT_NUDGE_MI =
  '\n\nTonoa tētahi kaiwhakahaere hapori ki te tāpiri i a koe hei mema kia taea ai te kōrero tonu.';

const REPEAT_SHORTCUT_NOTICE_MI = '↩️ I pātai mai koe i tēnei mea i tērā wā — anei anō tāku whakautu:\n\n';

const REPEAT_MAX_TURNS_SHORTCUT_NOTICE_MI = '↩️ He rite tonu ki tō tono o mua tata nei — me wāwāhi tonu:\n\n';

/**
 * Real-time admin alert fired the moment a gated guest's FIRST-EVER addressed
 * message creates a fresh `access_requests` row (issue #480) — the discrete-
 * event complement to the weekly digest's passive `pendingAccessRequests`
 * count, mirroring `notifyReportFiled`'s "push what was pullable" precedent
 * (#90). Called directly off `recordAccessRequest`'s insert-vs-update
 * `RETURNING` value in `handle()` below — never routed through the agent/
 * model loop, so a guest's own message content cannot reach this at all: only
 * their platform + display name are threaded through, matching
 * `access_requests`' own "identity + counts only" storage contract.
 * Guild-wide `listAdmins()` audience (the same recipients the weekly digest's
 * `pendingAccessRequests` count already reaches), not `superAdminIds()` — an
 * access request is routine admin business, not a super-admin-tier concern.
 * The guest's display name is sanitised the same way `list_access_requests`
 * already renders it (`sanitizeName`), so a hostile name can't fake a fresh
 * instruction line in front of the human admin reading the DM. Best-effort
 * per admin/platform: a failed DM to one admin never blocks the others,
 * matching `notifySuperAdmins`'s own fire-and-forget-per-recipient shape.
 */
export async function notifyAccessRequest(
  adapterFor: (platform: Platform) => PlatformAdapter | undefined,
  guest: { platform: Platform; userId: string; userName?: string },
  listAdminsFn: typeof listAdmins = listAdmins,
): Promise<void> {
  const admins = await listAdminsFn();
  if (admins.length === 0) return;
  const name = guest.userName ? sanitizeName(guest.userName) : '';
  const message = `🔔 New access request from ${name || guest.userId} on ${guest.platform}. Use add_member to let them in.`;
  for (const admin of admins) {
    const target = adapterFor(admin.platform);
    if (!target || !target.isConnected()) continue;
    target
      .sendDirectMessage(admin.platformUserId, message)
      .catch((err) => logger.warn({ err, platform: admin.platform }, 'Access-request alert failed'));
  }
}

// Real-time admin escalation after a max-turns failure (issue #479). Every
// piece below is opt-in behind ESCALATION_TO_ADMIN_ENABLED (default off) and
// lives entirely in this deterministic router layer — never routed through
// the model — mirroring the CONFIRM/CANCEL intercept's trust level.

/** Appended to MAX_TURNS_REPLY/_MI (and the repeat-max-turns shortcut's replay of it) when the flag is on — see `offerEscalation`. */
const ESCALATION_OFFER_SUFFIX =
  '\n\nWant me to flag this for a community admin? Reply yes within 10 minutes.';
const ESCALATION_OFFER_SUFFIX_MI =
  '\n\nMe tohu tēnei mō tētahi kaiwhakahaere hapori? Whakahokia mai "āe" i roto i te 10 meneti.';

/** Sent when a "yes"/"y"/"āe" confirms a live pending escalation and a notification slot was available. */
const ESCALATION_CONFIRMED_TEXT = '👍 Flagged for a community admin — someone will follow up soon.';
const ESCALATION_CONFIRMED_TEXT_MI =
  '👍 Kua tohu mō tētahi kaiwhakahaere hapori — ka whai kōrero mai tētahi i muri tata nei.';

/** Sent when a confirmation would otherwise fire but ESCALATION_RATE_LIMIT_PER_HOUR is already exhausted (issue #479 acceptance criterion 6). */
const ESCALATION_RATE_LIMITED_TEXT =
  'Already flagged the max I can this hour, sorry — please try again later or contact an admin directly.';
const ESCALATION_RATE_LIMITED_TEXT_MI =
  'Kua tae ki te tepe mō tēnei haora, aroha mai — tēnā koa whakamātauria anō ā muri ake, ' +
  'whakapā tika rānei ki tētahi kaiwhakahaere.';

/**
 * How long a pending escalation offer stays live (issue #479's "reply yes
 * within 10 minutes") — a separate, longer window from
 * REPEAT_SHORTCUT_WINDOW_MS, since a member deciding whether to loop in an
 * admin plausibly takes longer than a double-tap resend.
 */
const ESCALATION_WINDOW_MS = 600_000; // 10 minutes

/**
 * Guild-wide rolling-hour cap on confirmed escalation notifications
 * (acceptance criterion 6) — same shape and default as
 * `ANNOUNCE_RATE_LIMIT_PER_HOUR` (`agent/tools.ts`), exported so tests can
 * exhaust it by exact count rather than a magic-number loop.
 */
export const ESCALATION_RATE_LIMIT_PER_HOUR = 5;

/** Short affirmatives that confirm a pending escalation offer — case-insensitive, trimmed only (no fuzzy matching), matching `classifyConfirmReply`'s discipline. */
function classifyEscalationConfirm(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t === 'yes' || t === 'y' || t === 'āe';
}

/** The subset of a KnowledgeSearchHit the shortcut path carries through — just enough to render `formatKnowledgeCitationNote` (issue #214). */
interface KnowledgeShortcutHit {
  id: number;
  content: string;
  updatedAt: Date;
  lastRetrievedAt: Date | null;
  sourceUrl: string | null;
  sourceTitle: string | null;
  verifiedAt: Date | null;
  /** Weekly link-rot checker's verdict (issue #448); null means never checked. */
  sourceUnreachable: boolean | null;
  sourceCheckedAt: Date | null;
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
 *  - optionally offer, and intercept the confirmation of, a real-time admin
 *    escalation after a max-turns failure — same non-model trust tier as
 *    CONFIRM/CANCEL
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
  /** conversationId -> auto-answer timestamps, for the per-channel rolling-hour cap (issue #477, AUTO_ANSWER_RATE_LIMIT_PER_HOUR). */
  private readonly autoAnswerHits = new Map<string, number[]>();

  private readonly RATE_LIMIT = 8; // messages
  private readonly RATE_WINDOW_MS = 60_000; // per minute
  /** userKey -> when they were last told they hit the budget (rolling 24h, matching the budget window). */
  private readonly budgetNotified = new Map<string, number>();
  /**
   * userKey -> when they were last warned they're approaching the daily
   * budget (issue #511) — the pre-cutoff sibling of `budgetNotified` above,
   * same key shape and same rolling-24h window, so a caller sitting inside
   * the warning threshold for several messages in a row is warned once, not
   * on every message. Only written when DAILY_REPLY_BUDGET_WARN_ENABLED is
   * on (see `respond()`).
   */
  private readonly budgetWarned = new Map<string, number>();
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
  /**
   * `platform:conversationId:userId` -> the live escalation offer for that
   * exact caller (issue #479) — created atomically with the offer line
   * appended to a max-turns failure reply (`offerEscalation`, called from
   * both `respond()` and `sendRepeatMaxTurnsShortcut`), so the offer is never
   * shown without a matching entry here and vice versa. `query` is the
   * caller's own original (unnormalized) message text, echoed (truncated) to
   * admins on confirmation. Single-shot: consumed (deleted) the moment a
   * confirming "yes" is matched in `handle()`, so a replayed "yes" can never
   * fire a second notification. Swept on the same TTL as every other pending
   * map here.
   */
  private readonly pendingEscalations = new Map<string, { query: string; at: number }>();
  /** Timestamps of confirmed escalation notifications, for the guild-wide rolling-hour cap (ESCALATION_RATE_LIMIT_PER_HOUR). */
  private readonly escalationTimestamps: number[] = [];
  /**
   * Auto-answer thread id -> parent channel id (+ creation time), issue #477.
   * A CONFIRM/CANCEL or escalation-confirmation the member types INSIDE an
   * auto-answer thread arrives with the thread's own id as its
   * `conversationId`, but the pending action / escalation offer was registered
   * against the PARENT channel (where the original post lived, and where the
   * agent turn's `caller.conversationId` pointed). This map translates a
   * confirming reply arriving inside a known auto-answer thread back to that
   * parent for the pending-LOOKUP only — registration is unchanged — so a
   * `forget_me`/destructive CONFIRM (or an escalation "yes") typed exactly
   * where the bot's notice appeared still resolves instead of being silently
   * swallowed. Pruned in `sweep()` on the escalation window (the longer of the
   * two confirm TTLs it has to outlive).
   */
  private readonly autoAnswerThreadParents = new Map<string, { parent: string; at: number }>();

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
   * live DB. `getRespStyle` defaults to the real standing-response-style-
   * preference read (issue #430), mirroring `getLangPref`'s shape exactly —
   * consulted at the same call sites, but only when `getLangPref` didn't
   * already resolve to 'mi' (which takes precedence). `recordShortcutHit`
   * defaults to the real DB-backed shortcut-hit recorder (issue #440),
   * fired at each of the four member-facing shortcut short-circuits.
   * `notifyAccessRequestFn` defaults to the real `notifyAccessRequest`
   * (issue #480), consulted only when `ACCESS_REQUEST_ALERT_ENABLED` is on
   * and `recordAccessRequest` reports a fresh insert — overridable so tests
   * can assert the alert fired/didn't without a live DB or adapter.
   * `recordAccessRequestFn` defaults to the real DB-backed upsert; overridable
   * (like every other DB read/write above) so its insert-vs-update return
   * value can be controlled in tests without a live Postgres.
   * `notifyAdminsFn` defaults to the real `listAdmins()`-backed admin alert
   * (issue #479), fired from the escalation-confirmation intercept in
   * `handle()`; overridable so tests can assert on it without a live DB.
   * `recordEscalatedGapFn` defaults to the real DB-backed escalated-gap
   * recorder (issue #514), fired alongside `notifyAdminsFn` from the same
   * intercept; overridable so tests can assert on it without a live DB.
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
    private readonly getRespStyle: typeof getResponseStyle = getResponseStyle,
    private readonly recordShortcutHit: typeof recordShortcutHitDefault = recordShortcutHitDefault,
    private readonly recordAccessRequestFn: typeof recordAccessRequest = recordAccessRequest,
    private readonly notifyAccessRequestFn: typeof notifyAccessRequest = notifyAccessRequest,
    private readonly notifyAdminsFn: typeof notifyAdmins = notifyAdmins,
    private readonly recordEscalatedGapFn: typeof recordEscalatedKnowledgeGap = recordEscalatedKnowledgeGap,
  ) {
    setInterval(() => this.sweep(), this.RATE_WINDOW_MS * 5).unref();
  }

  /** Rolling-hour timestamps for `ACCESS_REQUEST_ALERT_RATE_LIMIT_PER_HOUR` (issue #480) — guild-wide, not per-conversation, since the alert audience (`listAdmins()`) is guild-wide too. */
  private readonly accessRequestAlertTimestamps: number[] = [];

  /**
   * Reserve one access-request-alert slot against a rolling hourly cap, same
   * sliding-window shape as `tools.ts`'s `reserveAnnounceSlot`/
   * `reservePollSlot` — but keyless/guild-wide rather than per-conversation,
   * matching this alert's guild-wide `listAdmins()` audience. Returns false
   * without reserving if the guild already hit `limit` within the last hour;
   * the request is still recorded by the caller either way (issue #480).
   */
  private reserveAccessRequestAlertSlot(limit: number): boolean {
    const now = Date.now();
    const windowMs = 60 * 60 * 1000;
    const recent = this.accessRequestAlertTimestamps.filter((t) => now - t < windowMs);
    this.accessRequestAlertTimestamps.length = 0;
    this.accessRequestAlertTimestamps.push(...recent);
    if (recent.length >= limit) return false;
    this.accessRequestAlertTimestamps.push(now);
    return true;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, hits] of this.userHits) {
      if (hits.every((t) => now - t >= this.RATE_WINDOW_MS)) this.userHits.delete(key);
    }
    const autoAnswerWindowMs = 60 * 60 * 1000;
    for (const [key, hits] of this.autoAnswerHits) {
      if (hits.every((t) => now - t >= autoAnswerWindowMs)) this.autoAnswerHits.delete(key);
    }
    for (const [key, at] of this.budgetNotified) {
      if (now - at > 24 * 3_600_000) this.budgetNotified.delete(key);
    }
    for (const [key, at] of this.budgetWarned) {
      if (now - at > 24 * 3_600_000) this.budgetWarned.delete(key);
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
    for (const [key, entry] of this.pendingEscalations) {
      if (now - entry.at > ESCALATION_WINDOW_MS) this.pendingEscalations.delete(key);
    }
    for (const [key, entry] of this.autoAnswerThreadParents) {
      if (now - entry.at > ESCALATION_WINDOW_MS) this.autoAnswerThreadParents.delete(key);
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
   * Reserve one auto-answer slot for `conversationId` against a rolling
   * hourly cap (issue #477), same sliding-window shape as agent/tools.ts's
   * `reserveAnnounceSlot` — kept as its own instance-scoped map here rather
   * than reused from tools.ts since auto-answer is router-driven, not a
   * model-invoked tool. Backed by the configurable
   * `AUTO_ANSWER_RATE_LIMIT_PER_HOUR` rather than a fixed constant. Never
   * called for an addressed/mention reply — only the auto-answer path.
   */
  private reserveAutoAnswerSlot(conversationId: string): boolean {
    const now = Date.now();
    const windowMs = 60 * 60 * 1000;
    const recent = (this.autoAnswerHits.get(conversationId) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= config.discord.autoAnswerRateLimitPerHour) {
      this.autoAnswerHits.set(conversationId, recent);
      return false;
    }
    recent.push(now);
    this.autoAnswerHits.set(conversationId, recent);
    return true;
  }

  /**
   * Appends the escalation offer to a max-turns failure reply AND, in the
   * same step, records the live pending entry behind it (issue #479
   * acceptance criterion 2) — called from both the fresh-failure path
   * (`respond()`) and the repeat-max-turns shortcut replay
   * (`sendRepeatMaxTurnsShortcut`), which also serves this same failure text
   * and would otherwise show a "reply yes" offer with no pending entry to
   * back it (the adversarial review's named hazard). Each call re-arms a
   * fresh `ESCALATION_WINDOW_MS` TTL, overwriting any still-live prior entry
   * for this caller — a repeat failure genuinely re-offers escalation, it
   * doesn't extend a stale one.
   */
  private offerEscalation(msg: IncomingMessage, failureText: string, isMi: boolean): string {
    this.pendingEscalations.set(this.callerKey(msg), { query: msg.text, at: Date.now() });
    return `${failureText}${isMi ? ESCALATION_OFFER_SUFFIX_MI : ESCALATION_OFFER_SUFFIX}`;
  }

  /**
   * Reserve one guild-wide escalation-notification slot against the rolling
   * hourly cap (issue #479 acceptance criterion 6) — same sliding-window
   * shape as `reserveAnnounceSlot`/`reservePollSlot` in `agent/tools.ts`, but
   * a single shared window (not per-conversation): the cap bounds total
   * admin-notification volume regardless of which conversation or caller
   * tier triggers it.
   */
  private reserveEscalationSlot(limit: number): boolean {
    const now = Date.now();
    const recent = this.escalationTimestamps.filter((t) => now - t < 3_600_000);
    this.escalationTimestamps.length = 0;
    this.escalationTimestamps.push(...recent);
    if (this.escalationTimestamps.length >= limit) return false;
    this.escalationTimestamps.push(now);
    return true;
  }

  /**
   * Creates the Discord thread an auto-answer reply is contained in (issue
   * #477), anchored to the origin post via its native message id. Throws if
   * the adapter doesn't support it (only Discord does; callers only reach
   * here when `msg.platform === 'discord'`) or has no message id, or if the
   * platform call itself fails — either way the caller falls back to
   * replying directly in the channel rather than losing the answer.
   */
  private async startAutoAnswerThread(msg: IncomingMessage, adapter: PlatformAdapter): Promise<string> {
    if (!adapter.startAutoAnswerThread) throw new Error('Adapter does not support auto-answer threads');
    if (!msg.messageId) throw new Error('Auto-answer requires a message id to anchor the thread to');
    const name = msg.text.trim().slice(0, 90) || 'Question';
    return adapter.startAutoAnswerThread(msg.conversationId, msg.messageId, name);
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
        // Real-time admin alert (issue #480): fires ONLY on a fresh
        // `access_requests` row — a repeat ping from the same still-pending
        // guest (`inserted === false`) never notifies again, the upsert's own
        // dedup is the entire debounce.
        //
        // The insert-vs-update result is only needed WHEN the alert is enabled,
        // so it's only awaited then. Flag off/unset keeps the record upsert
        // fire-and-forget exactly as before #480 — the gated guest's reply path
        // (the raid-exposed hot path) never blocks on the DB round trip, so
        // behaviour is genuinely byte-identical when the feature is off.
        if (config.accessRequestAlert.enabled) {
          const inserted = await this.recordAccessRequestFn({
            platform: msg.platform,
            userId: msg.userId,
            userName: msg.userName,
          }).catch((err) => {
            logger.warn({ err }, 'Failed to record access request');
            return false;
          });
          if (inserted && this.reserveAccessRequestAlertSlot(config.accessRequestAlert.rateLimitPerHour)) {
            this.notifyAccessRequestFn((platform) => this.adapters.get(platform), {
              platform: msg.platform,
              userId: msg.userId,
              userName: msg.userName,
            }).catch((err) => logger.warn({ err }, 'Failed to fire access-request alert'));
          }
        } else {
          void this.recordAccessRequestFn({
            platform: msg.platform,
            userId: msg.userId,
            userName: msg.userName,
          }).catch((err) => logger.warn({ err }, 'Failed to record access request'));
        }
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
            let notice: string;
            if (lang === 'mi') {
              notice = GATED_NOTICE_MI;
            } else {
              notice = await this.getGatedNotice(msg.platform).catch((err) => {
                logger.warn({ err }, 'Gated notice builder failed; using the static fallback');
                return GATED_NOTICE;
              });
              // _PLAIN only substitutes for the STATIC fallback (issue #430)
              // — a dynamic, admin-naming notice is left untouched. The
              // response-style lookup is deliberately nested inside this
              // branch so it's never paid on the (far more common) dynamic-
              // notice path.
              if (notice === GATED_NOTICE) {
                const style = await this.getRespStyle(msg.platform, msg.userId).catch(
                  () => 'standard' as const,
                );
                if (style === 'plain') notice = GATED_NOTICE_PLAIN;
              }
            }
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
    // A CONFIRM/CANCEL typed inside an auto-answer thread (issue #477) carries
    // the thread's id, but the action was registered against the parent
    // channel — resolve back to it for the lookup so the confirm the bot's own
    // notice asked for isn't silently dropped. Non-thread messages pass through
    // unchanged.
    const pendingConversationId =
      this.autoAnswerThreadParents.get(msg.conversationId)?.parent ?? msg.conversationId;
    const verdict = classifyConfirmReply(msg.text);
    if (verdict && hasPendingAction(msg.platform, pendingConversationId, msg.userId)) {
      if (verdict === 'cancel') {
        cancelPendingAction(msg.platform, pendingConversationId, msg.userId);
        const lang = await this.getLangPref(msg.platform, msg.userId).catch(() => 'auto' as const);
        await this.send(adapter, msg.conversationId, lang === 'mi' ? CANCEL_TEXT_MI : CANCEL_TEXT).catch(
          () => {},
        );
        return;
      }
      const pending = takePendingAction(msg.platform, pendingConversationId, msg.userId);
      if (pending) {
        let outcome: string;
        // Re-check the actor's CURRENT tier: a role revoked inside the
        // confirm TTL invalidates the queued action.
        if (!atLeast(role, pending.minTier)) {
          const lang = await this.getLangPref(msg.platform, msg.userId).catch(() => 'auto' as const);
          if (lang === 'mi') {
            outcome = PERMISSIONS_CHANGED_TEXT_MI;
          } else {
            const style = await this.getRespStyle(msg.platform, msg.userId).catch(() => 'standard' as const);
            outcome = style === 'plain' ? PERMISSIONS_CHANGED_TEXT_PLAIN : PERMISSIONS_CHANGED_TEXT;
          }
        } else {
          try {
            outcome = await pending.execute();
          } catch (err) {
            outcome = `Failed: ${err instanceof Error ? err.message : String(err)}`;
          }
          // Translate only the generic `Failed: ` shell (issue #490) — covers
          // both the catch-block fallback above and any requireConfirm tool
          // that returns its own `Failed: ${result}`-shaped string, without
          // touching agent/tools.ts. Bespoke, non-templated outcome strings
          // some tools author directly stay English-only, matching #405's
          // scope boundary exactly (just closing the `Failed: ` half of it).
          if (outcome.startsWith('Failed: ')) {
            const lang = await this.getLangPref(msg.platform, msg.userId).catch(() => 'auto' as const);
            if (lang === 'mi') {
              outcome = FAILED_PREFIX_MI + outcome.slice('Failed: '.length);
            }
          }
        }
        await this.send(adapter, msg.conversationId, outcome).catch((err) =>
          logger.error({ err }, 'Failed to send confirm outcome'),
        );
        return;
      }
    }

    // Deterministic escalation-confirmation intercept (issue #479). Sibling
    // of the CONFIRM/CANCEL intercept above: runs BEFORE the addressed check
    // (so a bare "yes" works in a group where a plain reply isn't
    // "addressed"), entirely in the router, and never reaches the model.
    // `pendingEscalations` is ONLY ever populated atomically alongside the
    // offer text itself (`offerEscalation`, called from `respond()` and
    // `sendRepeatMaxTurnsShortcut`), so a live entry here always means the
    // caller was actually shown the offer. Deleting the entry BEFORE
    // checking the rate cap makes consumption single-shot regardless of
    // outcome: a replayed "yes" can never find the entry again, whether or
    // not the first attempt cleared the cap (acceptance criteria 4 + 6).
    // Absence here (never offered, or past the 10-minute TTL) falls straight
    // through — the text is passed to the model as an ordinary message,
    // never mistaken for a confirmation.
    if (config.behaviour.escalationToAdminEnabled && classifyEscalationConfirm(msg.text)) {
      // Same auto-answer-thread translation as the CONFIRM/CANCEL intercept
      // above: an escalation "yes" typed inside the thread resolves back to the
      // parent channel the offer was registered against (issue #477 × #479).
      const escalationConversationId =
        this.autoAnswerThreadParents.get(msg.conversationId)?.parent ?? msg.conversationId;
      const escalationKey = `${msg.platform}:${escalationConversationId}:${msg.userId}`;
      const pendingEscalation = this.pendingEscalations.get(escalationKey);
      if (pendingEscalation && Date.now() - pendingEscalation.at < ESCALATION_WINDOW_MS) {
        this.pendingEscalations.delete(escalationKey);
        const lang = await this.getLangPref(msg.platform, msg.userId).catch(() => 'auto' as const);
        if (this.reserveEscalationSlot(ESCALATION_RATE_LIMIT_PER_HOUR)) {
          await this.notifyAdminsFn(
            (platform) => this.adapters.get(platform),
            `${msg.userName} asked for help and hit my step limit on ${msg.platform} ` +
              `(conversation ${msg.conversationId}): "${truncateForEcho(pendingEscalation.query)}"`,
            msg.userId,
          ).catch((err) => logger.warn({ err }, 'Escalation admin notification failed'));
          // Link this confirmed escalation into the knowledge_gaps curation
          // queue (issue #514) — only reached inside the reserved-slot
          // branch, so a rate-limited "yes" never writes a row. Same
          // fire-and-forget, non-blocking shape as notifyAdminsFn above.
          this.recordEscalatedGapFn(
            msg.platform,
            msg.conversationId,
            msg.userId,
            pendingEscalation.query,
          ).catch((err) => logger.warn({ err }, 'Escalated knowledge gap recording failed'));
          await this.send(
            adapter,
            msg.conversationId,
            lang === 'mi' ? ESCALATION_CONFIRMED_TEXT_MI : ESCALATION_CONFIRMED_TEXT,
          ).catch(() => {});
        } else {
          await this.send(
            adapter,
            msg.conversationId,
            lang === 'mi' ? ESCALATION_RATE_LIMITED_TEXT_MI : ESCALATION_RATE_LIMITED_TEXT,
          ).catch(() => {});
        }
        return;
      }
    }

    // Auto-answer (issue #477): an operator-allowlisted Discord channel
    // (AUTO_ANSWER_CHANNEL_IDS) gets an answer for a plain top-level human
    // post too, not just one that mentions/replies to the bot — this only
    // relaxes the summon gate immediately below for exactly that case.
    // Everything else — CONFIRM intercept above, pause/rate-limit/budget
    // below, and the role-derived tool surface via resolveRole/toolsForRole
    // — applies completely unchanged; this widens WHICH posts reach them,
    // never what a post is allowed to do once there. `isBotAuthor` is a
    // second, router-level backstop against a self/bot/webhook loop, on top
    // of the adapter already never constructing an IncomingMessage for one.
    //
    // A follow-up posted INSIDE a thread the bot itself opened for an
    // auto-answer (issue #519) also qualifies: `msg.conversationId` there is
    // the thread's own id, which is never in `autoAnswerChannelIds` (that
    // list only ever holds parent channel ids), so without this lookup the
    // very next message in the same back-and-forth would silently revert to
    // mention-required. Same map, same creation-anchored (non-refreshed)
    // `ESCALATION_WINDOW_MS` TTL the CONFIRM/escalation intercepts above
    // already trust — presence here means "live", sweep() prunes expired
    // entries on its own tick.
    const autoAnswerThreadParent = this.autoAnswerThreadParents.get(msg.conversationId)?.parent;
    const isAutoAnswerCandidate =
      !msg.addressedToBot &&
      !msg.isDirect &&
      !msg.isBotAuthor &&
      msg.platform === 'discord' &&
      (config.discord.autoAnswerChannelIds.includes(msg.conversationId) ||
        autoAnswerThreadParent !== undefined);

    // Only respond when addressed (mention/reply), in a direct conversation,
    // or an auto-answer candidate.
    if (!msg.addressedToBot && !msg.isDirect && !isAutoAnswerCandidate) return;
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
        let pauseText = PAUSE_NOTICE_TEXT;
        if (lang === 'mi') {
          pauseText = PAUSE_NOTICE_TEXT_MI;
        } else {
          const style = await this.getRespStyle(msg.platform, msg.userId).catch(() => 'standard' as const);
          if (style === 'plain') pauseText = PAUSE_NOTICE_TEXT_PLAIN;
        }
        await this.send(adapter, msg.conversationId, pauseText).catch(() => {});
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
        let rateLimitText = RATE_LIMIT_NOTICE_TEXT;
        if (lang === 'mi') {
          rateLimitText = RATE_LIMIT_NOTICE_TEXT_MI;
        } else {
          const style = await this.getRespStyle(msg.platform, msg.userId).catch(() => 'standard' as const);
          if (style === 'plain') rateLimitText = RATE_LIMIT_NOTICE_TEXT_PLAIN;
        }
        await this.send(adapter, msg.conversationId, rateLimitText).catch(() => {});
      }
      return;
    }

    // Daily reply budget (super admins exempt). `replyBudget` is hoisted out
    // of this block (issue #511) so the already-fetched `used`/`limit` pair
    // can be threaded into `respond()` below for the approaching-budget
    // warning, instead of being discarded once the `used < limit` check
    // passes — no new DB query, reusing the exact read this block already
    // makes.
    const limit = config.behaviour.dailyReplyLimitPerUser;
    let replyBudget: { used: number; limit: number } | undefined;
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
          let budgetText = DAILY_BUDGET_NOTICE_TEXT;
          if (lang === 'mi') {
            budgetText = DAILY_BUDGET_NOTICE_TEXT_MI;
          } else {
            const style = await this.getRespStyle(msg.platform, msg.userId).catch(() => 'standard' as const);
            if (style === 'plain') budgetText = DAILY_BUDGET_NOTICE_TEXT_PLAIN;
          }
          await this.send(adapter, msg.conversationId, budgetText).catch(() => {});
        }
        return;
      }
      replyBudget = { used, limit };
    }

    // Per-channel rolling-hour cap (issue #477) — bounds the flood/cost risk
    // of this new untrusted-input path. Reserved HERE, only once pause, the
    // per-user rate limit, and the daily budget have all passed, so a message
    // those checks would shed never burns a slot from the shared per-channel
    // allowance and starves other members' auto-answers. Never applied to an
    // addressed/mention reply in the same channel, only to auto-answered ones.
    // SECURITY (issue #519): a thread-follow-up reserves against the PARENT
    // channel id, not the thread id — the thread id has never had a slot
    // reserved against it, so keying on it would open an uncapped
    // side-channel around AUTO_ANSWER_RATE_LIMIT_PER_HOUR the moment a
    // member replies inside a busy auto-answer thread.
    if (isAutoAnswerCandidate && !this.reserveAutoAnswerSlot(autoAnswerThreadParent ?? msg.conversationId))
      return;

    // If we ARE replying, make sure this message is in memory before the
    // agent turn runs (so recall can see it and ordering stays sane).
    await recorded;

    // Auto-answer replies are contained in a new Discord thread anchored to
    // the origin post (issue #477), never sent bare into the channel — every
    // shortcut/respond send below is redirected through `replyConversationId`.
    // A thread-creation failure (e.g. a transient Discord API error) degrades
    // to answering directly in the channel rather than silently dropping the
    // reply.
    let replyConversationId: string | undefined;
    if (isAutoAnswerCandidate) {
      if (autoAnswerThreadParent !== undefined) {
        // Already inside a bot-opened auto-answer thread (issue #519) — this
        // is a follow-up, not an origin post, so reply in place rather than
        // opening a second thread anchored to the follow-up message.
        replyConversationId = msg.conversationId;
      } else {
        replyConversationId = await this.startAutoAnswerThread(msg, adapter).catch((err) => {
          logger.warn(
            { err, conversationId: msg.conversationId },
            'Auto-answer thread creation failed; replying in channel',
          );
          return undefined;
        });
        // Record the thread -> parent mapping so a CONFIRM/CANCEL or escalation
        // "yes" the member types inside this thread resolves back to the parent
        // channel the pending action/offer was registered against (issue #477).
        if (replyConversationId) {
          this.autoAnswerThreadParents.set(replyConversationId, {
            parent: msg.conversationId,
            at: Date.now(),
          });
        }
      }
    }

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
      this.recordShortcutHit('ack').catch((err) => logger.warn({ err }, 'shortcut_hit_record_failed'));
      const lang = await this.getLangPref(msg.platform, msg.userId).catch(() => 'auto' as const);
      await this.enqueue(key, 'ack reply', () =>
        this.send(
          adapter,
          replyConversationId ?? msg.conversationId,
          lang === 'mi' ? ACK_REPLY_TEXT_MI : ACK_REPLY_TEXT,
        ),
      );
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
          this.sendKnowledgeShortcut(msg, adapter, hit, replyConversationId),
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
        this.recordShortcutHit('repeat_question').catch((err) =>
          logger.warn({ err }, 'shortcut_hit_record_failed'),
        );
        await this.enqueue(key, 'repeat-question shortcut reply', () =>
          this.sendRepeatShortcut(msg, adapter, cached.replyText, replyConversationId),
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
        this.recordShortcutHit('repeat_max_turns').catch((err) =>
          logger.warn({ err }, 'shortcut_hit_record_failed'),
        );
        await this.enqueue(key, 'repeat-max-turns shortcut reply', () =>
          this.sendRepeatMaxTurnsShortcut(msg, adapter, replyConversationId),
        );
        return;
      }
    }

    // Serialise per conversation so session resume stays consistent.
    await this.enqueue(key, 'respond', () =>
      this.respond(msg, role, adapter, replyBudget, replyConversationId),
    );
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
      sourceUnreachable: top.sourceUnreachable,
      sourceCheckedAt: top.sourceCheckedAt,
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
    replyConversationId?: string,
  ): Promise<void> {
    const target = replyConversationId ?? msg.conversationId;
    logger.debug({ platform: msg.platform, conversationId: msg.conversationId }, 'knowledge_shortcut_hit');
    this.recordShortcutHit('knowledge').catch((err) => logger.warn({ err }, 'shortcut_hit_record_failed'));
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
    const lang = await this.getLangPref(msg.platform, msg.userId).catch(() => 'auto' as const);
    const suffix = lang === 'mi' ? KNOWLEDGE_SHORTCUT_SUFFIX_MI : KNOWLEDGE_SHORTCUT_SUFFIX;
    const replyText = `${hit.content}${note}${suffix}`;
    await this.send(adapter, target, replyText);
    this.recordShortcutRetrieval([hit.id]).catch((err) =>
      logger.warn({ err }, 'Knowledge shortcut retrieval count update failed'),
    );
    await recordInteraction({
      platform: msg.platform,
      conversationId: target,
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
   * Also deliberately excluded from `shortcut_hits`/`recordShortcutHit`
   * (issue #440): the `knowledge` kind counts the member-facing shortcut
   * above only, so `usage_stats`'s count is never misread as covering guest
   * hits too.
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
    // Single lookup serves both interpolated strings below (acceptance
    // criterion 3) — not a per-string read.
    const lang = await this.getLangPref(msg.platform, msg.userId).catch(() => 'auto' as const);
    const suffix = lang === 'mi' ? KNOWLEDGE_SHORTCUT_SUFFIX_MI : KNOWLEDGE_SHORTCUT_SUFFIX;
    const nudge = lang === 'mi' ? GUEST_KNOWLEDGE_SHORTCUT_NUDGE_MI : GUEST_KNOWLEDGE_SHORTCUT_NUDGE;
    const replyText = `${hit.content}${note}${suffix}${nudge}`;
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
    replyConversationId?: string,
  ): Promise<void> {
    const target = replyConversationId ?? msg.conversationId;
    // Only the fixed wrapper is translated — `cachedReplyText` is the
    // original (already-served) answer's language, left untouched (issue
    // #339/#405's "translate the shell, not the dynamic payload" discipline).
    const lang = await this.getLangPref(msg.platform, msg.userId).catch(() => 'auto' as const);
    const notice = lang === 'mi' ? REPEAT_SHORTCUT_NOTICE_MI : REPEAT_SHORTCUT_NOTICE;
    const replyText = `${notice}${cachedReplyText}`;
    await this.send(adapter, target, replyText);
    await recordInteraction({
      platform: msg.platform,
      conversationId: target,
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
   * precedent (#259). Also re-offers escalation (issue #479) when the flag
   * is on: this replay serves the exact same failure text `respond()` would
   * have appended the offer to, so it must carry its own live pending entry
   * rather than a dead "reply yes" left over from — or absent entirely
   * despite — the original failure.
   */
  private async sendRepeatMaxTurnsShortcut(
    msg: IncomingMessage,
    adapter: PlatformAdapter,
    replyConversationId?: string,
  ): Promise<void> {
    const target = replyConversationId ?? msg.conversationId;
    const lang = await this.getLangPref(msg.platform, msg.userId).catch(() => 'auto' as const);
    const notice = lang === 'mi' ? REPEAT_MAX_TURNS_SHORTCUT_NOTICE_MI : REPEAT_MAX_TURNS_SHORTCUT_NOTICE;
    const failure = lang === 'mi' ? MAX_TURNS_REPLY_MI : MAX_TURNS_REPLY;
    const replyText = config.behaviour.escalationToAdminEnabled
      ? `${notice}${this.offerEscalation(msg, failure, lang === 'mi')}`
      : `${notice}${failure}`;
    await this.send(adapter, target, replyText);
    await recordInteraction({
      platform: msg.platform,
      conversationId: target,
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

  private async respond(
    msg: IncomingMessage,
    role: Tier,
    adapter: PlatformAdapter,
    replyBudget?: { used: number; limit: number },
    replyConversationId?: string,
  ): Promise<void> {
    const target = replyConversationId ?? msg.conversationId;
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

      // Real-time admin escalation (issue #479): append the "reply yes"
      // offer and atomically register its live pending entry (see
      // `offerEscalation`'s doc comment) ONLY for a genuine max-turns
      // failure — `reply.ok`/other failure modes are untouched. Threaded
      // into `outboundText` (not `reply.text` itself) so the caches below
      // that key off `reply.text`/`reply.ok` stay exactly as before.
      let outboundText =
        config.behaviour.escalationToAdminEnabled && reply.maxTurnsExceeded === true
          ? this.offerEscalation(msg, reply.text, reply.languagePreference === 'mi')
          : reply.text;

      // Approaching-daily-budget warning (issue #511): append-only, same
      // shape as `offerEscalation` above — never replaces `outboundText`, so
      // the caches below (keyed off `reply.text`/`reply.ok`, not
      // `outboundText`) stay exactly as before. `replyBudget` is only ever
      // set for a non-super-admin caller under a positive limit (see
      // `handle()`), so no separate role check is needed here. `remaining`
      // is the count AFTER this reply is sent/counted, matching the
      // acceptance criterion's `limit - (used + 1)`.
      if (config.behaviour.dailyReplyBudgetWarnEnabled && replyBudget) {
        const remaining = replyBudget.limit - (replyBudget.used + 1);
        if (remaining >= 0 && remaining <= config.behaviour.dailyReplyBudgetWarnRemaining) {
          const userKey = `${msg.platform}:${msg.userId}`;
          const lastWarned = this.budgetWarned.get(userKey) ?? 0;
          if (Date.now() - lastWarned > 24 * 3_600_000) {
            this.budgetWarned.set(userKey, Date.now());
            let warningText = DAILY_REPLY_BUDGET_WARNING_TEXT(remaining);
            if (reply.languagePreference === 'mi') {
              warningText = DAILY_REPLY_BUDGET_WARNING_TEXT_MI(remaining);
            } else {
              const style = await this.getRespStyle(msg.platform, msg.userId).catch(
                () => 'standard' as const,
              );
              if (style === 'plain') warningText = DAILY_REPLY_BUDGET_WARNING_TEXT_PLAIN(remaining);
            }
            outboundText += warningText;
          }
        }
      }

      // This call site (the real-agent-turn main reply, issue #339), the
      // gated notice (#363), and cancel/permissions-changed/pending-notice
      // (#405) all thread the caller's language preference into the send.
      // What's still intentionally English-only: the ack-shortcut reply and
      // per-tool `requireConfirm` outcome/failure strings (`pending.execute()`
      // and the `Failed: ...` fallback below) — see #405's proposal for why
      // those are out of scope.
      await this.send(adapter, target, outboundText, reply.languagePreference === 'mi' ? 'mi' : undefined);

      // If the turn registered a NEW pending destructive action, the model
      // composed the reply above and could have hidden or misrepresented the
      // action behind an innocuous "reply CONFIRM" (an injection lever). Emit
      // the authoritative pending description ourselves, deterministically, so
      // the human always sees the true action before they can confirm it
      // (issue: CONFIRM gate was request-side model-mediated).
      const pending = peekPendingAction(msg.platform, msg.conversationId, msg.userId);
      const registeredNewPending = Boolean(pending && pending !== priorPending);
      if (pending && registeredNewPending) {
        const lang = await this.getLangPref(msg.platform, msg.userId).catch(() => 'auto' as const);
        let pendingText: string;
        if (lang === 'mi') {
          pendingText = PENDING_NOTICE_MI(pending.description);
        } else {
          const style = await this.getRespStyle(msg.platform, msg.userId).catch(() => 'standard' as const);
          pendingText =
            style === 'plain'
              ? PENDING_NOTICE_PLAIN(pending.description)
              : PENDING_NOTICE(pending.description);
        }
        await this.send(adapter, target, pendingText).catch((err) =>
          logger.warn({ err }, 'Failed to send deterministic pending notice'),
        );
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
        conversationId: target,
        userId: 'bot',
        userName: 'CommunityAgent',
        role: 'member',
        direction: 'outbound',
        content: outboundText,
        costUsd: reply.costUsd,
        meta: {
          replyToUserId: msg.userId,
          ...(reply.maxTurnsExceeded === true ? { maxTurnsExceeded: true } : {}),
          // Best-effort knowledge_search-hit correlation on the normal
          // (non-shortcut) outbound path (issue #411) — the same scalar
          // `knowledgeEntryId` meta key `sendKnowledgeShortcut` already
          // writes, so both paths feed `listKnowledgeFeedbackSummary` /
          // `listAnswerFeedback` with no query/schema change. Absent
          // whenever no `knowledge_search` call in the turn had a hit clear
          // the relevance floor.
          ...(reply.knowledgeEntryId != null ? { knowledgeEntryId: reply.knowledgeEntryId } : {}),
          // Cache-usage telemetry (issue #522): mirrors the conditional-spread
          // pattern above, but gated on `> 0` rather than `!= null` — a turn
          // whose SDK result carried no `usage` at all (undefined) AND a turn
          // whose `usage` reported all-zero cache counts must both write
          // neither key (acceptance criterion 2), so a zero here is treated
          // the same as "nothing to report", not as a real reading.
          ...(reply.cacheReadTokens != null && reply.cacheReadTokens > 0
            ? { cacheReadTokens: reply.cacheReadTokens }
            : {}),
          ...(reply.cacheCreationTokens != null && reply.cacheCreationTokens > 0
            ? { cacheCreationTokens: reply.cacheCreationTokens }
            : {}),
        },
      }).catch((err) => logger.error({ err }, 'Failed to record outbound interaction'));
    } finally {
      clearInterval(typingTimer);
    }
  }
}
