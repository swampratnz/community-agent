import { z } from 'zod';
import { assertAtLeast } from '@swampratnz/agent-base/auth/tiers.js';
import { buildAdminDigestForAdmin } from '../../adminDigest.js';
import {
  countAccessRequests,
  countOpenAppeals,
  countOpenReports,
  countPendingKnowledgeCandidates,
  countPendingSuggestions,
  oldestAccessRequestAgeDays,
  oldestOpenAppealAgeDays,
  oldestOpenReportAgeDays,
  oldestPendingCandidateAgeDays,
  oldestPendingSuggestionAgeDays,
  recentQuestionClusters,
  resolveLinkedIdentities,
  responseLatencyStats,
} from '@swampratnz/agent-base/storage/repository.js';
import { text, untrusted } from './helpers.js';
import { defineTool } from '@swampratnz/agent-base/agent/tools/types.js';

export const digestsAdminTools = [
  defineTool({
    name: 'question_digest',
    description:
      'Show recurring questions asked in your conversations over recent days (count >= 2), a signal for what should become a knowledge entry. Admin only.',
    minTier: 'admin',
    readOnlyHint: true,
    schema: {
      days: z.number().optional().describe('Window in days (default 7, max 30)'),
      limit: z.number().optional().describe('Max clusters to return (default 10)'),
    },
    handler: async (args, { caller, callerScope }) => {
      assertAtLeast(caller.role, 'admin', 'question_digest');
      const allowed = await callerScope();
      const clusters = await recentQuestionClusters(allowed, args.days ?? 7, args.limit ?? 10);
      if (clusters.length === 0)
        return text('No recurring questions in that window (within your conversations).');
      return text(
        untrusted(
          'Recurring questions',
          clusters.map((c, i) => `${i + 1}. (${c.count}x) ${c.representative.slice(0, 300)}`).join('\n'),
        ),
      );
    },
  }),

  defineTool({
    name: 'admin_digest',
    description:
      'On-demand pull of your OWN admin-digest snapshot — the same recurring-question, pending-access-request, ' +
      'open-report, pending-suggestion, stale/gap/candidate/low-rated-knowledge, roster, muted-member, ' +
      'max-turns-failure, duplicate/conflict-knowledge, and onboarding-queue signals the weekly digest DM ' +
      'would send you right now, without waiting for its cadence. Takes no arguments — always your own scoped ' +
      "view, never another admin's. Read-only; does not affect when your next weekly digest DM arrives. Admin only.",
    minTier: 'admin',
    readOnlyHint: true,
    schema: {},
    handler: async (_args, { caller, adapter }) => {
      assertAtLeast(caller.role, 'admin', 'admin_digest');
      // Read-only pull: take only the rendered message. Deliberately ignore
      // `currentCounts` — snapshotting is exclusive to the scheduled
      // `runAdminDigestOnce`, so an on-demand pull never advances the
      // week-over-week trend baseline (issue #499 / #497).
      const { message } = await buildAdminDigestForAdmin(caller.platform, caller.userId, adapter);
      if (message == null) return text('Nothing to report right now.');
      // Unlike the weekly DM push (plain text straight to a human, never
      // re-parsed), this tool result re-enters the model's context — and the
      // cluster section embeds raw member-submitted question text
      // (recentQuestionClusters). Quarantine the whole message the same way
      // question_digest quarantines the identical cluster data above (issue
      // #499 review).
      return text(untrusted('Admin digest', message));
    },
  }),

  // Argument-less roll-up of the five review-queue tools' own counts (issue
  // #743) — access requests/suggestions/knowledge candidates are guild-wide
  // like their list_* tools; reports uses callerScope()+linked-identity
  // exclusion like list_reports; appeals uses caller.platform like
  // list_appeals. No new scoping decision, no new data exposure.
  defineTool({
    name: 'review_queue',
    description:
      'Single roll-up of all five admin review queues — access requests, suggestions, knowledge candidates, ' +
      'reports, and appeals — each with its current pending/open count, so triage starts with one glance ' +
      "instead of polling five separate list_* tools in turn. Every line also shows the oldest item's age in " +
      'whole days once that queue is non-empty. Reports reflect only your own conversation scope, same as ' +
      'list_reports (never a guild-wide total); appeals reflect only your own platform, same as list_appeals. ' +
      'Read-only, takes no arguments. Admin only.',
    minTier: 'admin',
    readOnlyHint: true,
    schema: {},
    handler: async (_args, { caller, callerScope }) => {
      assertAtLeast(caller.role, 'admin', 'review_queue');
      const allowed = await callerScope();
      // Same linked-identity-aware accused-admin exclusion list_reports uses
      // (issue #197 + link_member), so the reports line here can never show a
      // count larger than what list_reports would actually let this admin open.
      const viewerIds = (await resolveLinkedIdentities(caller.platform, caller.userId)).map((i) => i.userId);
      const [
        accessRequestCount,
        accessRequestAgeDays,
        suggestionCount,
        suggestionAgeDays,
        candidateCount,
        candidateAgeDays,
        reportCount,
        reportAgeDays,
        appealCount,
        appealAgeDays,
      ] = await Promise.all([
        countAccessRequests(),
        oldestAccessRequestAgeDays(),
        countPendingSuggestions(),
        oldestPendingSuggestionAgeDays(),
        countPendingKnowledgeCandidates(),
        oldestPendingCandidateAgeDays(),
        countOpenReports(allowed, viewerIds),
        oldestOpenReportAgeDays(allowed, viewerIds),
        countOpenAppeals(caller.platform),
        oldestOpenAppealAgeDays(caller.platform),
      ]);
      // Each oldest*AgeDays resolves to null over an empty (or fully-scoped-
      // out) row set, never 0 — so gating the suffix on non-null is exactly
      // "only when this queue is non-empty" (acceptance criterion 2).
      const ageSuffix = (ageDays: number | null) => (ageDays !== null ? ` (oldest ${ageDays}d)` : '');
      const lines = [
        `- Access requests: ${accessRequestCount} pending${ageSuffix(accessRequestAgeDays)}`,
        `- Suggestions: ${suggestionCount} pending${ageSuffix(suggestionAgeDays)}`,
        `- Knowledge candidates: ${candidateCount} pending${ageSuffix(candidateAgeDays)}`,
        `- Reports (your conversations): ${reportCount} open${ageSuffix(reportAgeDays)}`,
        `- Appeals: ${appealCount} open${ageSuffix(appealAgeDays)}`,
      ];
      return text(`📋 Review queue\n${lines.join('\n')}`);
    },
  }),

  // Time-to-first-answer aggregate (issue #877). Admin-tier and
  // callerScope()-scoped exactly like review_queue/question_digest above.
  // Historical note (issue #877 review): under the old hand-maintained rbac
  // tier arrays this tool once shipped registered-but-never-offered (dead
  // code in production); the offered surface is now derived from this def's
  // own minTier, which is exactly the failure class the registry kills.
  defineTool({
    name: 'response_latency',
    description:
      "Show how quickly your conversations' members are getting answered — count of replies, median and " +
      'p90 response time in seconds, over a recent window (default 7 days, max 30). Pairs each reply to a ' +
      "member with that member's preceding message; proactive digest/alert pushes are never counted. " +
      "Optionally scope to 'auto_answer' (ambient auto-answer replies only) or 'mention' (every other " +
      'reply — DMs and text-command replies included, since those also set replyToUserId without ' +
      "autoAnswer); default 'all'. Aggregate only — never a per-message timestamp, user id, or message " +
      'excerpt. Admin only.',
    minTier: 'admin',
    readOnlyHint: true,
    schema: {
      days: z.number().optional().describe('Window in days (default 7, max 30)'),
      scope: z
        .enum(['all', 'auto_answer', 'mention'])
        .optional()
        .describe("Restrict to 'auto_answer' or 'mention' replies (default 'all')"),
    },
    handler: async (args, { caller, callerScope }) => {
      assertAtLeast(caller.role, 'admin', 'response_latency');
      const allowed = await callerScope();
      const stats = await responseLatencyStats(allowed, args.days ?? 7, args.scope ?? 'all');
      const days = Math.min(Math.max(Math.trunc(args.days ?? 7) || 7, 1), 30);
      if (!stats) return text(`⏱️ Response latency (last ${days}d): not enough data yet.`);
      return text(
        `⏱️ Response latency (last ${days}d): ${stats.count} replies, ` +
          `median ${Math.round(stats.medianSeconds)}s, p90 ${Math.round(stats.p90Seconds)}s`,
      );
    },
  }),
];
