import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { toolsForRole, type CallerContext } from '../auth/rbac.js';
import type { PlatformAdapter } from '../platforms/types.js';
import {
  getClaudeSessionId,
  searchMemory,
  setClaudeSessionId,
} from '../storage/repository.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { buildToolServer } from './tools.js';

export interface AgentReply {
  text: string;
  costUsd?: number;
  sessionId?: string;
}

/**
 * Run one agent turn for an incoming message.
 *
 * Pipeline: recall relevant memory -> build a role-scoped system prompt and
 * tool surface -> resume the per-conversation Claude session -> stream the
 * result. Tool access is restricted by RBAC via `allowedTools`, so a normal
 * user's turn can never invoke a privileged tool.
 */
export async function runAgentTurn(
  caller: CallerContext,
  userText: string,
  adapter: PlatformAdapter,
): Promise<AgentReply> {
  const memories = await searchMemory(userText, {
    platform: caller.platform,
    conversationId: caller.conversationId,
  });

  const systemPrompt = buildSystemPrompt(caller, memories);
  const toolServer = buildToolServer(caller, adapter);
  const allowedTools = toolsForRole(caller.role);
  const priorSession = await getClaudeSessionId(caller.platform, caller.conversationId);

  let finalText = '';
  let costUsd: number | undefined;
  let sessionId: string | undefined;

  try {
    for await (const message of query({
      prompt: userText,
      options: {
        model: config.llm.model,
        systemPrompt,
        mcpServers: { community: toolServer },
        allowedTools,
        // Tools are pre-approved via allowedTools; deny everything else without prompting.
        permissionMode: 'default',
        maxTurns: config.llm.maxTurns,
        ...(priorSession ? { resume: priorSession } : {}),
        // Don't load the host machine's ~/.claude config into the agent.
        settingSources: [],
      },
    })) {
      switch (message.type) {
        case 'system':
          if (message.subtype === 'init') sessionId = message.session_id;
          break;
        case 'assistant': {
          // Accumulate text blocks from the assistant message.
          const content = (message as { message?: { content?: Array<{ type: string; text?: string }> } }).message
            ?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && block.text) finalText += block.text;
            }
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
          if ('result' in message && typeof message.result === 'string' && message.result.trim()) {
            finalText = message.result;
          }
          if (message.subtype && message.subtype !== 'success') {
            logger.warn({ subtype: message.subtype }, 'Agent turn ended non-success');
          }
          break;
        default:
          break;
      }
    }
  } catch (err) {
    logger.error({ err, conversationId: caller.conversationId }, 'Agent query failed');
    return { text: 'Sorry — I hit an internal error and could not complete that. Please try again.' };
  }

  if (sessionId) {
    await setClaudeSessionId(caller.platform, caller.conversationId, sessionId).catch((err) =>
      logger.warn({ err }, 'Failed to persist session id'),
    );
  }

  return {
    text: finalText.trim() || "I don't have a response for that.",
    costUsd,
    sessionId,
  };
}
