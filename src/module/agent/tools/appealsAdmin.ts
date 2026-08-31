import { z } from 'zod';
import { assertAtLeast } from '@swampratnz/agent-base/auth/tiers.js';
import { sanitizeName } from '@swampratnz/agent-base/util/sanitizeName.js';
import {
  listAppeals,
  type ModerationAppeal,
  resolveModerationAppeal,
} from '@swampratnz/agent-base/storage/repository.js';
import { APPEAL_STALE_ALERT_SCAN_LIMIT } from '../../appealStaleAlert.js';
import { SUGGESTION_RESOLUTION_ECHO_CHARS, text, untrusted } from './helpers.js';
import { notifyAppealResolved } from './notify.js';
import { defineTool } from '@swampratnz/agent-base/agent/tools/types.js';

export const appealsAdminTools = [
  // Durable queue for appeal_moderation (issue #554): a member appealing
  // their own active warning(s)/mute is a self-scoped member-tier write
  // (appeal_moderation); reviewing/resolving the filed appeal is admin-tier,
  // same guild-wide (not conversation-scoped) boundary as clear_warnings/
  // list_member_warnings — warnings/mutes carry no conversation to scope by.
  defineTool({
    name: 'list_appeals',
    description:
      "List members' filed appeals of their own auto-moderation warning(s)/mute (issue #554) — the durable " +
      'queue `appeal_moderation` writes into, so a missed/dismissed admin DM no longer erases the record. ' +
      'Each row snapshots the active-warning count and strike limit at filing time, plus the optional ' +
      'reason. Admin only, guild-wide (not conversation-scoped, same as list_member_warnings/' +
      'clear_warnings) — warnings/mutes carry no conversation boundary to scope by.',
    minTier: 'admin',
    readOnlyHint: true,
    schema: {
      status: z
        .enum(['open', 'resolved', 'dismissed'])
        .optional()
        .describe('Filter by status (default: all statuses)'),
      limit: z.number().optional().describe('Max entries (default 50)'),
      oldestFirst: z
        .boolean()
        .optional()
        .describe(
          'Order by created_at ascending (oldest-filed first) instead of the default newest-first — use ' +
            'this to find appeals that have sat unreviewed the longest. Approximate for a large backlog: ' +
            `only scans the ${APPEAL_STALE_ALERT_SCAN_LIMIT} most recently created rows matching the ` +
            'status filter before sorting, so if that many or more match, the true oldest may fall ' +
            'outside what was scanned — the response says so explicitly when this happens.',
        ),
    },
    handler: async (args, { caller }) => {
      assertAtLeast(caller.role, 'admin', 'list_appeals');
      // oldestFirst: true takes exactly one bounded read (never a second
      // call) and sorts/slices in JS, mirroring list_reports (#1259)/
      // list_access_requests (#1261)/list_suggestions (#1255) —
      // agent-base's listAppeals has no ordering parameter to forward a
      // third argument to. False/omitted stays byte-identical to before
      // this field existed, using the identical single-call shape as before.
      const scanned = args.oldestFirst
        ? await listAppeals(args.status, APPEAL_STALE_ALERT_SCAN_LIMIT)
        : null;
      const rows = scanned
        ? [...scanned].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(0, args.limit ?? 50)
        : await listAppeals(args.status, args.limit ?? 50);
      if (rows.length === 0) return text('No appeals found.');
      // Truncation caveat (mirrors list_reports'/list_suggestions', #1259/
      // #1255 review): scanned hitting exactly APPEAL_STALE_ALERT_SCAN_LIMIT
      // means the DB may hold more matching rows than the single bounded
      // scan could see, so the true oldest could be outside that window —
      // say so rather than silently reporting a mid-recent row as oldest.
      const truncationCaveat =
        scanned && scanned.length === APPEAL_STALE_ALERT_SCAN_LIMIT
          ? ` ⚠️ oldestFirst caveat: ${APPEAL_STALE_ALERT_SCAN_LIMIT}+ appeals match this filter, so only ` +
            `the ${APPEAL_STALE_ALERT_SCAN_LIMIT} most recently created ones were scanned before sorting — ` +
            'the true oldest may not be shown above. Narrow the status filter or resolve some appeals to ' +
            'shrink the backlog if this list looks incomplete.'
          : '';
      return text(
        untrusted(
          'Moderation appeals',
          rows
            .map(
              (r) =>
                `#${r.id} [${r.status}] ${r.platform} — ${r.userName ? sanitizeName(r.userName) : r.userId} ` +
                `(${r.userId}), ${r.activeWarnings}/${r.strikeLimit} active warnings` +
                `${r.reason ? `: ${r.reason}` : ''} (${r.createdAt.toISOString()})`,
            )
            .join('\n') + truncationCaveat,
        ),
      );
    },
  }),

  defineTool({
    name: 'resolve_appeal',
    description:
      'Mark a filed moderation appeal as resolved or dismissed once triaged. Non-destructive status change ' +
      '(no CONFIRM needed), audited. Does NOT itself clear the warnings or lift a mute — that stays ' +
      "clear_warnings' job alone, a deliberate, separate admin judgement call. Admin only, guild-wide, " +
      'same as list_appeals.',
    minTier: 'admin',
    readOnlyHint: false,
    schema: {
      id: z.number().describe('Appeal id (from list_appeals)'),
      status: z.enum(['resolved', 'dismissed']).describe('New status'),
      reason: z
        .string()
        .max(SUGGESTION_RESOLUTION_ECHO_CHARS)
        .optional()
        .describe(
          'Optional, one-line, member-facing explanation appended verbatim to the resolution DM sent to ' +
            'the appellant when dismissing an appeal, so they know why — omit for the existing neutral ' +
            'dismissal message with no reason. Ignored for a `resolved` status. Never persisted.',
        ),
    },
    handler: async (args, { caller, audited, adapterFor }) => {
      assertAtLeast(caller.role, 'admin', 'resolve_appeal');
      const state: { row: ModerationAppeal | null } = { row: null };
      const { success, result } = await audited({
        actionKind: 'resolve_appeal',
        params: { id: args.id, status: args.status },
        run: async () => {
          const row = await resolveModerationAppeal(args.id, args.status, caller.userId);
          if (!row) throw new Error(`No appeal with id ${args.id}.`);
          state.row = row;
          return `marked ${args.status}`;
        },
      });
      // Cross-platform resolution DM (issue #157's mechanism, issue #622's
      // missing half of #554's own "mirror content_reports" pattern): routes
      // through the appeal's ORIGIN platform's adapter, degrading to a
      // silent skip if that platform isn't registered in this deployment.
      // The target is always state.row's own userId/platform — never any
      // resolve_appeal argument — so no caller-supplied value can redirect it.
      // args.reason is never persisted (not in the audited params above) — it
      // only ever reaches this one DM, same non-persistence convention as
      // decline_knowledge_candidate's (#1050) reason field.
      if (success && state.row) {
        const target = adapterFor(state.row.platform);
        if (target)
          await notifyAppealResolved(
            target,
            state.row.userId,
            args.status,
            state.row.reason,
            state.row.platform,
            undefined,
            args.reason,
          );
      }
      return text(success ? `Appeal #${args.id} marked ${args.status}.` : `Failed: ${result}`, !success);
    },
  }),
];
