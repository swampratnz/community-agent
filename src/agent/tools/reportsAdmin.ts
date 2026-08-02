import { z } from 'zod';
import type { Platform } from '../../platforms/types.js';
import { assertAtLeast } from '../../auth/rbac.js';
import { sanitizeName } from '../../util/sanitizeName.js';
import { listReports, resolveContentReport, resolveLinkedIdentities } from '../../storage/repository.js';
import { text, untrusted } from './helpers.js';
import { notifyReportResolved } from './notify.js';
import { defineTool } from './types.js';

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
    },
    handler: async (args, { caller, callerScope }) => {
      assertAtLeast(caller.role, 'admin', 'list_reports');
      const allowed = await callerScope();
      // The accused-admin exclusion must cover EVERY identity linked to this
      // admin (issue #197 + link_member): a Discord+WhatsApp admin listing on
      // one platform could otherwise see a DM report filed against their other
      // identity, since a single raw id `<> ALL` their own list.
      const viewerIds = (await resolveLinkedIdentities(caller.platform, caller.userId)).map((i) => i.userId);
      const rows = await listReports(allowed, args.status, args.limit ?? 50, viewerIds, args.targetUserId);
      if (rows.length === 0) return text('No reports found (within your conversations).');
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
            .join('\n'),
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
      // if that platform isn't registered in this deployment.
      if (success && state.row) {
        const target = adapterFor(state.row.platform);
        if (target)
          await notifyReportResolved(
            target,
            state.row.reporterUserId,
            args.status,
            state.row.reason,
            state.row.platform,
          );
      }
      return text(success ? `Report #${args.id} marked ${args.status}.` : `Failed: ${result}`, !success);
    },
  }),
];
