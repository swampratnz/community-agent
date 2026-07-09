import { query, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { atLeast, toolsForRole, type CallerContext } from '../auth/rbac.js';
import { superAdminIds } from '../auth/roles.js';
import type { AdapterLookup, PlatformAdapter } from '../platforms/types.js';
import {
  clearClaudeSessionId,
  getClaudeSession,
  getLanguagePreference,
  getResponseStyle,
  searchMemory,
  setClaudeSessionId,
} from '../storage/repository.js';
import { getCodeAnswersPolicy } from '../storage/policies.js';
import { buildSystemPrompt, renderMemoryContext } from './systemPrompt.js';
import { selectPersona } from './personas.js';
import { buildToolServer } from './tools.js';
import {
  initialUsageLimitTracker,
  isUsageLimitFailure,
  stepUsageLimitTracker,
  USAGE_LIMIT_REPLY,
  USAGE_LIMIT_REPLY_ADMIN_NOTIFIED,
} from './upstreamFailure.js';

export interface AgentReply {
  text: string;
  costUsd?: number;
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

interface TurnOutcome {
  ok: boolean;
  resumeFailed: boolean;
  text: string;
  costUsd?: number;
  sessionId?: string;
  maxTurnsExceeded?: boolean;
}

/**
 * Build the SDK query options for one turn. Extracted (and exported) so the
 * security invariants are regression-testable:
 *  - built-in Claude Code tools are disabled via `tools` (empty for members;
 *    admin+ additionally get WebSearch — and ONLY WebSearch);
 *  - WebFetch is disallowed for every tier (URL construction is an
 *    exfiltration channel; fetched pages are a rich injection vector);
 *  - `allowedTools` is derived from the caller's role only.
 */
export function buildQueryOptions(
  role: CallerContext['role'],
  systemPrompt: string,
  mcpServers: Record<string, McpServerConfig>,
  resumeSession: string | null,
) {
  // Web search is a privileged capability: admins and super admins only.
  const webSearch = atLeast(role, 'admin');
  return {
    model: config.llm.model,
    systemPrompt,
    mcpServers,
    // The base built-in tool set. Empty = no built-ins at all; admin+ get
    // exactly one: WebSearch. `allowedTools` alone only auto-approves; this
    // list is what actually restricts the surface.
    tools: webSearch ? ['WebSearch'] : [],
    allowedTools: [...toolsForRole(role), ...(webSearch ? ['WebSearch'] : [])],
    disallowedTools: ['Task', 'WebFetch', ...(webSearch ? [] : ['WebSearch'])],
    permissionMode: 'default' as const,
    maxTurns: config.llm.maxTurns,
    ...(resumeSession ? { resume: resumeSession } : {}),
    // Don't load the host machine's ~/.claude config into the agent.
    settingSources: [] as [],
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
  const responseStyle = await getResponseStyle(caller.platform, caller.userId);
  const languagePreference = await getLanguagePreference(caller.platform, caller.userId);
  const persona = selectPersona({ text: userText });
  const systemPrompt = buildSystemPrompt(caller, { codeAnswers, responseStyle, languagePreference }, persona);
  // Recalled messages are untrusted user content: they ride in the user turn
  // inside a clearly delimited block, never in the system prompt.
  const prompt = memories.length > 0 ? `${renderMemoryContext(memories)}\n\n${userText}` : userText;

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

  const first = await execTurn(caller, prompt, systemPrompt, adapter, priorSession, getAdapter);
  let outcome = first;

  // If resuming a stale/foreign session failed (session files are CLI-local
  // disk state), drop the stored id and retry once with a fresh session so
  // the conversation doesn't brick itself.
  if (!first.ok && first.resumeFailed && priorSession) {
    logger.warn(
      { conversationId: caller.conversationId, priorSession },
      'Session resume failed; clearing stored session and retrying fresh',
    );
    await clearClaudeSessionId(caller.platform, caller.conversationId).catch(() => {});
    outcome = await execTurn(caller, prompt, systemPrompt, adapter, null, getAdapter);
  }

  if (outcome.sessionId) {
    await setClaudeSessionId(caller.platform, caller.conversationId, outcome.sessionId).catch((err) =>
      logger.warn({ err }, 'Failed to persist session id'),
    );
  }

  return {
    text: outcome.text,
    costUsd: outcome.costUsd,
    sessionId: outcome.sessionId,
    ok: outcome.ok,
    maxTurnsExceeded: outcome.maxTurnsExceeded,
  };
}

// Module-level: the upstream usage-limit condition is a property of the
// shared Max pool, not any one conversation, so the debounce latch is
// process-wide rather than per-conversation (mirrors usageAlert.ts's
// single rolling tracker).
let usageLimitTracker = initialUsageLimitTracker();

/**
 * Debounced super-admin DM when a turn fails on an upstream usage-limit/
 * overload condition (issue #131) — one per ongoing window, silent re-arm
 * once a turn stops hitting it. No-op unless UPSTREAM_LIMIT_ALERT_ENABLED.
 * DMs go out via the platform that saw the failure, same as this turn's
 * `adapter` — mirroring health.ts/usageAlert.ts's existing super-admin
 * alert path, just scoped to one adapter instead of iterating all of them.
 */
function noteUsageLimitOutcome(
  hitUsageLimit: boolean,
  adapter: PlatformAdapter,
  conversationId: string,
): void {
  if (!config.behaviour.upstreamLimitAlertEnabled) return;
  const step = stepUsageLimitTracker(usageLimitTracker, hitUsageLimit);
  usageLimitTracker = step.tracker;
  if (!step.shouldAlert) return;
  logger.warn(
    { conversationId, platform: adapter.platform },
    'Upstream Claude usage-limit/overload detected',
  );
  for (const id of superAdminIds(adapter.platform)) {
    adapter
      .sendDirectMessage(
        id,
        '⚠️ The bot just hit an upstream Claude usage-limit/overload condition — members are seeing a ' +
          "degraded reply. This isn't a bug and should clear once the shared quota resets; consider " +
          'pause_bot if it persists.',
      )
      .catch((err) => logger.warn({ err, platform: adapter.platform, id }, 'Usage-limit alert DM failed'));
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
  const toolServer = buildToolServer(caller, adapter, getAdapter);

  // Text of the assistant message currently being streamed. Reset per
  // assistant message so tool-use narration from earlier turns never leaks
  // into the user-facing reply.
  let lastAssistantText = '';
  let resultText = '';
  let resultSubtype: string | undefined;
  let costUsd: number | undefined;
  let sessionId: string | undefined;

  try {
    for await (const message of query({
      prompt,
      options: buildQueryOptions(caller.role, systemPrompt, { community: toolServer }, resumeSession),
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
    noteUsageLimitOutcome(usageLimitHit, adapter, caller.conversationId);
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
    noteUsageLimitOutcome(false, adapter, caller.conversationId);
    // Never surface the raw internal transcript on failures.
    return {
      ok: false,
      // Non-success results (e.g. max turns) are turn failures, not resume
      // failures — those throw during init and are handled in the catch above.
      resumeFailed: false,
      text:
        resultSubtype === 'error_max_turns'
          ? MAX_TURNS_REPLY
          : 'Sorry — I could not complete that request. Please try again.',
      costUsd,
      sessionId,
      maxTurnsExceeded: resultSubtype === 'error_max_turns' ? true : undefined,
    };
  }

  noteUsageLimitOutcome(false, adapter, caller.conversationId);
  const text = resultText.trim() || lastAssistantText.trim() || "I don't have a response for that.";
  return { ok: true, resumeFailed: false, text, costUsd, sessionId };
}
