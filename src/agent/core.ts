import { query, type HookJSONOutput, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { atLeast, toolsForRole, type CallerContext } from '../auth/rbac.js';
import { superAdminIds } from '../auth/roles.js';
import type { AdapterLookup, Platform, PlatformAdapter } from '../platforms/types.js';
import {
  clearClaudeSessionId,
  getClaudeSession,
  getLanguagePreference,
  getResponseStyle,
  recentConversationTail,
  searchMemory,
  setClaudeSessionId,
  type ConversationTailRow,
  type LanguagePreference,
  type ResponseStyle,
} from '../storage/repository.js';
import { getCodeAnswersPolicy } from '../storage/policies.js';
import { queuePendingAlert } from '../pendingAlertQueue.js';
import {
  buildSystemPrompt,
  renderConversationTail,
  renderMemoryContext,
  renderRequesterTag,
} from './systemPrompt.js';
import { selectPersona } from './personas.js';
import {
  buildToolServer,
  isDuplicateWebSearchQuery,
  recordWebSearchQuery,
  reserveWebSearchSlot,
  type ToolServerTurnState,
} from './tools.js';
import {
  initialUsageLimitTracker,
  isUsageLimitFailure,
  stepUsageLimitTracker,
  USAGE_LIMIT_REPLY,
  USAGE_LIMIT_REPLY_ADMIN_NOTIFIED,
  USAGE_LIMIT_REPLY_MI,
  USAGE_LIMIT_REPLY_ADMIN_NOTIFIED_MI,
  USAGE_LIMIT_REPLY_PLAIN,
  USAGE_LIMIT_REPLY_ADMIN_NOTIFIED_PLAIN,
} from './upstreamFailure.js';

export interface AgentReply {
  text: string;
  costUsd?: number;
  /**
   * Cache-hit/-write token counts read from the SDK `result` message's
   * `usage` field (issue #508 added the read; issue #522 threads it here so
   * `usage_stats` can surface it instead of it only ever reaching a debug
   * log). Mirrors `costUsd` exactly: set on both the success return and the
   * non-success/max-turns return (a max-turns turn still spends real,
   * cacheable input tokens), left `undefined` on the thrown-error catch path
   * (which has no `usage`) and whenever the SDK reports no `usage` at all.
   */
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  sessionId?: string;
  /**
   * Whether this reply is a genuine answer (`TurnOutcome.ok`), as opposed to
   * a fallback/error string (internal error, upstream usage-limit, max-turns,
   * ...). Optional so existing test doubles that construct an `AgentReply`
   * literal without it keep compiling; a caller that cares (e.g. the
   * repeat-question shortcut, issue #259) must check `=== true`, never treat
   * a missing value as truthy.
   */
  ok?: boolean;
  /**
   * Set to `true` only when the turn ended with SDK `resultSubtype ===
   * 'error_max_turns'` — a deterministic, content-independent failure (issue
   * #306's max-turns repeat shortcut). Every other branch (success, other
   * non-success subtypes, thrown-error catch) leaves this `undefined`; a
   * caller that cares must check `=== true`, never treat a missing value as
   * truthy.
   */
  maxTurnsExceeded?: boolean;
  /**
   * The caller's standing language preference for this turn (issue #339),
   * threaded straight from the same `getLanguagePreference` lookup
   * `buildSystemPrompt` already uses — no new DB call. Left `undefined` only
   * when that lookup itself throws (see the try/catch below); a resolved
   * `'auto'`/`'en'`/`'mi'` is always returned as-is, never coerced. Consumed
   * downstream by the router's main-reply send to pick the `_MI` outbound
   * code-policy note.
   */
  languagePreference?: LanguagePreference;
  /**
   * Best-effort correlation with the most recent `knowledge_search` call in
   * this turn that had a hit clear `KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD`
   * (issue #411) — the id of that call's top-scoring hit, threaded from
   * `TurnOutcome.knowledgeEntryId` via the same turn-scoped-ref pattern
   * `buildToolServer` already uses. This is a correlation, not a guarantee:
   * it names the last qualifying `knowledge_search` call in the turn, not
   * necessarily the entry the model's final reply actually drew from.
   * `undefined` whenever no call in the turn had a qualifying hit, or the
   * turn didn't end in a genuine success (`TurnOutcome.ok === true`) — never
   * a stale id left over from an earlier failed attempt. The router's normal
   * outbound-recording path (router.ts) writes this into the same
   * `meta.knowledgeEntryId` key the deterministic knowledge-shortcut path
   * already stamps, so both paths feed the same admin aggregation
   * (`list_low_rated_knowledge` / `list_answer_feedback`).
   */
  knowledgeEntryId?: number;
}

/**
 * User-facing fallback when a turn dies on an internal failure. Shared with
 * the router's pre-send backstop (issue #52) so a DB blip mid-turn produces
 * the same degraded reply as an agent-query failure — never silence.
 */
export const INTERNAL_ERROR_REPLY =
  'Sorry — I hit an internal error and could not complete that. Please try again.';

/**
 * User-facing fallback when a turn exhausts `AGENT_MAX_TURNS` without
 * finishing. Exported so the router's max-turns repeat shortcut (issue #306)
 * can replay the exact same, fixed, content-independent string on a cached
 * hit instead of duplicating it.
 */
export const MAX_TURNS_REPLY =
  'Sorry — that took more steps than I allow per message. Try breaking it into smaller questions.';

/**
 * User-facing fallback for any other non-success `resultSubtype`. Hoisted
 * from an inline literal (issue #396) so it can gain an `_MI` counterpart
 * like its three siblings above.
 */
export const TURN_FAILED_REPLY = 'Sorry — I could not complete that request. Please try again.';

// Fixed, human-authored te reo Māori variants (issue #396) of the four
// runAgentTurn failure fallbacks above, served instead of the English
// constant to a caller with a standing 'mi' language_prefs row
// (getLanguagePreference, issue #189) — same trust level as the English
// constants: no model call, no translation, no injection surface. Mirrors
// the `_MI`-variant pattern established by #266/#282/#300/#331/#363.
export const INTERNAL_ERROR_REPLY_MI =
  'Aroha mai — i pā mai he hapa o roto, kāore i oti i ahau tēnā mahi. Tēnā koa, whakamātauria anō.';

export const MAX_TURNS_REPLY_MI =
  'Aroha mai — he maha rawa ngā hipanga i hiahiatia mō tēnei karere. Whakamātauria te wāwāhi i tō ' +
  'pātai kia iti ake ngā wāhanga.';

export const TURN_FAILED_REPLY_MI = 'Aroha mai — kāore i oti i ahau tēnā tono. Tēnā koa, whakamātauria anō.';

/**
 * Lookup from an English fallback constant to its `_MI` counterpart, applied
 * to `outcome.text` in `runAgentTurn` just before it becomes `AgentReply.text`
 * (issue #396). Keyed by string value rather than by branch so the mapping
 * stays in one place next to the constants it substitutes.
 */
const FALLBACK_REPLY_MI: Readonly<Record<string, string>> = {
  [INTERNAL_ERROR_REPLY]: INTERNAL_ERROR_REPLY_MI,
  [MAX_TURNS_REPLY]: MAX_TURNS_REPLY_MI,
  [TURN_FAILED_REPLY]: TURN_FAILED_REPLY_MI,
  [USAGE_LIMIT_REPLY]: USAGE_LIMIT_REPLY_MI,
  [USAGE_LIMIT_REPLY_ADMIN_NOTIFIED]: USAGE_LIMIT_REPLY_ADMIN_NOTIFIED_MI,
};

// Fixed, human-authored plain-language variants (issue #430) of the same
// four runAgentTurn failure fallbacks, served instead of the English
// constant to a caller with a standing 'plain' response-style preference
// (getResponseStyle, issue #126) whose language preference is NOT 'mi' —
// 'mi' takes precedence over 'plain' (see FALLBACK_REPLY_PLAIN's use below).
// Same trust level as the English constants: no model call, no translation,
// no injection surface.
export const INTERNAL_ERROR_REPLY_PLAIN = 'Sorry, something went wrong on my end. Please try again.';

export const MAX_TURNS_REPLY_PLAIN =
  'Sorry, that was too many steps for me to finish in one go. Please split it into smaller questions.';

export const TURN_FAILED_REPLY_PLAIN = 'Sorry, I could not finish that. Please try again.';

/**
 * Lookup from an English fallback constant to its `_PLAIN` counterpart,
 * mirroring `FALLBACK_REPLY_MI` exactly (issue #430) — applied only when
 * `languagePreference !== 'mi'`, so a caller with both preferences set still
 * gets the `_MI` text (acceptance criterion 3).
 */
const FALLBACK_REPLY_PLAIN: Readonly<Record<string, string>> = {
  [INTERNAL_ERROR_REPLY]: INTERNAL_ERROR_REPLY_PLAIN,
  [MAX_TURNS_REPLY]: MAX_TURNS_REPLY_PLAIN,
  [TURN_FAILED_REPLY]: TURN_FAILED_REPLY_PLAIN,
  [USAGE_LIMIT_REPLY]: USAGE_LIMIT_REPLY_PLAIN,
  [USAGE_LIMIT_REPLY_ADMIN_NOTIFIED]: USAGE_LIMIT_REPLY_ADMIN_NOTIFIED_PLAIN,
};

interface TurnOutcome {
  ok: boolean;
  resumeFailed: boolean;
  text: string;
  costUsd?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  sessionId?: string;
  maxTurnsExceeded?: boolean;
  knowledgeEntryId?: number;
}

/**
 * Tool groups gated behind a config flag that defaults `false` — each
 * handler already refuses independently when its flag is off (defense in
 * depth, kept as-is), but leaving them in `allowedTools` still pays their
 * full name+description+schema tokens on every turn for a tier that can
 * never successfully call them (issue #535). Purely subtractive: a tool
 * named here is dropped from `allowedTools` only while its flag is off.
 */
const FEATURE_FLAGGED_TOOL_GROUPS: ReadonlyArray<{ enabled: boolean; tools: readonly string[] }> = [
  { enabled: config.imageGen.enabled, tools: ['mcp__community__generate_image'] },
  { enabled: config.github.enabled, tools: ['mcp__community__suggest_issue'] },
  {
    enabled: config.devTeam.enabled,
    tools: [
      'mcp__community__dev_team_dispatch',
      'mcp__community__dev_team_status',
      'mcp__community__dev_team_result',
      'mcp__community__dev_team_backlog',
      'mcp__community__dev_team_findings',
      'mcp__community__dev_team_verify',
    ],
  },
];

function filterFeatureFlaggedTools(tools: string[]): string[] {
  const disabled = new Set(FEATURE_FLAGGED_TOOL_GROUPS.filter((g) => !g.enabled).flatMap((g) => g.tools));
  return tools.filter((t) => !disabled.has(t));
}

/**
 * Build the SDK query options for one turn. Extracted (and exported) so the
 * security invariants are regression-testable:
 *  - built-in Claude Code tools are disabled via `tools` (empty for members;
 *    admin+ additionally get WebSearch — and ONLY WebSearch);
 *  - WebFetch is disallowed for every tier (URL construction is an
 *    exfiltration channel; fetched pages are a rich injection vector);
 *  - `allowedTools` is derived from the caller's role, further filtered by
 *    platform (Discord-only tools dropped on WhatsApp) and by feature flags
 *    (tools behind a disabled `config.*.enabled` dropped entirely, issue
 *    #535) — never from message content, and only ever a subtractive filter;
 *  - `maxTurns` is tiered by role: member/guest get the lower
 *    `AGENT_MAX_TURNS_MEMBER` ceiling, admin+ keep `AGENT_MAX_TURNS`.
 *  - `model` is tiered by role the same way (issue #382): member/guest get
 *    `AGENT_MODEL_MEMBER` when set, admin+ always keep `AGENT_MODEL`. This
 *    tiering is cosmetic to cost, not security — it must never affect the
 *    tool-gating fields above.
 *  - admin+'s WebSearch is additionally capped per-conversation via a
 *    `PreToolUse` hook (issue #412): WebSearch is the one metered, real-cost
 *    built-in tool the bot grants, and unlike the bot's own MCP tools
 *    (`create_poll`/`create_thread`/`warn_user`/`announce`, each already
 *    behind a `reserve*Slot` rolling-hour cap) it was previously bounded only
 *    by the shared `maxTurns` loop-depth ceiling. `hooks.PreToolUse` is used
 *    rather than `canUseTool` because a tool listed bare in `allowedTools`
 *    (which `WebSearch` is) auto-approves and never reaches `canUseTool` —
 *    only a `PreToolUse` hook is guaranteed to fire regardless of that
 *    auto-approval path. Member/guest turns never get this hook at all —
 *    there is nothing to gate, since `tools`/`allowedTools` already exclude
 *    WebSearch for those tiers.
 *  - the same hook additionally denies an exact-normalized repeat of a
 *    recent query in the same conversation (issue #589,
 *    `isDuplicateWebSearchQuery`/`recordWebSearchQuery` in `tools.ts`) — the
 *    volume cap above bounds call count but never inspected the query, so an
 *    agentic turn could reformulate and re-fire the same search for no new
 *    information. The dedup CHECK runs BEFORE the volume-cap check and, on a
 *    match, denies without consuming a volume slot (a call the guard itself
 *    blocked never reaches the real search, so it shouldn't count against
 *    the hourly budget). The query is only RECORDED into the dedup history
 *    once BOTH checks pass and the call is actually going to proceed —
 *    recording it any earlier would let a query later denied by the volume
 *    cap poison the dedup history, so a retry of that exact (never-searched)
 *    query would be wrongly denied as "already searched" instead of hitting
 *    the accurate rate-limit message. Both checks share the same try/catch,
 *    so a thrown error from either fails closed identically.
 */
export function buildQueryOptions(
  role: CallerContext['role'],
  systemPrompt: string,
  mcpServers: Record<string, McpServerConfig>,
  resumeSession: string | null,
  conversationId: string,
  platform: Platform = 'discord',
) {
  // Web search is a privileged capability: admins and super admins only.
  const webSearch = atLeast(role, 'admin');
  return {
    // Member/guest turns get the tiered AGENT_MODEL_MEMBER override when set
    // (issue #382), the same highest-volume/lowest-trust role split #347
    // already applies to maxTurns. Unset (the default) falls back to
    // config.llm.model for every role — byte-identical to pre-#382 behaviour.
    model: atLeast(role, 'admin') ? config.llm.model : (config.llm.memberModel ?? config.llm.model),
    systemPrompt,
    mcpServers,
    // The base built-in tool set. Empty = no built-ins at all; admin+ get
    // exactly one: WebSearch. `allowedTools` alone only auto-approves; this
    // list is what actually restricts the surface.
    tools: webSearch ? ['WebSearch'] : [],
    allowedTools: [
      ...filterFeatureFlaggedTools(toolsForRole(role, platform)),
      ...(webSearch ? ['WebSearch'] : []),
    ],
    disallowedTools: ['Task', 'WebFetch', ...(webSearch ? [] : ['WebSearch'])],
    permissionMode: 'default' as const,
    // Member/guest turns get a tighter loop-depth ceiling than admin+
    // (issue #347): MEMBER_TOOLS is a much narrower surface, so a
    // stuck/injected turn on the highest-volume, lowest-trust tier is
    // bounded to less worst-case cost. admin/super_admin are unchanged.
    maxTurns: atLeast(role, 'admin') ? config.llm.maxTurns : config.llm.memberMaxTurns,
    ...(resumeSession ? { resume: resumeSession } : {}),
    // Don't load the host machine's ~/.claude config into the agent.
    settingSources: [] as [],
    ...(webSearch
      ? {
          hooks: {
            PreToolUse: [
              {
                matcher: 'WebSearch',
                hooks: [
                  async (input: unknown): Promise<HookJSONOutput> => {
                    // Fail closed: a thrown/rejected error while checking
                    // either the dedup or the rate cap must never let the
                    // call through unbounded — denies instead of relying on
                    // any SDK default behaviour on a hook exception, which
                    // this repo has never exercised before (issue #412
                    // AC-5, extended to the dedup check by issue #589).
                    try {
                      const toolInput = (input as { tool_input?: unknown } | undefined)?.tool_input;
                      const query =
                        toolInput &&
                        typeof toolInput === 'object' &&
                        typeof (toolInput as { query?: unknown }).query === 'string'
                          ? (toolInput as { query: string }).query
                          : '';

                      const dedupWindowMs = config.llm.webSearchDedupWindowSeconds * 1000;
                      if (isDuplicateWebSearchQuery(conversationId, query, dedupWindowMs)) {
                        return {
                          continue: true,
                          hookSpecificOutput: {
                            hookEventName: 'PreToolUse',
                            permissionDecision: 'deny',
                            permissionDecisionReason:
                              'You already searched for this in the last few minutes — use what you found.',
                          },
                        };
                      }

                      const allowed = reserveWebSearchSlot(
                        conversationId,
                        config.llm.webSearchRateLimitPerHour,
                      );
                      if (!allowed) {
                        return {
                          continue: true,
                          hookSpecificOutput: {
                            hookEventName: 'PreToolUse',
                            permissionDecision: 'deny',
                            permissionDecisionReason:
                              'WebSearch already hit the conversation limit ' +
                              `(${config.llm.webSearchRateLimitPerHour}/hour) — try again later.`,
                          },
                        };
                      }

                      // Only record once the call is actually going to proceed — recording a
                      // query that then gets denied by the volume cap would poison the dedup
                      // history with a search that never ran (issue #589 review).
                      recordWebSearchQuery(
                        conversationId,
                        query,
                        dedupWindowMs,
                        config.llm.webSearchDedupHistorySize,
                      );
                      return { continue: true };
                    } catch (err) {
                      logger.error(
                        { err, conversationId },
                        'WebSearch rate-limit/dedup check threw — failing closed (denying the call)',
                      );
                      return {
                        continue: true,
                        hookSpecificOutput: {
                          hookEventName: 'PreToolUse',
                          permissionDecision: 'deny',
                          permissionDecisionReason:
                            'WebSearch is temporarily unavailable — an internal error occurred while ' +
                            'checking the rate limit.',
                        },
                      };
                    }
                  },
                ],
              },
            ],
          },
        }
      : {}),
  };
}

/**
 * Run one agent turn for an incoming message.
 *
 * Pipeline: recall relevant memory -> build a role-scoped system prompt and
 * tool surface -> resume the per-conversation Claude session -> stream the
 * result. Tool access is restricted by RBAC via `allowedTools`, and ALL
 * built-in Claude Code tools (Bash/Read/Write/...) are disabled via
 * `tools: []`, so the model's only capabilities are our MCP tools.
 */
export async function runAgentTurn(
  caller: CallerContext,
  userText: string,
  adapter: PlatformAdapter,
  getAdapter?: AdapterLookup,
): Promise<AgentReply> {
  // Memory recall is scoped to THIS conversation only. Cross-conversation
  // recall is available solely through the admin-gated tools, so a public
  // channel can never surface someone else's DMs.
  const memories = await searchMemory(userText, {
    platform: caller.platform,
    conversationId: caller.conversationId,
  });

  const codeAnswers = await getCodeAnswersPolicy();
  // getResponseStyle already fails open internally (degrades to 'standard' on
  // a DB error, see repository.ts) — this try/catch is a second, independent
  // backstop for the lookup itself throwing/rejecting (e.g. an injected test
  // double, or a future caller that removes that internal catch), mirroring
  // the languagePreference backstop just below (issue #430 acceptance
  // criterion 5 / #52's fail-open invariant). Unlike languagePreference,
  // there is no "lookup failed" state to preserve here — responseStyle only
  // ever gates a substitution, never gets echoed back on `AgentReply` — so it
  // degrades straight to the 'standard' default rather than staying optional.
  let responseStyle: ResponseStyle = 'standard';
  try {
    responseStyle = await getResponseStyle(caller.platform, caller.userId);
  } catch (err) {
    logger.warn(
      { err, conversationId: caller.conversationId },
      'Response-style lookup failed; degrading to standard',
    );
  }
  // getLanguagePreference already fails open internally (degrades to 'auto'
  // on a DB error, see repository.ts) — this try/catch is a second,
  // independent backstop for the lookup itself throwing/rejecting (e.g. an
  // injected test double, or a future caller that removes that internal
  // catch), so a language-preference fault can never take down the whole
  // turn (issue #52's fail-open invariant). `reply.languagePreference` is
  // left `undefined` in that case rather than coerced to 'auto', so a caller
  // can distinguish "resolved to auto" from "lookup failed" if it ever needs
  // to.
  let languagePreference: LanguagePreference | undefined;
  try {
    languagePreference = await getLanguagePreference(caller.platform, caller.userId);
  } catch (err) {
    logger.warn(
      { err, conversationId: caller.conversationId },
      'Language-preference lookup failed; degrading the code-policy note to English',
    );
  }
  const persona = selectPersona({ text: userText });
  const systemPrompt = buildSystemPrompt(
    caller,
    { codeAnswers, responseStyle, languagePreference: languagePreference ?? 'auto' },
    persona,
  );
  // Recalled messages are untrusted user content: they ride in the user turn
  // inside a clearly delimited block, never in the system prompt. The
  // requester's display name rides here too (issue #508, relocated from the
  // system prompt's `Context:` block): keeping it out of the system prompt
  // keeps that string byte-identical across different posters of the same
  // role in the same conversation, which is the real precondition for an
  // Anthropic prompt-cache hit at the system block's trailing breakpoint.
  const memoryBlock = memories.length > 0 ? renderMemoryContext(memories) : '';

  // Session hygiene: cap resumed-session length and age so context (and any
  // accumulated injection) can't grow without bound.
  const stored = await getClaudeSession(caller.platform, caller.conversationId);
  const maxAgeMs = config.behaviour.sessionMaxAgeHours * 3_600_000;
  const priorSession =
    stored &&
    stored.turnCount < config.behaviour.sessionMaxTurns &&
    Date.now() - stored.updatedAt.getTime() < maxAgeMs
      ? stored.sessionId
      : null;
  if (stored && !priorSession) {
    logger.info(
      { conversationId: caller.conversationId, turnCount: stored.turnCount },
      'Session past turn/age cap — starting fresh',
    );
  }

  // Fresh-session continuity backfill: a turn with no resumable session
  // (first contact, cap rollover above, a role-change/purge-cleared session,
  // or the failed-resume retry below) has lost the in-session conversation
  // history, and semantic recall alone can't reconstruct it — it keys on the
  // CURRENT message text, so a follow-up like "why didn't you do that?"
  // recalls nothing useful and the bot goes amnesiac between two adjacent
  // messages. Quote the conversation's recent tail into the user turn as
  // quarantined reference data (same untrusted framing as recall; a resumed
  // session gets none — its history is already in-session). The tail may
  // racily include the current inbound message (the router records it
  // fire-and-forget before this turn runs) — a harmless duplicate of the
  // message text below, not a correctness problem.
  const tailLimit = config.behaviour.sessionRolloverTailCount;
  const fetchTail = () => recentConversationTail(caller.platform, caller.conversationId, tailLimit);
  const assemblePrompt = (tail: ConversationTailRow[]) =>
    [
      renderRequesterTag(caller.userName),
      tail.length > 0 ? renderConversationTail(tail) : '',
      memoryBlock,
      userText,
    ]
      .filter(Boolean)
      .join('\n\n');
  const prompt = assemblePrompt(priorSession ? [] : await fetchTail());

  const first = await execTurn(caller, prompt, systemPrompt, adapter, priorSession, getAdapter);
  let outcome = first;

  // If resuming a stale/foreign session failed (session files are CLI-local
  // disk state), drop the stored id and retry once with a fresh session so
  // the conversation doesn't brick itself. The retry is a fresh session too,
  // so it gets the same tail backfill the rollover path above does.
  if (!first.ok && first.resumeFailed && priorSession) {
    logger.warn(
      { conversationId: caller.conversationId, priorSession },
      'Session resume failed; clearing stored session and retrying fresh',
    );
    await clearClaudeSessionId(caller.platform, caller.conversationId).catch(() => {});
    outcome = await execTurn(
      caller,
      assemblePrompt(await fetchTail()),
      systemPrompt,
      adapter,
      null,
      getAdapter,
    );
  }

  if (outcome.sessionId) {
    await setClaudeSessionId(caller.platform, caller.conversationId, outcome.sessionId).catch((err) =>
      logger.warn({ err }, 'Failed to persist session id'),
    );
  }

  // Substitute the 'mi' or 'plain' variant for a fixed failure-fallback
  // string (issues #396/#430). Gated on `outcome.ok === false` — never on
  // matching the text itself — so a genuine model answer can never be
  // rewritten, even in the vanishingly unlikely case its text happened to
  // coincide with one of these constants (the #259 "threaded, not
  // string-matched" discipline). 'mi' takes precedence over 'plain' when a
  // caller has both preferences set (acceptance criterion 3). Falls through
  // unchanged for any text not in the lookup (e.g. English/'auto'/undefined
  // language preference with 'standard' response style, or a value that
  // isn't one of the four fallbacks).
  const text = !outcome.ok
    ? languagePreference === 'mi'
      ? (FALLBACK_REPLY_MI[outcome.text] ?? outcome.text)
      : responseStyle === 'plain'
        ? (FALLBACK_REPLY_PLAIN[outcome.text] ?? outcome.text)
        : outcome.text
    : outcome.text;

  return {
    text,
    costUsd: outcome.costUsd,
    cacheReadTokens: outcome.cacheReadTokens,
    cacheCreationTokens: outcome.cacheCreationTokens,
    sessionId: outcome.sessionId,
    ok: outcome.ok,
    maxTurnsExceeded: outcome.maxTurnsExceeded,
    languagePreference,
    knowledgeEntryId: outcome.knowledgeEntryId,
  };
}

// Module-level: the upstream usage-limit condition is a property of the
// shared Max pool, not any one conversation, so the debounce latch is
// process-wide rather than per-conversation (mirrors usageAlert.ts's
// single rolling tracker).
let usageLimitTracker = initialUsageLimitTracker();

/**
 * Both members of the `Platform` union (`src/platforms/types.ts`) — fixed at
 * two today; a future third adapter only needs adding here. Mirrors
 * `tools.ts`'s `ALL_PLATFORMS` (issue #288); not shared across the two files
 * since that constant is module-private there.
 */
const ALL_PLATFORMS: readonly Platform[] = ['discord', 'whatsapp'];

/**
 * Debounced super-admin DM when a turn fails on an upstream usage-limit/
 * overload condition (issue #131) — one per ongoing window, silent re-arm
 * once a turn stops hitting it. No-op unless UPSTREAM_LIMIT_ALERT_ENABLED.
 * DMs go out via every connected adapter (issue #325), not just the one that
 * saw the failure — this is a shared-Max-pool condition, so it degrades every
 * platform at once, mirroring `tools.ts`'s `notifySuperAdmins` (#288) and
 * every other sibling alert path (health.ts, usageAlert.ts, backgroundJobs.ts,
 * router.ts). Unlike `notifySuperAdmins`, there is no triggering user to
 * exclude — this is a system-condition alert, not a member-initiated one — so
 * every id in each connected platform's `superAdminIds(platform)` is DMed.
 */
const USAGE_LIMIT_ALERT_MESSAGE =
  '⚠️ The bot just hit an upstream Claude usage-limit/overload condition — members are seeing a ' +
  "degraded reply. This isn't a bug and should clear once the shared quota resets; consider " +
  'pause_bot if it persists.';

function noteUsageLimitOutcome(
  hitUsageLimit: boolean,
  adapter: PlatformAdapter,
  conversationId: string,
  getAdapter: AdapterLookup | undefined,
): void {
  if (!config.behaviour.upstreamLimitAlertEnabled) return;
  const step = stepUsageLimitTracker(usageLimitTracker, hitUsageLimit);
  usageLimitTracker = step.tracker;
  if (!step.shouldAlert) return;
  logger.warn(
    { conversationId, platform: adapter.platform },
    'Upstream Claude usage-limit/overload detected',
  );
  const targets = ALL_PLATFORMS.map((platform) =>
    platform === adapter.platform ? adapter : getAdapter?.(platform),
  ).filter((target): target is PlatformAdapter => target != null && target.isConnected());
  if (targets.length === 0) {
    logger.warn(
      { conversationId },
      'Usage-limit alert could not be delivered live — no connected adapter; queued for flush on reconnect',
    );
    queuePendingAlert(USAGE_LIMIT_ALERT_MESSAGE, 'system'); // super-admin-only alert — never evicted by a member-reachable alert (#545)
    return;
  }
  for (const target of targets) {
    for (const id of superAdminIds(target.platform)) {
      target
        .sendDirectMessage(id, USAGE_LIMIT_ALERT_MESSAGE)
        .catch((err) => logger.warn({ err, platform: target.platform, id }, 'Usage-limit alert DM failed'));
    }
  }
}

async function execTurn(
  caller: CallerContext,
  prompt: string,
  systemPrompt: string,
  adapter: PlatformAdapter,
  resumeSession: string | null,
  getAdapter?: AdapterLookup,
): Promise<TurnOutcome> {
  // Turn-scoped ref (issue #411): the knowledge_search handler writes the
  // top-scoring id of its most recent qualifying hit here; read back below
  // only on the genuine-success path (never on a thrown-error or non-success
  // result, so a fallback/error reply can never carry a stale correlation).
  const turnState: ToolServerTurnState = { lastKnowledgeHitId: null };
  const toolServer = buildToolServer(caller, adapter, getAdapter, turnState);

  // Text of the assistant message currently being streamed. Reset per
  // assistant message so tool-use narration from earlier turns never leaks
  // into the user-facing reply.
  let lastAssistantText = '';
  let resultText = '';
  let resultSubtype: string | undefined;
  let costUsd: number | undefined;
  let cacheReadTokens: number | undefined;
  let cacheCreationTokens: number | undefined;
  let sessionId: string | undefined;

  try {
    for await (const message of query({
      prompt,
      options: buildQueryOptions(
        caller.role,
        systemPrompt,
        { community: toolServer },
        resumeSession,
        caller.conversationId,
        caller.platform,
      ),
    })) {
      switch (message.type) {
        case 'system':
          if (message.subtype === 'init') sessionId = message.session_id;
          break;
        case 'assistant': {
          const content = (message as { message?: { content?: Array<{ type: string; text?: string }> } })
            .message?.content;
          if (Array.isArray(content)) {
            const textBlocks = content
              .filter((b) => b.type === 'text' && b.text)
              .map((b) => b.text as string);
            if (textBlocks.length > 0) lastAssistantText = textBlocks.join('\n');
          }
          break;
        }
        case 'result':
          if ('session_id' in message && typeof message.session_id === 'string') {
            sessionId = message.session_id;
          }
          if ('total_cost_usd' in message && typeof message.total_cost_usd === 'number') {
            costUsd = message.total_cost_usd;
          }
          if ('result' in message && typeof message.result === 'string') {
            resultText = message.result;
          }
          // Cache-usage telemetry (issue #508): the SDK result message's
          // `usage` exposes real cache-hit/-write counts, so an operator can
          // empirically confirm (and quantify) the prompt-cache benefit the
          // system-prompt relocation above is meant to recover, instead of
          // taking a code-level proxy on faith.
          if ('usage' in message && message.usage && typeof message.usage === 'object') {
            const usage = message.usage as {
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
            cacheReadTokens = usage.cache_read_input_tokens;
            cacheCreationTokens = usage.cache_creation_input_tokens;
            logger.debug(
              {
                conversationId: caller.conversationId,
                cacheReadTokens: usage.cache_read_input_tokens,
                cacheCreationTokens: usage.cache_creation_input_tokens,
              },
              'agent turn cache usage',
            );
          }
          resultSubtype = message.subtype;
          break;
        default:
          break;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, conversationId: caller.conversationId }, 'Agent query failed');
    // Distinguish an upstream Claude usage-limit/overload condition (issue
    // #131) from a random internal failure — "please try again" is actively
    // misleading when the shared pool is genuinely exhausted. Only inspects
    // the SDK/CLI's own error message, never user-supplied text, and always
    // returns a fixed string (the raw error is never echoed).
    const usageLimitHit = isUsageLimitFailure(msg);
    noteUsageLimitOutcome(usageLimitHit, adapter, caller.conversationId, getAdapter);
    return {
      ok: false,
      // Heuristic: resume failures surface as errors mentioning the session.
      resumeFailed: resumeSession != null && /session|resume/i.test(msg),
      text: usageLimitHit
        ? config.behaviour.upstreamLimitAlertEnabled
          ? USAGE_LIMIT_REPLY_ADMIN_NOTIFIED
          : USAGE_LIMIT_REPLY
        : INTERNAL_ERROR_REPLY,
    };
  }

  if (resultSubtype && resultSubtype !== 'success') {
    logger.warn(
      { subtype: resultSubtype, conversationId: caller.conversationId },
      'Agent turn ended non-success',
    );
    // Non-success results (max turns, etc.) are a distinct, already-clean
    // signal — not the opaque thrown-error path the classifier above targets
    // — but still count as "not a usage-limit failure" for the debounce so a
    // recovering turn re-arms the latch.
    noteUsageLimitOutcome(false, adapter, caller.conversationId, getAdapter);
    // Never surface the raw internal transcript on failures.
    return {
      ok: false,
      // Non-success results (e.g. max turns) are turn failures, not resume
      // failures — those throw during init and are handled in the catch above.
      resumeFailed: false,
      text: resultSubtype === 'error_max_turns' ? MAX_TURNS_REPLY : TURN_FAILED_REPLY,
      costUsd,
      cacheReadTokens,
      cacheCreationTokens,
      sessionId,
      maxTurnsExceeded: resultSubtype === 'error_max_turns' ? true : undefined,
    };
  }

  noteUsageLimitOutcome(false, adapter, caller.conversationId, getAdapter);
  const text = resultText.trim() || lastAssistantText.trim() || "I don't have a response for that.";
  return {
    ok: true,
    resumeFailed: false,
    text,
    costUsd,
    cacheReadTokens,
    cacheCreationTokens,
    sessionId,
    ...(turnState.lastKnowledgeHitId != null ? { knowledgeEntryId: turnState.lastKnowledgeHitId } : {}),
  };
}
