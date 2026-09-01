import { z } from 'zod';
import type { Platform } from '@swampratnz/agent-base/platforms/types.js';
import { assertAtLeast } from '@swampratnz/agent-base/auth/tiers.js';
import { sanitizeName } from '@swampratnz/agent-base/util/sanitizeName.js';
import {
  listReports,
  resolveContentReport,
  resolveLinkedIdentities,
} from '@swampratnz/agent-base/storage/repository.js';
import { REPORT_STALE_ALERT_SCAN_LIMIT } from '../../reportStaleAlert.js';
import { SUGGESTION_RESOLUTION_ECHO_CHARS, text, untrusted } from './helpers.js';
import { notifyReportResolved } from './notify.js';
import { defineTool } from '@swampratnz/agent-base/agent/tools/types.js';

export const reportsAdminTools = [
  defineTool({
    name: 'list_reports',
    description:
      'List member-submitted content reports (harassment/spam/rule violations) from your conversations, ' +
      'plus any reports filed from a 1:1 DM (those have no conversation any regular admin naturally ' +
      'participates in). Exception: a DM report filed against you is not shown here — only a super admin ' +
      'can see and resolve a report about you, so you cannot dismiss one filed against yourself. Admin only.',
    minTier: 'admin',
    readOnlyHint: true,
    schema: {
      status: z
        .enum(['open', 'resolved', 'dismissed', 'withdrawn'])
        .optional()
        .describe('Filter by status (default: all statuses)'),
      limit: z.number().optional().describe('Max entries (default 50)'),
      targetUserId: z.string().optional().describe('Only show reports filed against this member'),
      oldestFirst: z
        .boolean()
        .optional()
        .describe(
          'Order by created_at ascending (oldest-filed first) instead of the default newest-first — use ' +
            'this to find reports that have sat unreviewed the longest. Approximate for a large backlog: ' +
            `only scans the ${REPORT_STALE_ALERT_SCAN_LIMIT} most recently created rows matching the ` +
            'status/target filters before sorting, so if that many or more match, the true oldest may fall ' +
            'outside what was scanned — the response says so explicitly when this happens.',
        ),
    },
    handler: async (args, { caller, callerScope }) => {
      assertAtLeast(caller.role, 'admin', 'list_reports');
      const allowed = await callerScope();
      // The accused-admin exclusion must cover EVERY identity linked to this
      // admin (issue #197 + link_member): a Discord+WhatsApp admin listing on
      // one platform could otherwise see a DM report filed against their other
      // identity, since a single raw id `<> ALL` their own list.
      const viewerIds = (await resolveLinkedIdentities(caller.platform, caller.userId)).map((i) => i.userId);
      // oldestFirst: true takes exactly one bounded read (never a second
      // call) and sorts/slices in JS, mirroring list_suggestions (#1255) —
      // agent-base's listReports has no ordering parameter to forward a
      // sixth argument to. False/omitted stays byte-identical to before this
      // field existed, using the identical single-call shape as before.
      const scanned = args.oldestFirst
        ? await listReports(allowed, args.status, REPORT_STALE_ALERT_SCAN_LIMIT, viewerIds, args.targetUserId)
        : null;
      const rows = scanned
        ? [...scanned]
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
            .slice(0, args.limit ?? 50)
        : await listReports(allowed, args.status, args.limit ?? 50, viewerIds, args.targetUserId);
      if (rows.length === 0) return text('No reports found (within your conversations).');
      // Truncation caveat (mirrors list_suggestions', #1255 review): scanned
      // hitting exactly REPORT_STALE_ALERT_SCAN_LIMIT means the DB may hold
      // more matching rows than the single bounded scan could see, so the
      // true oldest could be outside that window — say so rather than
      // silently reporting a mid-recent row as oldest.
      const truncationCaveat =
        scanned && scanned.length === REPORT_STALE_ALERT_SCAN_LIMIT
          ? ` ⚠️ oldestFirst caveat: ${REPORT_STALE_ALERT_SCAN_LIMIT}+ reports match this filter, so only ` +
            `the ${REPORT_STALE_ALERT_SCAN_LIMIT} most recently created ones were scanned before sorting — ` +
            'the true oldest may not be shown above. Narrow the status filter or resolve some reports to ' +
            'shrink the backlog if this list looks incomplete.'
          : '';
      return text(
        untrusted(
          'Content reports',
          rows
            .map(
              (r) =>
                `#${r.id} [${r.status}] ${r.platform} ${r.conversationId} — reporter ${r.reporterName ? sanitizeName(r.reporterName) : r.reporterUserId}` +
                `${r.targetUserId ? `, target ${r.targetUserId}` : ''}${r.messageId ? `, message ${r.messageId}` : ''}: ` +
                `${r.reason} (${r.createdAt.toISOString()})`,
            )
            .join('\n') + truncationCaveat,
        ),
      );
    },
  }),

  defineTool({
    name: 'resolve_report',
    description:
      'Mark a content report as resolved or dismissed once triaged. Non-destructive status change (no ' +
      'CONFIRM needed), audited. Admins can resolve reports from conversations they are in, plus ' +
      'DM-originated reports — except one filed against themselves, which stays super-admin-only. ' +
      'Admin only.',
    minTier: 'admin',
    readOnlyHint: false,
    schema: {
      id: z.number().describe('Report id (from list_reports)'),
      status: z.enum(['resolved', 'dismissed']).describe('New status'),
      reason: z
        .string()
        .max(SUGGESTION_RESOLUTION_ECHO_CHARS)
        .optional()
        .describe(
          'Optional, one-line, member-facing explanation appended verbatim to the resolution DM sent to ' +
            'the reporter when dismissing a report, so they know why — omit for the existing neutral ' +
            'dismissal message with no reason. Ignored for a `resolved` status. Never persisted.',
        ),
    },
    handler: async (args, { caller, callerScope, audited, adapterFor }) => {
      assertAtLeast(caller.role, 'admin', 'resolve_report');
      const allowed = await callerScope();
      // Same linked-identity-aware accused-admin exclusion as list_reports.
      const viewerIds = (await resolveLinkedIdentities(caller.platform, caller.userId)).map((i) => i.userId);
      const state: { row: { platform: Platform; reporterUserId: string; reason: string } | null } = {
        row: null,
      };
      const { success, result } = await audited({
        actionKind: 'resolve_report',
        params: { id: args.id, status: args.status },
        run: async () => {
          const row = await resolveContentReport(
            args.id,
            args.status,
            caller.userId,
            allowed ?? undefined,
            viewerIds,
          );
          if (!row) throw new Error(`No report with id ${args.id} in your conversations.`);
          state.row = row;
          return `marked ${args.status}`;
        },
      });
      // Cross-platform resolution DMs (issue #157), identical mechanism to
      // resolve_suggestion above: routes through the report's ORIGIN
      // platform's adapter via Router's registry, degrading to a silent skip
      // if that platform isn't registered in this deployment. args.reason is
      // never persisted (not in the audited params above) — it only ever
      // reaches this one DM, same non-persistence convention as
      // decline_knowledge_candidate's (#1050) reason field.
      if (success && state.row) {
        const target = adapterFor(state.row.platform);
        if (target)
          await notifyReportResolved(
            target,
            state.row.reporterUserId,
            args.status,
            state.row.reason,
            state.row.platform,
            undefined,
            args.reason,
          );
      }
      return text(success ? `Report #${args.id} marked ${args.status}.` : `Failed: ${result}`, !success);
    },
  }),
];
