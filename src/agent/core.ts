import { query, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { atLeast, toolsForRole, type CallerContext } from '../auth/rbac.js';
import type { PlatformAdapter } from '../platforms/types.js';
import {
  clearClaudeSessionId,
  getClaudeSession,
  searchMemory,
  setClaudeSessionId,
} from '../storage/repository.js';
import { getCodeAnswersPolicy } from '../storage/policies.js';
import { buildSystemPrompt, renderMemoryContext } from './systemPrompt.js';
import { buildToolServer } from './tools.js';

export interface AgentReply {
  text: string;
  costUsd?: number;
  sessionId?: string;
}

interface TurnOutcome {
  ok: boolean;
  resumeFailed: boolean;
  text: string;
  costUsd?: number;
  sessionId?: string;
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
    tools: (webSearch ? ['WebSearch'] : []) as string[],
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
): Promise<AgentReply> {
  // Memory recall is scoped to THIS conversation only. Cross-conversation
  // recall is available solely through the admin-gated tools, so a public
  // channel can never surface someone else's DMs.
  const memories = await searchMemory(userText, {
    platform: caller.platform,
    conversationId: caller.conversationId,
  });

  const codeAnswers = await getCodeAnswersPolicy();
  const systemPrompt = buildSystemPrompt(caller, { codeAnswers });
  // Recalled messages are untrusted user content: they ride in the user turn
  // inside a clearly delimited block, never in the system prompt.
  const prompt =
    memories.length > 0
      ? `${renderMemoryContext(memories)}\n\n${userText}`
      : userText;

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

  const first = await execTurn(caller, prompt, systemPrompt, adapter, priorSession);
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
    outcome = await execTurn(caller, prompt, systemPrompt, adapter, null);
  }

  if (outcome.sessionId) {
    await setClaudeSessionId(caller.platform, caller.conversationId, outcome.sessionId).catch(
      (err) => logger.warn({ err }, 'Failed to persist session id'),
    );
  }

  return {
    text: outcome.text,
    costUsd: outcome.costUsd,
    sessionId: outcome.sessionId,
  };
}

async function execTurn(
  caller: CallerContext,
  prompt: string,
  systemPrompt: string,
  adapter: PlatformAdapter,
  resumeSession: string | null,
): Promise<TurnOutcome> {
  const toolServer = buildToolServer(caller, adapter);

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
    return {
      ok: false,
      // Heuristic: resume failures surface as errors mentioning the session.
      resumeFailed: resumeSession != null && /session|resume/i.test(msg),
      text: 'Sorry — I hit an internal error and could not complete that. Please try again.',
    };
  }

  if (resultSubtype && resultSubtype !== 'success') {
    logger.warn({ subtype: resultSubtype, conversationId: caller.conversationId }, 'Agent turn ended non-success');
    // Never surface the raw internal transcript on failures.
    return {
      ok: false,
      // Non-success results (e.g. max turns) are turn failures, not resume
      // failures — those throw during init and are handled in the catch above.
      resumeFailed: false,
      text:
        resultSubtype === 'error_max_turns'
          ? 'Sorry — that took more steps than I allow per message. Try breaking it into smaller questions.'
          : 'Sorry — I could not complete that request. Please try again.',
      costUsd,
      sessionId,
    };
  }

  const text = (resultText.trim() || lastAssistantText.trim()) || "I don't have a response for that.";
  return { ok: true, resumeFailed: false, text, costUsd, sessionId };
}
