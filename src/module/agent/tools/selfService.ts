import { config } from '../../../base/config.js';
import {
  countActiveWarnings,
  countRepliesToUser,
  getMyDataSummary,
  listOwnAppeals,
  listOwnKnowledgeCandidates,
  listOwnProjectConnectionRequests,
  listOwnReports,
  listOwnSuggestions,
  purgeUserData,
} from '../../../base/storage/repository.js';
import { formatRelativeAge, PROJECT_NOTE_RETENTION_NOTICE, text, truncateForEcho } from './helpers.js';
import { defineTool } from '../../../base/agent/tools/types.js';

export const selfServiceTools = [
  defineTool({
    name: 'forget_me',
    description:
      "Delete the requester's own stored data from the bot's memory (privacy request): their messages, " +
      'plus any knowledge entries, content reports, suggestions, roster entry, and admin notes tied to ' +
      'them — across linked identities. Requires confirmation.',
    minTier: 'member',
    readOnlyHint: false,
    schema: {},
    handler: async (_args, { caller, requireConfirm }) =>
      requireConfirm(
        `erase ${caller.userName}'s stored data on ${caller.platform} — messages, and any knowledge entries, content reports, suggestions, roster entry, or admin notes tied to them, across linked identities; ${PROJECT_NOTE_RETENTION_NOTICE}`,
        // Self-scoped: whatever tier the caller is, they can only ever purge
        // their OWN data. An open-mode guest (whose content IS stored) can
        // reach this tool, so gating the confirm at 'member' made their
        // CONFIRM fail the tier re-check and report a false "your permissions
        // changed". 'guest' is the correct floor for a self-scoped purge.
        'guest',
        async () => {
          const n = await purgeUserData(caller.platform, caller.userId);
          return `Deleted ${n} stored record(s) for ${caller.userName}; ${PROJECT_NOTE_RETENTION_NOTICE}.`;
        },
      ),
  }),

  // Self-scoped read of the caller's OWN suggestions/reports/appeals and
  // suggest_knowledge tips (never the shared queue, never another member's
  // rows, never reviewer identity) — the pull-based counterpart to the
  // best-effort resolution DMs.
  defineTool({
    name: 'my_submissions',
    description:
      "List the caller's OWN previously-filed suggestions, content reports, moderation appeals, knowledge " +
      'tips, and sent project-connection requests — id, a short content preview, current status, and when ' +
      'each was filed. Use this when a member asks what happened to something they submitted earlier (e.g. ' +
      '"what happened to my report?"). The connection-requests section is a plain RECEIPT (what you asked, ' +
      "when) — request_project_connection has no accept/decline state, so there's no status to show, and a " +
      'capped/refused attempt is never recorded so it never appears here either. Never returns another ' +
      "member's content or the reviewing admin's identity — only the shared admin queue " +
      '(list_suggestions/list_reports/list_appeals/list_knowledge_candidates) exposes that, and this tool ' +
      'never reaches it.',
    minTier: 'member',
    readOnlyHint: false,
    schema: {},
    handler: async (_args, { caller }) => {
      const [suggestions, reports, appeals, knowledgeTips, connectionRequests] = await Promise.all([
        listOwnSuggestions(caller.platform, caller.userId, 10),
        listOwnReports(caller.platform, caller.userId, 10),
        listOwnAppeals(caller.platform, caller.userId, 10),
        listOwnKnowledgeCandidates(caller.platform, caller.userId, 10),
        listOwnProjectConnectionRequests(caller.platform, caller.userId, 10),
      ]);

      if (
        suggestions.length === 0 &&
        reports.length === 0 &&
        appeals.length === 0 &&
        knowledgeTips.length === 0 &&
        connectionRequests.length === 0
      ) {
        return text("You haven't filed any suggestions or reports yet.", true);
      }

      const lines: string[] = [];
      if (suggestions.length > 0) {
        lines.push('Your suggestions:');
        for (const s of suggestions) {
          lines.push(
            `- #${s.id} [${s.status}] ${truncateForEcho(s.content)} — filed ${formatRelativeAge(s.createdAt)}`,
          );
        }
      }
      if (reports.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push('Your reports:');
        for (const r of reports) {
          lines.push(
            `- #${r.id} [${r.status}] ${truncateForEcho(r.reason)} — filed ${formatRelativeAge(r.createdAt)}`,
          );
        }
      }
      if (appeals.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push('Your appeals:');
        for (const a of appeals) {
          const reason = a.reason ? truncateForEcho(a.reason) : 'no reason given';
          lines.push(`- #${a.id} [${a.status}] ${reason} — filed ${formatRelativeAge(a.createdAt)}`);
        }
      }
      if (knowledgeTips.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push('Your knowledge tips:');
        for (const k of knowledgeTips) {
          // "used N times" only for an accepted tip with a positive retrieval
          // count (issue #880) — never "used 0 times" for an accepted-but-
          // unretrieved or non-accepted tip, which would read as discouraging.
          const impact =
            k.status === 'accepted' && k.retrievalCount && k.retrievalCount > 0
              ? ` — used ${k.retrievalCount} time${k.retrievalCount === 1 ? '' : 's'} in answers so far`
              : '';
          lines.push(
            `- #${k.id} [${k.status}] ${truncateForEcho(k.title)} — filed ${formatRelativeAge(k.createdAt)}${impact}`,
          );
        }
      }
      if (connectionRequests.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push('Your connection requests:');
        for (const c of connectionRequests) {
          // No status column exists (issue #908) — this is a receipt, not a
          // tracker. A since-removed/purged project reads back null; say so
          // rather than rendering a blank or throwing.
          const projectLabel = c.projectName ?? 'a project that is no longer listed';
          lines.push(`- #${c.id} — ${projectLabel} — filed ${formatRelativeAge(c.createdAt)}`);
        }
      }
      return text(lines.join('\n'));
    },
  }),

  // Self-scoped read of the caller's OWN active warning count vs. the
  // configured limit — never a warning's reason/excerpt (admin-only context,
  // see list_member_warnings) and never another member's warnings.
  defineTool({
    name: 'my_warnings',
    description:
      "Check the caller's OWN active auto-moderation warning count and the configured limit — use this when " +
      'a member asks how many warnings they have or whether they can still post. Always scoped to the ' +
      "caller's own platform/user id, never a model-supplied identifier. Never includes a warning's reason " +
      'or excerpt — that context stays admin-only (see list_member_warnings).',
    minTier: 'member',
    readOnlyHint: false,
    schema: {},
    handler: async (_args, { caller }) => {
      const limit = config.moderation.strikeLimit;
      const windowDays = config.moderation.strikeWindowDays;
      // Report on the UNWINDOWED count. A mute is only ever lifted by
      // clear_warnings, never by strikes aging out of the window, so a member
      // whose strikes have aged out of the window can still be blocked;
      // reporting the windowed count alone told them "you have no active
      // warnings" while they were still at/over the limit (advisory F5). This
      // deliberately does NOT claim a live Discord mute — the tool can't read
      // the role state (issue #182) — only the caller's count vs. the limit.
      // When no window is configured the two counts are identical, so the
      // extra read is skipped.
      const active = await countActiveWarnings(caller.platform, caller.userId);
      if (active === 0) {
        return text('You have no active warnings.');
      }
      if (active >= limit) {
        return text(`You've reached the warning limit (${active}/${limit}). An admin can clear this.`);
      }
      let msg = `You have ${active} active warning${active === 1 ? '' : 's'} (limit ${limit}).`;
      if (windowDays) {
        const windowed = await countActiveWarnings(caller.platform, caller.userId, windowDays);
        if (windowed < active) {
          msg +=
            ` ${active - windowed} of these are old enough not to count toward a new mute, but any uncleared ` +
            'warning still applies if you leave and rejoin.';
        }
      }
      return text(msg);
    },
  }),

  // Self-scoped, read-only summary of what's stored about the caller —
  // counts mirroring exactly what forget_me/purge_user_data would delete,
  // scoped the same way (own identity + linked identities). Never queries
  // member_notes (issue #45: no member self-access to notes about
  // themselves) or any other admin-only table.
  defineTool({
    name: 'my_data',
    description:
      'Summarize what the bot has stored about the caller: their own message count, replies the bot has ' +
      'sent them, knowledge entries sourced from them, content reports and suggestions they filed, whether ' +
      "they've published interests for member discovery, their standing response-style preference, and " +
      "where they stand against today's daily reply budget. Use " +
      'this when a member asks what the bot knows about them, wants to see what forget_me would erase ' +
      'before deciding to invoke it, or asks how many messages they have left today. Read-only, scoped ' +
      "exactly like forget_me — the caller's own identity plus any identity linked via link_member — so " +
      "it can never see another member's data. Does not cover active warnings (see my_warnings) or the " +
      'status of a specific filed item (see my_submissions), which already have their own tools; also ' +
      'never includes admin notes about the caller (member_notes stays admin-only).',
    minTier: 'member',
    readOnlyHint: false,
    schema: {},
    handler: async (_args, { caller }) => {
      const summary = await getMyDataSummary(caller.platform, caller.userId);
      const lines = [
        `Messages you've sent: ${summary.ownMessages}`,
        `Replies the bot has sent you: ${summary.repliesToThem}`,
        `Knowledge entries sourced from you: ${summary.knowledgeEntries}`,
        `Content reports you've filed: ${summary.reportsFiled}`,
        `Suggestions you've filed: ${summary.suggestionsFiled}`,
        `Projects you've shared: ${summary.projectsShared}`,
        `Interests published (who_is_into): ${summary.interestsPublished > 0 ? 'yes' : 'no'}`,
        `Response style preference: ${summary.responseStyle === 'plain' ? 'plain' : 'standard (default)'}`,
      ];
      // Daily reply budget (issue #444) — reuses the exact function
      // router.ts's own enforcement calls, so what this reports can never
      // diverge from what actually gates the caller.
      const limit = config.behaviour.dailyReplyLimitPerUser;
      if (caller.role === 'super_admin') {
        lines.push('Daily reply limit: exempt (super admin).');
      } else if (limit === 0) {
        lines.push('Daily reply limit: none configured.');
      } else {
        const used = await countRepliesToUser(caller.platform, caller.userId);
        lines.push(
          `Replies in the last 24h: ${used} / ${limit}` +
            (used >= limit ? " — you've reached today's limit." : ''),
        );
      }
      lines.push(
        '',
        'For your active warnings, use my_warnings. For the status of a specific report or suggestion, use my_submissions.',
      );
      return text(lines.join('\n'));
    },
  }),
];
