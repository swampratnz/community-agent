import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { PlatformAdapter } from '../platforms/types.js';
import { assertAdmin, type CallerContext } from '../auth/rbac.js';
import { logger } from '../logger.js';
import {
  recordAdminAction,
  saveKnowledge,
  searchKnowledge,
  searchMemory,
} from '../storage/repository.js';
import { pool } from '../storage/db.js';

/** Helper: wrap a string into the MCP tool result shape. */
function text(t: string, isError = false) {
  return { content: [{ type: 'text' as const, text: t }], isError };
}

/**
 * Build the in-process MCP tool server for one agent turn. The tools close
 * over the caller context and the adapter handling this conversation, so
 * RBAC and platform routing are baked in. The set of tools the model may
 * actually call is further restricted by `allowedTools` (see rbac.toolsForRole).
 */
export function buildToolServer(caller: CallerContext, adapter: PlatformAdapter) {
  // --- Informational tools (all roles) -------------------------------------

  const rememberSearch = tool(
    'remember_search',
    'Search past interactions in this community for relevant context. Use this before answering questions that may have come up before.',
    {
      query: z.string().describe('What to search for in past conversations'),
      thisConversationOnly: z
        .boolean()
        .optional()
        .describe('If true, only search the current conversation'),
    },
    async (args) => {
      const hits = await searchMemory(args.query, {
        platform: caller.platform,
        conversationId: args.thisConversationOnly ? caller.conversationId : undefined,
      });
      if (hits.length === 0) return text('No relevant past interactions found.');
      return text(
        hits
          .map(
            (h, i) =>
              `${i + 1}. (${(h.similarity * 100).toFixed(0)}% match) [${h.direction}${h.userName ? ` by ${h.userName}` : ''}] ${h.content.slice(0, 400)}`,
          )
          .join('\n'),
      );
    },
  );

  const knowledgeSearch = tool(
    'knowledge_search',
    'Search curated community knowledge (FAQs, rules, resources admins have saved).',
    { query: z.string().describe('Topic to look up') },
    async (args) => {
      const hits = await searchKnowledge(args.query);
      if (hits.length === 0) return text('No matching knowledge entries.');
      return text(hits.map((h) => `- ${h.title ? `${h.title}: ` : ''}${h.content}`).join('\n'));
    },
  );

  const communityInfo = tool(
    'community_info',
    'Get high-level facts about the NZ Claude community and how the bot can help.',
    {},
    async () =>
      text(
        'NZ Claude Community — a New Zealand group building with Claude and the Anthropic API. ' +
          'The bot answers questions, searches past discussions, and (for admins) helps moderate and make announcements.',
      ),
  );

  // --- Privileged tools (admin only) ---------------------------------------

  const moderate = tool(
    'moderate',
    'Perform a moderation action (e.g. timeout, kick, delete a message). Admin only.',
    {
      action: z
        .enum(['timeout_user', 'kick_user', 'delete_message', 'warn_user'])
        .describe('The moderation action to perform'),
      targetUserId: z.string().describe('Platform user id to act on'),
      reason: z.string().describe('Reason, for the audit log and the affected user'),
      durationMinutes: z
        .number()
        .optional()
        .describe('For timeouts: duration in minutes'),
      conversationId: z
        .string()
        .optional()
        .describe('Conversation/channel id if the action is scoped to one'),
    },
    async (args) => {
      assertAdmin(caller.role, `moderate:${args.action}`);
      if (!adapter.adminCapabilities.has(args.action)) {
        return text(`This platform (${adapter.platform}) does not support "${args.action}".`, true);
      }
      let result: string;
      let success = false;
      try {
        result = await adapter.performAdminAction({
          kind: args.action,
          targetUserId: args.targetUserId,
          conversationId: args.conversationId ?? caller.conversationId,
          params: { reason: args.reason, durationMinutes: args.durationMinutes },
        });
        success = true;
      } catch (err) {
        result = err instanceof Error ? err.message : String(err);
      }
      await recordAdminAction({
        platform: caller.platform,
        actorUserId: caller.userId,
        actorName: caller.userName,
        actionKind: args.action,
        targetUserId: args.targetUserId,
        conversationId: args.conversationId ?? caller.conversationId,
        params: { reason: args.reason, durationMinutes: args.durationMinutes },
        result,
        success,
      });
      logger.info({ action: args.action, success, actor: caller.userId }, 'Moderation action');
      return text(success ? `Done: ${result}` : `Failed: ${result}`, !success);
    },
  );

  const announce = tool(
    'announce',
    'Post an announcement message to a conversation/channel. Admin only.',
    {
      message: z.string().describe('The announcement text'),
      conversationId: z
        .string()
        .optional()
        .describe('Target channel/conversation id; defaults to the current one'),
    },
    async (args) => {
      assertAdmin(caller.role, 'announce');
      const target = args.conversationId ?? caller.conversationId;
      let success = false;
      let result = 'sent';
      try {
        await adapter.sendMessage({ conversationId: target, text: args.message });
        success = true;
      } catch (err) {
        result = err instanceof Error ? err.message : String(err);
      }
      await recordAdminAction({
        platform: caller.platform,
        actorUserId: caller.userId,
        actorName: caller.userName,
        actionKind: 'announce',
        conversationId: target,
        params: { message: args.message },
        result,
        success,
      });
      return text(success ? `Announcement posted to ${target}.` : `Failed: ${result}`, !success);
    },
  );

  const saveKnowledgeTool = tool(
    'save_knowledge',
    'Save a durable fact/FAQ/resource to community knowledge for future recall. Admin only.',
    {
      title: z.string().optional().describe('Short title'),
      content: z.string().describe('The knowledge content to remember'),
      scope: z.string().optional().describe("'global' (default), a platform, or a conversation id"),
    },
    async (args) => {
      assertAdmin(caller.role, 'save_knowledge');
      const id = await saveKnowledge({
        title: args.title,
        content: args.content,
        scope: args.scope,
        sourceUserId: caller.userId,
        createdByRole: 'admin',
      });
      return text(`Saved knowledge entry #${id}.`);
    },
  );

  const userHistory = tool(
    'user_history',
    'Look up recent message history for a specific user (for moderation decisions). Admin only.',
    {
      userId: z.string().describe('Platform user id to inspect'),
      limit: z.number().optional().describe('Max messages (default 20)'),
    },
    async (args) => {
      assertAdmin(caller.role, 'user_history');
      const { rows } = await pool.query(
        `SELECT user_name, direction, content, created_at
           FROM interactions
          WHERE platform = $1 AND user_id = $2
          ORDER BY created_at DESC
          LIMIT $3`,
        [caller.platform, args.userId, args.limit ?? 20],
      );
      if (rows.length === 0) return text('No history for that user.');
      return text(
        rows
          .map((r) => `[${new Date(r.created_at).toISOString()}] ${r.direction}: ${r.content.slice(0, 200)}`)
          .join('\n'),
      );
    },
  );

  return createSdkMcpServer({
    name: 'community',
    version: '1.0.0',
    tools: [
      rememberSearch,
      knowledgeSearch,
      communityInfo,
      moderate,
      announce,
      saveKnowledgeTool,
      userHistory,
    ],
  });
}
