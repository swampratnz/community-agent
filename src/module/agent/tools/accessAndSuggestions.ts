import { z } from 'zod';
import type { Platform } from '@swampratnz/agent-base/platforms/types.js';
import { assertAtLeast } from '@swampratnz/agent-base/auth/tiers.js';
import { logger } from '@swampratnz/agent-base/logger.js';
import { sanitizeName } from '@swampratnz/agent-base/util/sanitizeName.js';
import {
  clearAccessRequest,
  listAccessRequests,
  listSuggestions,
  resolveSuggestion,
} from '@swampratnz/agent-base/storage/repository.js';
import { ACCESS_REQUEST_STALE_ALERT_SCAN_LIMIT } from '../../accessRequestStaleAlert.js';
import { recordAccessRequestResolution } from '../../storage/accessRequestResolutions.js';
import { getWithdrawnSuggestionIds } from '../../storage/suggestionWithdrawals.js';
import { platformArg, SUGGESTION_RESOLUTION_ECHO_CHARS, text, untrusted } from './helpers.js';
import { notifyAccessRequestDeclined, notifySuggestionResolved } from './notify.js';
import { defineTool } from '@swampratnz/agent-base/agent/tools/types.js';

export const accessAndSuggestionsTools = [
  defineTool({
    name: 'list_access_requests',
    description:
      'List gated guests who have asked the bot for access — identity and request count only, never ' +
      'message content. Resolve a row with add_member (grants access) or decline_access_request (clears ' +
      'it without granting anything). Admin only.',
    minTier: 'admin',
    readOnlyHint: true,
    schema: { limit: z.number().optional().describe('Max entries (default 50)') },
    handler: async (args, { caller }) => {
      assertAtLeast(caller.role, 'admin', 'list_access_requests');
      const rows = await listAccessRequests(args.limit ?? 50);
      if (rows.length === 0) return text('No pending access requests.');
      return text(
        untrusted(
          'Access requests',
          rows
            .map((r) => {
              // firstRequestedAt is always the DB-stored insert timestamp for
              // this (platform, user_id) row (repository.ts's
              // listAccessRequests) — never sourced from a tool argument, so
              // it can't be spoofed by a caller-supplied value (issue #515).
              const waitingDays = Math.floor((Date.now() - r.firstRequestedAt.getTime()) / 86_400_000);
              return (
                `${r.platform} ${r.userName ? sanitizeName(r.userName) : r.userId} (${r.userId}) — ` +
                `${r.requestCount} request(s), first ${r.firstRequestedAt.toISOString()} (waiting ${waitingDays}d), ` +
                `last ${r.lastRequestedAt.toISOString()}`
              );
            })
            .join('\n'),
        ),
      );
    },
  }),

  defineTool({
    name: 'decline_access_request',
    description:
      'Clear a pending access request without granting membership — the resolution path for a request an ' +
      'admin does not want to approve (spam, a throwaway, no longer relevant). Confers no tier and no data ' +
      'access; the requester loses nothing they had. Non-destructive (no CONFIRM needed) and instantly ' +
      'reversible in the practical sense: a fresh request from the same identity simply re-queues. Fires a ' +
      'best-effort DM to the requester letting them know they were declined. Audited. Admin only.',
    minTier: 'admin',
    readOnlyHint: false,
    schema: {
      userId: z.string().min(1).describe('Platform user id of the pending requester'),
      platform: platformArg,
      reason: z
        .string()
        .max(SUGGESTION_RESOLUTION_ECHO_CHARS)
        .optional()
        .describe(
          'Optional, one-line, member-facing explanation appended verbatim to the decline DM sent to the ' +
            'requester, so they know why — omit for the existing neutral decline message with no reason. ' +
            'Never persisted.',
        ),
    },
    handler: async (args, { caller, audited, resolveMemberTarget, adapterFor }) => {
      assertAtLeast(caller.role, 'admin', 'decline_access_request');
      const { platform, userId } = await resolveMemberTarget(args.userId, args.platform);
      // Looked up BEFORE clearAccessRequest — the row is gone after (issue
      // #1239). No match means no resolution event to log below.
      const pendingRequest = (await listAccessRequests(ACCESS_REQUEST_STALE_ALERT_SCAN_LIMIT)).find(
        (r) => r.platform === platform && r.userId === userId,
      );
      const { success, result } = await audited({
        actionKind: 'decline_access_request',
        targetUserId: userId,
        params: { platform },
        run: async () => {
          const cleared = await clearAccessRequest(platform, userId);
          if (!cleared) throw new Error(`No pending access request from ${userId} on ${platform}.`);
          return 'declined';
        },
      });
      if (success && pendingRequest) {
        // Best-effort — the metric write must never be able to fail or block
        // this tool's own resolution.
        await recordAccessRequestResolution(pendingRequest.firstRequestedAt, 'declined').catch((err) =>
          logger.warn({ err, userId }, 'Failed to record access request resolution'),
        );
      }
      // args.reason is never persisted (not in the audited params above) — it
      // only ever reaches this one DM, same non-persistence convention as
      // resolve_suggestion's reason field (#1099) two tool definitions below.
      // The DM target is exactly the (platform, userId) resolveMemberTarget
      // resolved from this tool's own arguments above — never re-derived from
      // any other row (issue #1126 acceptance criterion #5).
      if (success) {
        const target = adapterFor(platform);
        if (target) await notifyAccessRequestDeclined(target, userId, platform, undefined, args.reason);
      }
      return text(
        success ? `Declined the access request from ${userId} on ${platform}.` : `Failed: ${result}`,
        !success,
      );
    },
  }),

  defineTool({
    name: 'list_suggestions',
    description:
      'List member-submitted bot-improvement suggestions for triage. The bridge to the pipeline stays ' +
      'human: file anything worthwhile as a GitHub proposal yourself — the bot has no repo access. Admin only.',
    minTier: 'admin',
    readOnlyHint: true,
    schema: {
      status: z
        .enum(['new', 'reviewed', 'declined', 'done'])
        .optional()
        .describe('Filter by status (default: all statuses)'),
      limit: z.number().optional().describe('Max entries (default 50, max 200)'),
    },
    handler: async (args, { caller }) => {
      assertAtLeast(caller.role, 'admin', 'list_suggestions');
      const rows = await listSuggestions(args.status, args.limit ?? 50);
      if (rows.length === 0) return text('No suggestions found.');
      // withdraw_suggestion (issue #1243) consult: a suggestion the member
      // withdrew stays in `rows` (its own status is untouched — the
      // withdrawal lives in the separate suggestion_withdrawals table) but
      // must read distinctly from a live one, so an admin never triages a
      // suggestion the member already retracted as if it were still open.
      // With no suggestion ever withdrawn this Set is always empty, so the
      // rendered line is byte-identical to before this issue.
      const withdrawnIds = await getWithdrawnSuggestionIds(rows.map((s) => s.id));
      return text(
        untrusted(
          'Suggestions',
          rows
            .map((s) => {
              const statusTag = withdrawnIds.has(s.id) ? `${s.status}, withdrawn by member` : s.status;
              return `#${s.id} [${statusTag}] ${s.platform} ${s.displayName ? sanitizeName(s.displayName) : s.userId} (${s.createdAt.toISOString()}): ${s.content}`;
            })
            .join('\n'),
        ),
      );
    },
  }),

  defineTool({
    name: 'resolve_suggestion',
    description:
      'Mark a suggestion as reviewed, declined, or done once triaged. Non-destructive status change ' +
      '(no CONFIRM needed), audited. Admin only.',
    minTier: 'admin',
    readOnlyHint: false,
    schema: {
      id: z.number().describe('Suggestion id (from list_suggestions)'),
      status: z.enum(['reviewed', 'declined', 'done']).describe('New status'),
      reason: z
        .string()
        .max(SUGGESTION_RESOLUTION_ECHO_CHARS)
        .optional()
        .describe(
          'Optional, one-line, member-facing explanation appended verbatim to the resolution DM sent to ' +
            'the submitter when declining a suggestion, so they know why — omit for the existing neutral ' +
            'decline message with no reason. Ignored for `reviewed`/`done` statuses. Never persisted.',
        ),
    },
    handler: async (args, { caller, audited, adapterFor }) => {
      assertAtLeast(caller.role, 'admin', 'resolve_suggestion');
      const state: { row: { platform: Platform; userId: string; content: string } | null } = { row: null };
      const { success, result } = await audited({
        actionKind: 'resolve_suggestion',
        params: { id: args.id, status: args.status },
        run: async () => {
          // withdraw_suggestion consult (issue #1243), checked BEFORE
          // resolveSuggestion so a withdrawn suggestion never gets a status
          // change or a resolution DM — the member already retracted it,
          // so there is nothing left to resolve.
          const withdrawn = await getWithdrawnSuggestionIds([args.id]);
          if (withdrawn.has(args.id)) {
            throw new Error(`Suggestion #${args.id} was withdrawn by the member; nothing to resolve.`);
          }
          const row = await resolveSuggestion(args.id, args.status, caller.userId);
          if (!row) throw new Error(`No suggestion with id ${args.id}.`);
          state.row = row;
          return `marked ${args.status}`;
        },
      });
      // Cross-platform resolution DMs (issue #157): routes through the
      // suggestion's ORIGIN platform's adapter, not the resolving admin's
      // current-turn one, via Router's adapter registry — never misaddresses
      // a DM to the wrong platform. Degrades to today's silent skip if that
      // platform isn't registered in this deployment (e.g. WhatsApp not
      // configured). args.reason is never persisted (not in the audited
      // params above) — it only ever reaches this one DM, same
      // non-persistence convention as decline_knowledge_candidate's (#1050)
      // reason field.
      if (success && state.row) {
        const target = adapterFor(state.row.platform);
        if (target)
          await notifySuggestionResolved(
            target,
            state.row.userId,
            args.status,
            state.row.content,
            state.row.platform,
            undefined,
            args.reason,
          );
      }
      return text(success ? `Suggestion #${args.id} marked ${args.status}.` : `Failed: ${result}`, !success);
    },
  }),
];
