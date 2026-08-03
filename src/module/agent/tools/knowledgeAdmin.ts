import { z } from 'zod';
import type { Platform } from '@swampratnz/agent-base/platforms/types.js';
import { assertAtLeast } from '@swampratnz/agent-base/auth/tiers.js';
import { config } from '@swampratnz/agent-base/config.js';
import {
  acceptKnowledgeCandidate,
  declineKnowledgeCandidate,
  deleteKnowledge,
  getKnowledgeContentById,
  type KnowledgeCandidate,
  type KnowledgeDuplicateMatch,
  listAnswerFeedback,
  listDuplicateKnowledge,
  listKnowledge,
  listKnowledgeCandidates,
  listKnowledgeConflictCandidates,
  listKnowledgeFeedbackSummary,
  mergeKnowledgeEntries,
  recentKnowledgeGapClusters,
  recentUnhelpfulFeedbackClusters,
  saveKnowledge,
  updateKnowledge,
} from '@swampratnz/agent-base/storage/repository.js';
import { resolveSanitizedLabel, text, untrusted } from './helpers.js';
import { notifyKnowledgeTipResolved } from './notify.js';
import { defineTool } from '@swampratnz/agent-base/agent/tools/types.js';

export const knowledgeAdminTools = [
  defineTool({
    name: 'save_knowledge',
    description: 'Save a durable fact/FAQ/resource to community knowledge for future recall. Admin only.',
    minTier: 'admin',
    readOnlyHint: false,
    schema: {
      title: z.string().optional().describe('Short title'),
      content: z.string().describe('The knowledge content to remember'),
      scope: z.string().optional().describe("'global' (default), a platform, or a conversation id"),
      sourceUrl: z
        .string()
        .url()
        .optional()
        .describe(
          'Optional citation URL shown to members alongside this answer (e.g. the page it came from)',
        ),
      sourceTitle: z.string().optional().describe('Optional human-readable label for sourceUrl'),
    },
    handler: async (args, { caller }) => {
      assertAtLeast(caller.role, 'admin', 'save_knowledge');
      const { id, similarEntry } = await saveKnowledge({
        title: args.title,
        content: args.content,
        scope: args.scope,
        sourceUserId: caller.userId,
        createdByRole: caller.role,
        sourceUrl: args.sourceUrl,
        sourceTitle: args.sourceTitle,
        callerPlatform: caller.platform,
      });
      let reply = `Saved knowledge entry #${id}.`;
      if (similarEntry) {
        const pct = (similarEntry.similarity * 100).toFixed(0);
        const label = similarEntry.title ? `"${similarEntry.title}"` : similarEntry.content.slice(0, 80);
        reply += ` Note: this looks similar (${pct}%) to existing entry #${similarEntry.id} (${label}) — consider update_knowledge on #${similarEntry.id} instead if this is the same topic.`;
      }
      return text(reply);
    },
  }),

  defineTool({
    name: 'list_knowledge',
    description:
      'Browse curated community knowledge entries directly (not semantic search) — for finding an entry to correct or retire. Admin only.',
    minTier: 'admin',
    readOnlyHint: true,
    schema: {
      scope: z
        .string()
        .optional()
        .describe('Filter to a scope (e.g. "global", a platform, or a conversation id)'),
      limit: z.number().optional().describe('Max entries (default 20)'),
      offset: z.number().optional().describe('Pagination offset (default 0)'),
      staleOnly: z
        .boolean()
        .optional()
        .describe(
          'Only show entries untouched for KNOWLEDGE_STALE_DAYS+ days (the same entries counted in the ' +
            'weekly digest); ordered oldest-touched first.',
        ),
      provenance: z
        .enum(['admin', 'super_admin', 'auto', 'docs'])
        .optional()
        .describe(
          'Filter to entries created by this role/provenance (e.g. "auto" to review unreviewed ' +
            'web-researched entries)',
        ),
      sourceUnreachable: z
        .boolean()
        .optional()
        .describe(
          'Only show entries whose sourceUrl the weekly link-rot check flagged as unreachable ' +
            '(dead citation — re-verify or fix)',
        ),
    },
    handler: async (args, { caller }) => {
      assertAtLeast(caller.role, 'admin', 'list_knowledge');
      const staleDays = config.adminDigest.knowledgeStaleDays;
      const staleMaxAgeDays = config.adminDigest.knowledgeStaleMaxAgeDays;
      if (args.staleOnly && staleDays <= 0 && staleMaxAgeDays <= 0) {
        return text(
          'Staleness tracking is disabled (neither KNOWLEDGE_STALE_DAYS nor KNOWLEDGE_STALE_MAX_AGE_DAYS is set).',
        );
      }
      const entries = await listKnowledge({
        scope: args.scope,
        limit: args.limit,
        offset: args.offset,
        ...(args.staleOnly ? { staleOnly: true, staleDays, staleMaxAgeDays } : {}),
        ...(args.provenance ? { provenance: args.provenance } : {}),
        ...(args.sourceUnreachable ? { sourceUnreachable: true } : {}),
      });
      if (entries.length === 0) return text('No knowledge entries found.');
      return text(
        untrusted(
          'Knowledge entries',
          entries
            .map(
              (e) =>
                `#${e.id} [${e.scope}] [${e.createdByRole}] ${e.title ? `${e.title}: ` : ''}${e.content.slice(0, 200)} ` +
                `(updated ${e.updatedAt.toISOString()}, retrieved ${e.retrievalCount}x` +
                `${e.lastRetrievedAt ? `, last ${e.lastRetrievedAt.toISOString()}` : ''}` +
                `${e.sourceUrl ? `, source: ${e.sourceTitle ?? e.sourceUrl} (${e.sourceUrl})` : ''}` +
                `${e.verifiedAt ? `, verified ${e.verifiedAt.toISOString()}` : ''}` +
                `${e.sourceUnreachable ? `, ⚠️ source unreachable (checked ${e.sourceCheckedAt?.toISOString()})` : ''})`,
            )
            .join('\n'),
        ),
      );
    },
  }),

  // Retroactive read-only audit (issue #316) for near-duplicate pairs that
  // save_knowledge's write-time nudge never caught — same tier as its
  // siblings, no CONFIRM (read-only, no mutation).
  defineTool({
    name: 'list_duplicate_knowledge',
    description:
      'Audit the knowledge base for existing near-duplicate entry pairs (same scope, high embedding ' +
      'similarity) — the retroactive counterpart to the nudge save_knowledge shows at write time. Use ' +
      'this to find pairs to merge (update_knowledge) or retire (delete_knowledge). Admin only.',
    minTier: 'admin',
    readOnlyHint: true,
    schema: {
      scope: z.string().optional().describe('Restrict the audit to a single scope (e.g. "global")'),
      limit: z.number().optional().describe('Max pairs to return (default 20)'),
    },
    handler: async (args, { caller }) => {
      assertAtLeast(caller.role, 'admin', 'list_duplicate_knowledge');
      const pairs = await listDuplicateKnowledge(args.scope, args.limit);
      if (pairs.length === 0) return text('No near-duplicate knowledge pairs found.');
      return text(
        untrusted(
          'Near-duplicate knowledge pairs',
          pairs
            .map((p) => {
              const pct = (p.similarity * 100).toFixed(0);
              const aLabel = p.aTitle ? `"${p.aTitle}"` : `#${p.aId}`;
              const bLabel = p.bTitle ? `"${p.bTitle}"` : `#${p.bId}`;
              return `#${p.aId} (${aLabel}) ↔ #${p.bId} (${bLabel}) — ${pct}% similar`;
            })
            .join('\n'),
        ),
      );
    },
  }),

  // Sibling of list_duplicate_knowledge (issue #330): same tier/read-only/no-
  // CONFIRM shape, but the opposite similarity band — flags entries that may
  // quietly disagree (mid-range similarity) rather than converged wording.
  defineTool({
    name: 'list_knowledge_conflicts',
    description:
      'Audit the knowledge base for pairs of entries that are about the same topic but worded ' +
      'differently enough that they may disagree (same scope, mid-range embedding similarity — clears ' +
      "knowledge_search's relevance floor but sits well under the near-duplicate threshold). Sibling of " +
      'list_duplicate_knowledge, which catches the opposite case (converged wording). Each pair is a ' +
      'candidate for admin review, not a confirmed contradiction — check both entries and merge ' +
      '(update_knowledge) or retire (delete_knowledge) as appropriate. Admin only.',
    minTier: 'admin',
    readOnlyHint: true,
    schema: {
      scope: z.string().optional().describe('Restrict the audit to a single scope (e.g. "global")'),
      limit: z.number().optional().describe('Max pairs to return (default 20)'),
    },
    handler: async (args, { caller }) => {
      assertAtLeast(caller.role, 'admin', 'list_knowledge_conflicts');
      const pairs = await listKnowledgeConflictCandidates(args.scope, args.limit);
      if (pairs.length === 0) return text('No conflict-candidate knowledge pairs found.');
      return text(
        untrusted(
          'Conflict-candidate knowledge pairs — each is a candidate for admin review, not a confirmed contradiction',
          pairs
            .map((p) => {
              const pct = (p.similarity * 100).toFixed(0);
              const aLabel = p.aTitle ? `"${p.aTitle}"` : `#${p.aId}`;
              const bLabel = p.bTitle ? `"${p.bTitle}"` : `#${p.bId}`;
              return `#${p.aId} (${aLabel}) ↔ #${p.bId} (${bLabel}) — ${pct}% similar`;
            })
            .join('\n'),
        ),
      );
    },
  }),

  defineTool({
    name: 'update_knowledge',
    description:
      'Correct an existing knowledge entry (title/content/scope/source). Re-embeds the content. Setting ' +
      'sourceUrl or sourceTitle re-verifies the citation (bumps verified_at to now). Requires ' +
      'confirmation (the edit overwrites trusted, member-facing content in place). Admin only.',
    minTier: 'admin',
    readOnlyHint: false,
    schema: {
      id: z.number().describe('Knowledge entry id (from list_knowledge or knowledge_search)'),
      title: z.string().optional().describe('New title; omit to leave unchanged'),
      content: z.string().optional().describe('New content; omit to leave unchanged'),
      scope: z.string().optional().describe('New scope; omit to leave unchanged'),
      sourceUrl: z
        .string()
        .url()
        .optional()
        .describe('New citation URL; omit to leave unchanged. Setting it re-verifies the citation.'),
      sourceTitle: z
        .string()
        .optional()
        .describe('New human-readable label for sourceUrl; omit to leave unchanged'),
    },
    handler: async (args, { caller, requireConfirm, audited }) => {
      assertAtLeast(caller.role, 'admin', 'update_knowledge');
      // CONFIRM-gated like delete_knowledge: an in-place overwrite of a
      // knowledge entry is destructive to trusted content that's served
      // verbatim to every tier (including via the zero-token shortcut), so an
      // injected admin turn could otherwise silently replace the curated KB.
      // The gate means an injection can request but never complete the edit.
      return requireConfirm(`update knowledge entry #${args.id}`, 'admin', async () => {
        // Capture the pre-edit text so the audit row records what was replaced
        // (in-place UPDATE keeps no history) — recoverability if a bad/hostile
        // edit slips through.
        const prior = await getKnowledgeContentById(args.id);
        const state: { similarEntry?: KnowledgeDuplicateMatch } = {};
        const { success, result } = await audited({
          actionKind: 'update_knowledge',
          params: {
            id: args.id,
            title: args.title,
            content: args.content,
            scope: args.scope,
            sourceUrl: args.sourceUrl,
            sourceTitle: args.sourceTitle,
            priorTitle: prior?.title,
            priorContent: prior?.content,
          },
          run: async () => {
            const outcome = await updateKnowledge({
              id: args.id,
              title: args.title,
              content: args.content,
              scope: args.scope,
              sourceUrl: args.sourceUrl,
              sourceTitle: args.sourceTitle,
              callerPlatform: caller.platform,
            });
            if (!outcome.updated) throw new Error(`No knowledge entry with id ${args.id}.`);
            state.similarEntry = outcome.similarEntry;
            return 'updated';
          },
        });
        if (!success) return `Failed: ${result}`;
        let reply = `Updated knowledge entry #${args.id}.`;
        if (state.similarEntry) {
          const { similarEntry } = state;
          const pct = (similarEntry.similarity * 100).toFixed(0);
          const label = similarEntry.title ? `"${similarEntry.title}"` : similarEntry.content.slice(0, 80);
          reply += ` Note: this looks similar (${pct}%) to existing entry #${similarEntry.id} (${label}) — consider update_knowledge on #${similarEntry.id} instead if this is the same topic.`;
        }
        return reply;
      });
    },
  }),

  defineTool({
    name: 'delete_knowledge',
    description:
      'Retire (permanently delete) a knowledge entry that is no longer accurate. Requires confirmation. Admin only.',
    minTier: 'admin',
    readOnlyHint: false,
    schema: { id: z.number().describe('Knowledge entry id (from list_knowledge or knowledge_search)') },
    handler: async (args, { caller, requireConfirm, audited }) => {
      assertAtLeast(caller.role, 'admin', 'delete_knowledge');
      return requireConfirm(`delete knowledge entry #${args.id}`, 'admin', async () => {
        const { success, result } = await audited({
          actionKind: 'delete_knowledge',
          params: { id: args.id },
          run: async () => {
            const deleted = await deleteKnowledge(args.id);
            if (!deleted) throw new Error(`No knowledge entry with id ${args.id}.`);
            return 'deleted';
          },
        });
        return success ? `Deleted knowledge entry #${args.id}.` : `Failed: ${result}`;
      });
    },
  }),

  // Consolidates a detected duplicate/conflict pair into one entry (issue
  // #886) — same admin-tier + CONFIRM + audited shape as update_knowledge/
  // delete_knowledge, the two write tools it replaces the unlinked manual
  // two-call workaround with.
  defineTool({
    name: 'merge_knowledge',
    description:
      "Consolidate a detected duplicate/conflict pair into one entry: keeps `keepId`, folds `mergeId`'s " +
      'retrieval_count/last_retrieved_at history onto it, then deletes `mergeId`. Optional title/content/scope ' +
      "override the survivor's content (and re-embed it) exactly like update_knowledge; omit them to leave " +
      "keepId's existing wording untouched. Use this after list_duplicate_knowledge or list_knowledge_conflicts " +
      'to act on a pair instead of a manual update_knowledge + delete_knowledge. Requires confirmation. Admin only.',
    minTier: 'admin',
    readOnlyHint: false,
    schema: {
      keepId: z.number().describe('Knowledge entry id to keep (the survivor)'),
      mergeId: z.number().describe('Knowledge entry id to merge into keepId and delete'),
      title: z
        .string()
        .optional()
        .describe("New title for the survivor; omit to leave keepId's title unchanged"),
      content: z
        .string()
        .optional()
        .describe("New content for the survivor; omit to leave keepId's content unchanged"),
      scope: z
        .string()
        .optional()
        .describe("New scope for the survivor; omit to leave keepId's scope unchanged"),
    },
    handler: async (args, { caller, requireConfirm, audited }) => {
      assertAtLeast(caller.role, 'admin', 'merge_knowledge');
      return requireConfirm(
        `merge knowledge entry #${args.mergeId} into #${args.keepId}`,
        'admin',
        async () => {
          // Pre-merge text of the entry being deleted, same recoverability
          // precedent as update_knowledge's `prior` capture — a merge deletes
          // mergeId, so this is the only record of what it contained.
          const prior = await getKnowledgeContentById(args.mergeId);
          const { success, result } = await audited({
            actionKind: 'merge_knowledge',
            params: {
              keepId: args.keepId,
              mergeId: args.mergeId,
              title: args.title,
              content: args.content,
              scope: args.scope,
              mergedTitle: prior?.title,
              mergedContent: prior?.content,
            },
            run: async () => {
              const outcome = await mergeKnowledgeEntries(args.keepId, args.mergeId, {
                title: args.title,
                content: args.content,
                scope: args.scope,
              });
              if (!outcome.merged) throw new Error(outcome.error ?? 'Merge failed.');
              return 'merged';
            },
          });
          return success
            ? `Merged knowledge entry #${args.mergeId} into #${args.keepId}.`
            : `Failed: ${result}`;
        },
      );
    },
  }),

  defineTool({
    name: 'list_knowledge_candidates',
    description:
      'Browse the knowledge-candidate review queue: Q&A drafts the offline context builder proposed from ' +
      'recurring, answerable questions in community chat (behind CONTEXT_CANDIDATES_ENABLED). Nothing here ' +
      'is visible to members — review each with accept_knowledge_candidate or decline_knowledge_candidate. ' +
      'Admin only.',
    minTier: 'admin',
    readOnlyHint: true,
    schema: {
      status: z
        .enum(['pending', 'accepted', 'declined', 'withdrawn'])
        .optional()
        .describe('Filter by status (default: all statuses)'),
      limit: z.number().optional().describe('Max entries (default 50, max 200)'),
      oldestFirst: z
        .boolean()
        .optional()
        .describe(
          'Order by created_at ascending (oldest-drafted first) instead of the default newest-first — ' +
            'use this to find candidates that have sat unreviewed the longest.',
        ),
    },
    handler: async (args, { caller }) => {
      assertAtLeast(caller.role, 'admin', 'list_knowledge_candidates');
      const rows = await listKnowledgeCandidates(args.status, args.limit ?? 50, args.oldestFirst ?? false);
      if (rows.length === 0) return text('No knowledge candidates found.');
      const lines = await Promise.all(
        rows.map(async (c) => {
          // SECURITY: a member-sourced tip's own title/content is untrusted
          // text this handler renders alongside the `[member-suggested by
          // ...]` provenance tag it adds itself — strip square brackets so
          // crafted title/content can't forge a fake tag (angle brackets/
          // newlines are already stripped by the surrounding untrusted()
          // wrapper below). Applied uniformly, not just to member-sourced
          // rows, since a machine-drafted candidate's text is untrusted too.
          const safeTitle = c.title.replace(/[[\]]/g, ' ');
          const safeContent = c.content.replace(/[[\]]/g, ' ');
          const safeTopic = c.topic.replace(/[[\]]/g, ' ');
          let provenance = '';
          if (c.sourcePlatform && c.sourceUserId) {
            const name = await resolveSanitizedLabel(c.sourcePlatform, c.sourceUserId);
            provenance = ` [member-suggested by ${name}]`;
          }
          return (
            `#${c.id} [${c.status}]${provenance} ${safeTitle}: ${safeContent} ` +
            `(topic: ${safeTopic}, drafted ${c.createdAt.toISOString()}` +
            `${c.digestId ? `, digest #${c.digestId}` : ''})`
          );
        }),
      );
      return text(untrusted('Knowledge candidates', lines.join('\n')));
    },
  }),

  defineTool({
    name: 'accept_knowledge_candidate',
    description:
      "Accept a pending knowledge candidate, publishing it as a durable knowledge entry via save_knowledge's " +
      'own path (so the near-duplicate nudge applies). Optional title/content override lets you fix wording ' +
      'at accept time without a separate update_knowledge call. Optional sourceUrl/sourceTitle attach a ' +
      'citation shown to members alongside the answer. Audited. Admin only.',
    minTier: 'admin',
    readOnlyHint: false,
    schema: {
      id: z.number().describe('Candidate id (from list_knowledge_candidates)'),
      title: z.string().optional().describe('Override title; omit to publish the drafted title as-is'),
      content: z.string().optional().describe('Override content; omit to publish the drafted content as-is'),
      sourceUrl: z.string().url().optional().describe('Optional citation URL shown to members'),
      sourceTitle: z.string().optional().describe('Optional human-readable label for sourceUrl'),
    },
    handler: async (args, { caller, audited, adapterFor }) => {
      assertAtLeast(caller.role, 'admin', 'accept_knowledge_candidate');
      const state: {
        outcome: {
          knowledgeId: number;
          similarEntry?: KnowledgeDuplicateMatch;
          title: string;
          sourcePlatform: Platform | null;
          sourceUserId: string | null;
        } | null;
      } = { outcome: null };
      const { success, result } = await audited({
        actionKind: 'accept_knowledge_candidate',
        params: {
          id: args.id,
          title: args.title,
          content: args.content,
          sourceUrl: args.sourceUrl,
          sourceTitle: args.sourceTitle,
        },
        run: async () => {
          const outcome = await acceptKnowledgeCandidate({
            id: args.id,
            title: args.title,
            content: args.content,
            reviewedBy: caller.userId,
            sourceUrl: args.sourceUrl,
            sourceTitle: args.sourceTitle,
          });
          if (!outcome) throw new Error(`No pending knowledge candidate with id ${args.id}.`);
          state.outcome = outcome;
          return `published as knowledge #${outcome.knowledgeId}`;
        },
      });
      if (!success || !state.outcome) return text(`Failed: ${result}`, true);
      // Cross-platform resolution DM (issue #703, mirroring resolve_appeal's
      // #622 mechanism): only fires for a member-submitted tip (non-null
      // sourceUserId — a machine-drafted candidate has no member to notify),
      // routed via the tip's ORIGIN platform, never the resolving admin's own.
      // The target is always state.outcome's own sourcePlatform/sourceUserId —
      // never any accept_knowledge_candidate argument — so no caller-supplied
      // value can redirect it.
      if (state.outcome.sourceUserId && state.outcome.sourcePlatform) {
        const target = adapterFor(state.outcome.sourcePlatform);
        if (target)
          await notifyKnowledgeTipResolved(
            target,
            state.outcome.sourceUserId,
            'accepted',
            state.outcome.title,
            state.outcome.sourcePlatform,
          );
      }
      let reply = `Accepted candidate #${args.id} — saved as knowledge entry #${state.outcome.knowledgeId}.`;
      if (state.outcome.similarEntry) {
        const { similarEntry } = state.outcome;
        const pct = (similarEntry.similarity * 100).toFixed(0);
        const label = similarEntry.title ? `"${similarEntry.title}"` : similarEntry.content.slice(0, 80);
        reply += ` Note: this looks similar (${pct}%) to existing entry #${similarEntry.id} (${label}) — consider update_knowledge on #${similarEntry.id} instead if this is the same topic.`;
      }
      return text(reply);
    },
  }),

  defineTool({
    name: 'decline_knowledge_candidate',
    description:
      'Decline a pending knowledge candidate — retained as declined (never published, and the builder will ' +
      'not re-propose the same topic) rather than deleted. Non-destructive status change (no CONFIRM ' +
      'needed), audited. Admin only.',
    minTier: 'admin',
    readOnlyHint: false,
    schema: { id: z.number().describe('Candidate id (from list_knowledge_candidates)') },
    handler: async (args, { caller, audited, adapterFor }) => {
      assertAtLeast(caller.role, 'admin', 'decline_knowledge_candidate');
      const state: { row: KnowledgeCandidate | null } = { row: null };
      const { success, result } = await audited({
        actionKind: 'decline_knowledge_candidate',
        params: { id: args.id },
        run: async () => {
          const declined = await declineKnowledgeCandidate(args.id, caller.userId);
          if (!declined) throw new Error(`No pending knowledge candidate with id ${args.id}.`);
          state.row = declined;
          return 'declined';
        },
      });
      // See the matching comment on accept_knowledge_candidate above — same
      // provenance-gated, origin-platform-routed DM, never caller-redirectable.
      if (success && state.row?.sourceUserId && state.row.sourcePlatform) {
        const target = adapterFor(state.row.sourcePlatform);
        if (target)
          await notifyKnowledgeTipResolved(
            target,
            state.row.sourceUserId,
            'declined',
            state.row.title,
            state.row.sourcePlatform,
          );
      }
      return text(success ? `Declined candidate #${args.id}.` : `Failed: ${result}`, !success);
    },
  }),

  defineTool({
    name: 'list_knowledge_gaps',
    description:
      'Show searches (asked >= 2 times) in your conversations over recent days that found no confident answer — ' +
      'the miss-specific complement to question_digest, a signal for what should become a knowledge entry. ' +
      "Entries are searches with no confident answer, not necessarily members' verbatim questions. Admin only.",
    minTier: 'admin',
    readOnlyHint: true,
    schema: {
      days: z.number().optional().describe('Window in days (default 7, max 30)'),
      limit: z.number().optional().describe('Max clusters to return (default 10)'),
    },
    handler: async (args, { caller, callerScope }) => {
      assertAtLeast(caller.role, 'admin', 'list_knowledge_gaps');
      const allowed = await callerScope();
      const clusters = await recentKnowledgeGapClusters(allowed, args.days ?? 7, args.limit ?? 10);
      if (clusters.length === 0)
        return text('No recurring knowledge-search misses in that window (within your conversations).');
      return text(
        untrusted(
          'Knowledge-search misses',
          clusters.map((c, i) => `${i + 1}. (${c.count}x) ${c.representative.slice(0, 300)}`).join('\n'),
        ),
      );
    },
  }),

  defineTool({
    name: 'list_answer_feedback',
    description:
      "List member ratings (helpful/unhelpful) of the bot's answers from your conversations. Where shown, " +
      "'served from knowledge #N' is a best-effort correlation with the knowledge_search hit that most " +
      "recently cleared the relevance floor in that turn — not a guarantee the model's answer actually drew " +
      'from that entry. A rating from a conversation you do not participate in is not visible here even to ' +
      'admins — only to a super admin. Admin only.',
    minTier: 'admin',
    readOnlyHint: true,
    schema: {
      unhelpfulOnly: z.boolean().optional().describe('Only show unhelpful (thumbs-down) ratings'),
      limit: z.number().optional().describe('Max entries (default 50)'),
    },
    handler: async (args, { caller, callerScope }) => {
      assertAtLeast(caller.role, 'admin', 'list_answer_feedback');
      const allowed = await callerScope();
      const rows = await listAnswerFeedback(allowed, args.unhelpfulOnly ?? false, args.limit ?? 50);
      if (rows.length === 0) return text('No answer feedback found (within your conversations).');
      return text(
        rows
          .map((r) => {
            const knowledgeNote =
              r.knowledgeEntryId != null ? `, served from knowledge #${r.knowledgeEntryId}` : '';
            const answerText = r.content != null ? `\n  ${untrusted('answer', r.content)}` : '';
            const commentText = r.comment != null ? `\n  ${untrusted('comment', r.comment)}` : '';
            return (
              `#${r.id} [${r.helpful ? 'helpful' : 'unhelpful'}] ${r.platform} ${r.conversationId} — ` +
              `from ${r.userId}${r.interactionId ? `, answer #${r.interactionId}` : ' (rated answer since purged)'}` +
              `${knowledgeNote} (${r.createdAt.toISOString()})${answerText}${commentText}`
            );
          })
          .join('\n'),
      );
    },
  }),

  defineTool({
    name: 'list_low_rated_knowledge',
    description:
      'Show knowledge entries with accumulated unhelpful ratings (>= minUnhelpful) — grouped by entry so you ' +
      "can spot a bad or stale FAQ answer without scanning list_answer_feedback's raw per-rating list. " +
      'Covers answers served via the deterministic knowledge shortcut (exact match) AND, best-effort, the ' +
      'normal model-mediated knowledge_search path: the entry attributed there is a correlation with the ' +
      'most recent knowledge_search hit that cleared the relevance floor in that turn, not a guarantee the ' +
      "model's reply actually drew from it — treat a flagged entry as a lead to check, not certain proof. " +
      'Ratings on interactions with no knowledgeEntryId at all are still excluded. A rating from a ' +
      'conversation you do not participate in is not counted here even for admins — only for a super admin. ' +
      'When present, includes the most recent member comment left on an unhelpful rating for that entry, ' +
      'so you see why without switching to list_answer_feedback. Admin only.',
    minTier: 'admin',
    readOnlyHint: true,
    schema: {
      minUnhelpful: z
        .number()
        .optional()
        .describe('Minimum unhelpful ratings for an entry to be shown (default 2)'),
      limit: z.number().optional().describe('Max entries (default 20)'),
    },
    handler: async (args, { caller, callerScope }) => {
      assertAtLeast(caller.role, 'admin', 'list_low_rated_knowledge');
      const allowed = await callerScope();
      const rows = await listKnowledgeFeedbackSummary(allowed, args.minUnhelpful ?? 2, args.limit ?? 20);
      if (rows.length === 0)
        return text('No knowledge entries meet that unhelpful-rating threshold (within your conversations).');
      return text(
        untrusted(
          'Low-rated knowledge entries',
          rows
            .map((r) => {
              const commentNote = r.sampleComment ? `\n  ${untrusted('comment', r.sampleComment)}` : '';
              return (
                `#${r.knowledgeEntryId}${r.title ? ` "${r.title}"` : ''} — ${r.helpfulCount} helpful, ` +
                `${r.unhelpfulCount} unhelpful (updated ${r.updatedAt.toISOString()})${commentNote}`
              );
            })
            .join('\n'),
        ),
      );
    },
  }),

  // Clusters unhelpful-rating comments across BOTH grounded and ungrounded
  // answers by embedding similarity (issue #724) — the cross-cutting
  // complement list_low_rated_knowledge (per-entry, grounded-only) doesn't
  // provide, instrumenting the second half of VISION's answer-quality
  // north star.
  defineTool({
    name: 'list_unhelpful_themes',
    description:
      'Show recurring themes (count >= 2) across unhelpful (thumbs-down) answer ratings that carry a member ' +
      'comment, clustered by similarity — the cross-cutting complement to list_low_rated_knowledge (which is ' +
      "per-entry and excludes ungrounded answers) and list_answer_feedback's raw per-rating list. Covers BOTH " +
      "knowledge-grounded and ungrounded answers. A comment from a conversation you don't participate in is not " +
      'counted here even for admins — only for a super admin. Admin only.',
    minTier: 'admin',
    readOnlyHint: true,
    schema: {
      days: z.number().optional().describe('Window in days (default 7, max 30)'),
      limit: z.number().optional().describe('Max themes to return (default 10)'),
    },
    handler: async (args, { caller, callerScope }) => {
      assertAtLeast(caller.role, 'admin', 'list_unhelpful_themes');
      const allowed = await callerScope();
      const clusters = await recentUnhelpfulFeedbackClusters(allowed, args.days ?? 7, args.limit ?? 10);
      if (clusters.length === 0)
        return text('No recurring unhelpful-answer themes in that window (within your conversations).');
      return text(
        untrusted(
          'Recurring unhelpful-answer themes',
          clusters.map((c, i) => `${i + 1}. (${c.count}x) ${c.representative.slice(0, 300)}`).join('\n'),
        ),
      );
    },
  }),
];
