import { z } from 'zod';
import { assertAtLeast } from '@swampratnz/agent-base/auth/tiers.js';
import { config } from '@swampratnz/agent-base/config.js';
import { logger, hashId } from '@swampratnz/agent-base/logger.js';
import { WindowClosedError } from '@swampratnz/agent-base/platforms/types.js';
import {
  FIND_HELPER_REQUESTER_DAILY_LIMIT,
  FIND_HELPER_TOPIC_MAX_CHARS,
  FIND_HELPER_WEEKLY_LIMIT_PER_HELPER,
  findHelperCandidates,
  getActiveProjectById,
  isFindHelperRequesterAtDailyCap,
  isProjectConnectionRequesterAtDailyCap,
  listOwnProjects,
  listRecentInterests,
  listRecentProjects,
  MEMBER_INTERESTS_MAX_CHARS,
  MEMBER_PROJECT_CAP,
  PROJECT_CONNECTION_REQUESTER_DAILY_LIMIT,
  PROJECT_DESCRIPTION_MAX_CHARS,
  PROJECT_LINK_MAX_CHARS,
  PROJECT_NAME_MAX_CHARS,
  PROJECT_RATE_LIMIT_PER_DAY,
  recordHelperNotificationIfUnderCap,
  recordProjectConnectionIfUnderCap,
  removeMemberProject,
  searchMemberInterests,
  searchMemberInterestsForSelf,
  searchProjects,
  setHelperAvailability,
  setMemberInterests,
  shareProject,
  WHO_IS_INTO_LIMIT,
} from '@swampratnz/agent-base/storage/repository.js';
import {
  formatInterestResults,
  formatProjectResults,
  resolveSanitizedLabel,
  text,
  untrusted,
} from './helpers.js';
import { defineTool } from '@swampratnz/agent-base/agent/tools/types.js';

/** list_projects' row cap for both the no-query (recent) and query (similarity) paths. */
export const LIST_PROJECTS_DEFAULT_LIMIT = 8;

export const socialTools = [
  // Self-scoped write (one row per identity, upsert/clear semantics),
  // instantly reversible ('clear') like set_response_style — no CONFIRM gate.
  // Publishes to other members (issue #634), so unlike most other
  // self-service member tools it re-checks 'member' explicitly in the
  // handler to exclude open-mode guests, same discipline share_project below
  // uses. Only self-declared text is ever stored — never inferred from chat.
  defineTool({
    name: 'set_my_interests',
    description:
      "Publish the caller's own interests — what they're building, learning, or into — so other members " +
      `can find them via who_is_into (self-declared free text, max ${MEMBER_INTERESTS_MAX_CHARS} characters). ` +
      "Call with the literal text 'clear' to remove the caller's entry and stop appearing in who_is_into " +
      'results. Only call this on an explicit, deliberate request to publish/set/update/clear interests for ' +
      'member discovery ("add me to who\'s into RAG", "update my interests", "clear my interests") — never ' +
      'inferred from general chat about what someone is working on.',
    minTier: 'member',
    readOnlyHint: false,
    schema: {
      interests: z
        .string()
        .min(1)
        .max(MEMBER_INTERESTS_MAX_CHARS)
        .describe(
          "Free text describing the caller's own interests/what they're building or into (max " +
            `${MEMBER_INTERESTS_MAX_CHARS} characters), or the literal string 'clear' to remove the caller's entry.`,
        ),
    },
    handler: async (args, { caller }) => {
      // Publishing to a member-facing discovery directory is a step further
      // than a private, self-scoped preference like set_response_style, so
      // this (and who_is_into below) explicitly floors at 'member' — same
      // member-tier re-check share_project/list_projects below use.
      assertAtLeast(caller.role, 'member', 'set_my_interests');
      const { cleared } = await setMemberInterests(caller.platform, caller.userId, args.interests);
      return text(
        cleared
          ? "Cleared your interests — you'll no longer appear in who_is_into results."
          : 'Got it — your interests are now visible to other members via who_is_into.',
      );
    },
  }),

  // Read-only counterpart to set_my_interests — embedding-similarity search
  // over member_interests only, same 'member' floor check. A caller with no
  // published interests of their own can still search.
  defineTool({
    name: 'who_is_into',
    description:
      'Find other members whose self-declared interests (published via set_my_interests) match a topic — ' +
      'member-to-member discovery, e.g. "who\'s into RAG?" or "anyone working on MCP servers?". Returns up ' +
      `to ${WHO_IS_INTO_LIMIT} matches by meaning. Results derive only from what members have explicitly ` +
      'published with set_my_interests — never from general chat or any other source. A caller with no ' +
      'published interests of their own can still search. Omit the topic to find members like the caller ' +
      "themselves — matched against the caller's OWN published interests, excluding the caller's own entry " +
      '(requires the caller to have already called set_my_interests).',
    minTier: 'member',
    readOnlyHint: true,
    schema: {
      query: z
        .string()
        .min(1)
        .max(300)
        .optional()
        .describe(
          'Topic/keyword to search published member interests by meaning. Omit to search using the ' +
            'caller\'s own published interests instead ("find people like me").',
        ),
    },
    handler: async (args, { caller }) => {
      assertAtLeast(caller.role, 'member', 'who_is_into');
      if (args.query) {
        const hits = await searchMemberInterests(args.query, WHO_IS_INTO_LIMIT);
        if (hits.length === 0) {
          return text('No members have published interests matching that yet.');
        }
        return text(await formatInterestResults(hits));
      }
      const selfMatch = await searchMemberInterestsForSelf(caller.platform, caller.userId, WHO_IS_INTO_LIMIT);
      if (!selfMatch.hasProfile) {
        // Issue #920: a caller with no published row of their own can no
        // longer only be told to publish first — fall back to browsing the
        // most recently published/updated interests (mirroring
        // list_projects' no-query listRecentProjects default), still
        // appending the same set_my_interests hint after the list.
        const hint =
          "You haven't published interests yet — call set_my_interests first, then who_is_into with no " +
          'topic will search using your own published interests.';
        const recent = await listRecentInterests(WHO_IS_INTO_LIMIT);
        return text(recent.length === 0 ? hint : `${await formatInterestResults(recent)}\n\n${hint}`);
      }
      if (selfMatch.hits.length === 0) {
        return text('No other members have published interests matching yours yet.');
      }
      return text(await formatInterestResults(selfMatch.hits));
    },
  }),

  // Opt-in "notify me to help" flag riding the caller's own member_interests
  // row (issue #729) — self-scoped, instantly reversible like
  // set_response_style, so no CONFIRM gate. Behind FIND_HELPER_ENABLED (the
  // featureFlag below), same layering as generate_image/suggest_issue/
  // dev_team_*.
  defineTool({
    name: 'set_helper_availability',
    description:
      "Opt in or out of being notified when another member's find_helper topic matches the caller's own " +
      'published interests (set via set_my_interests). Requires an existing published interests row — call ' +
      "set_my_interests first if you haven't. Instantly reversible, same shape as set_response_style. Behind " +
      'a feature flag; if unavailable on this server, this tool will not appear at all.',
    minTier: 'member',
    featureFlag: (cfg) => cfg.findHelper.enabled,
    readOnlyHint: false,
    schema: {
      available: z
        .boolean()
        .describe(
          'true to opt in to being notified for find_helper requests matching your published interests; ' +
            'false to opt out',
        ),
    },
    handler: async (args, { caller }) => {
      // MEMBER_TOOLS' floor re-check discipline for a self-service write that
      // reaches other members, same as set_my_interests/share_project above.
      assertAtLeast(caller.role, 'member', 'set_helper_availability');
      if (!config.findHelper.enabled) {
        return text('Peer-help handoff is not enabled on this server.', true);
      }
      const result = await setHelperAvailability(caller.platform, caller.userId, args.available);
      if (!result.ok) {
        return text(
          "You don't have published interests yet — call set_my_interests first, then " +
            'set_helper_availability can turn on notifications for topics matching them.',
          true,
        );
      }
      return text(
        args.available
          ? `You'll now be notified (at most ${FIND_HELPER_WEEKLY_LIMIT_PER_HELPER} times a week) when ` +
              "another member's find_helper topic matches your published interests."
          : "You won't be notified for find_helper requests anymore.",
      );
    },
  }),

  // The active-side handoff itself (issue #729): matches the caller's topic
  // against opted-in helpers and sends at most one DM. Re-checks 'member' in
  // the handler like set_my_interests/share_project — this is the first
  // member-tier write that DMs a DIFFERENT member as a side effect, so it's
  // rate-capped on both the requester and the notified-helper side (see
  // repository.ts FIND_HELPER_REQUESTER_DAILY_LIMIT /
  // FIND_HELPER_WEEKLY_LIMIT_PER_HELPER). Same FIND_HELPER_ENABLED gate as
  // set_helper_availability above.
  defineTool({
    name: 'find_helper',
    description:
      'Ask for member-to-member help on a topic. Matches your topic against members who have opted in via ' +
      'set_helper_availability(true) and sends AT MOST ONE direct message, to the single best match — never ' +
      'a broadcast. Never reveals who (if anyone) was contacted, their handle, or their interest text — only ' +
      `whether someone was reached. Capped to ${FIND_HELPER_REQUESTER_DAILY_LIMIT} calls per rolling 24 hours. ` +
      'Behind a feature flag; if unavailable on this server, this tool will not appear at all.',
    minTier: 'member',
    featureFlag: (cfg) => cfg.findHelper.enabled,
    readOnlyHint: false,
    schema: {
      topic: z
        .string()
        .min(1)
        .max(FIND_HELPER_TOPIC_MAX_CHARS)
        .describe(`What you need help with (max ${FIND_HELPER_TOPIC_MAX_CHARS} characters)`),
    },
    handler: async (args, { caller, adapterFor }) => {
      assertAtLeast(caller.role, 'member', 'find_helper');
      if (!config.findHelper.enabled) {
        return text('Peer-help handoff is not enabled on this server.', true);
      }
      if (await isFindHelperRequesterAtDailyCap(caller.platform, caller.userId)) {
        return text(
          `You've hit today's ask-for-help limit (${FIND_HELPER_REQUESTER_DAILY_LIMIT}). Try again tomorrow.`,
          true,
        );
      }
      // Walks best-match-first; the FIRST candidate under its own weekly cap
      // wins and the loop stops — at most one DM is ever sent per call
      // (issue #729 SECURITY criterion), regardless of how many candidates
      // matched. A candidate on a platform with no registered adapter in
      // this deployment is skipped without consuming their weekly cap slot.
      const candidates = await findHelperCandidates(args.topic, caller.platform, caller.userId);
      for (const candidate of candidates) {
        const target = adapterFor(candidate.platform);
        if (!target) continue;
        const claimed = await recordHelperNotificationIfUnderCap(
          candidate.platform,
          candidate.userId,
          caller.platform,
          caller.userId,
          args.topic,
        );
        if (!claimed) continue;
        const requesterLabel = await resolveSanitizedLabel(caller.platform, caller.userId);
        // untrusted() quarantines the requester's free-text topic before it
        // reaches a DIFFERENT member's DM (issue #729 SECURITY criterion) —
        // same discipline list_answer_feedback's comment field already uses.
        const message =
          `${requesterLabel} could use some help with something you're into — reach out if you're able to.\n` +
          untrusted('topic', args.topic);
        // Best-effort send, same fire-and-forget/WindowClosedError-queue
        // shape as notifySuggestionResolved/notifyReportResolved — a failed
        // or queued send still counts as "the one DM this call sends" (the
        // notification row above is already committed).
        await target.sendDirectMessage(candidate.userId, message).catch((err) => {
          if (err instanceof WindowClosedError && target.queueForWindowReopen) {
            target.queueForWindowReopen(candidate.userId, message, 'low');
            logger.warn(
              { userId: hashId(candidate.userId), platform: candidate.platform },
              "find_helper DM: recipient's window is closed, queued for reopen",
            );
            return;
          }
          logger.warn({ err, userId: hashId(candidate.userId) }, 'find_helper DM failed');
        });
        return text('Reached out to someone who may be able to help — hang tight.');
      }
      return text('No one available to help with that right now.');
    },
  }),

  // Self-scoped write (rate-capped, own-project-only), instantly reversible
  // like set_response_style — no CONFIRM gate. Publishes to other members
  // (issue #646), so it re-checks 'member' explicitly in the handler to
  // exclude open-mode guests.
  defineTool({
    name: 'share_project',
    description:
      "Publish one of the caller's own projects to the community project showcase, visible to every " +
      'other member via list_projects. Only call this on an explicit, deliberate request to share/' +
      'showcase a project ("share my project", "add this to the showcase") — never inferred from ' +
      'general chat about something someone is building. Calling with a name that matches one of the ' +
      "caller's existing shared projects EDITS it in place (new description/link) rather than adding a " +
      `duplicate. Capped at ${MEMBER_PROJECT_CAP} shared projects per member and ${PROJECT_RATE_LIMIT_PER_DAY} ` +
      'new shares per rolling 24 hours — edits do not count against either cap. Set remove: true to take ' +
      'an existing project down instead of adding or editing one.',
    minTier: 'member',
    readOnlyHint: false,
    schema: {
      name: z
        .string()
        .min(1)
        .max(PROJECT_NAME_MAX_CHARS)
        .describe(
          `The project's name (max ${PROJECT_NAME_MAX_CHARS} characters) — identifies which of the ` +
            "caller's own projects this is, for edits and removal.",
        ),
      description: z
        .string()
        .min(1)
        .max(PROJECT_DESCRIPTION_MAX_CHARS)
        .optional()
        .describe(
          `What the project is/does, in the member's own words (max ${PROJECT_DESCRIPTION_MAX_CHARS} ` +
            'characters). Required unless remove is true.',
        ),
      link: z
        .string()
        .max(PROJECT_LINK_MAX_CHARS)
        .optional()
        .describe(
          'Optional URL to the project. Stored and shown to other members as plain text, verbatim — ' +
            'the bot never fetches or previews it.',
        ),
      remove: z
        .boolean()
        .optional()
        .describe(
          "Set true to remove an existing project by name instead of adding/editing it — 'description' " +
            "and 'link' are ignored when true.",
        ),
      seekingCollaborators: z
        .boolean()
        .optional()
        .describe(
          'Set true if the caller wants help/collaborators on this project — shown to other members via ' +
            "list_projects. Defaults to false (showcase only). Only set this on the caller's own explicit " +
            'statement, e.g. "I\'m looking for help with this" — never inferred.',
        ),
    },
    handler: async (args, { caller }) => {
      // Guests can reach every other MEMBER_TOOLS write in open mode, but
      // publishing to a member-facing showcase is a step further than a
      // self-scoped, invisible-to-others action like set_response_style —
      // so this (and list_projects below) explicitly floor at 'member',
      // the first MEMBER_TOOLS handler to do so (issue #646 AC #7).
      assertAtLeast(caller.role, 'member', 'share_project');
      if (args.remove) {
        const removed = await removeMemberProject(caller.platform, caller.userId, args.name);
        return removed
          ? text(`Removed "${args.name}" from the project showcase.`)
          : text(`You don't have a shared project named "${args.name}".`, true);
      }
      if (!args.description) {
        return text('A description is required to share or edit a project.', true);
      }
      const result = await shareProject({
        platform: caller.platform,
        userId: caller.userId,
        name: args.name,
        description: args.description,
        link: args.link,
        seekingCollaborators: args.seekingCollaborators,
      });
      if (!result.ok) {
        return text(
          result.reason === 'cap'
            ? `You already have ${MEMBER_PROJECT_CAP} shared projects — remove one first (share_project ` +
                'with remove: true) before adding another.'
            : `You've already shared ${PROJECT_RATE_LIMIT_PER_DAY} new projects in the last 24 hours. ` +
                'Please wait before sharing another.',
          true,
        );
      }
      return text(
        result.created
          ? `Shared "${args.name}" — other members can find it with list_projects.`
          : `Updated "${args.name}".`,
      );
    },
  }),

  // Read-only counterpart to share_project — most-recent or embedding-
  // similarity search over member_projects only, same 'member' floor check.
  defineTool({
    name: 'list_projects',
    description:
      'Browse the member-declared project showcase — what other members have built and published with ' +
      'share_project. With no query, returns the most recently shared projects; with a query, returns ' +
      'the closest matches by meaning (e.g. "anyone working on a Discord bot?" or "RAG projects"). ' +
      'Results derive only from what members have explicitly shared — never from general chat. Links ' +
      'render as plain text and are never fetched.',
    minTier: 'member',
    readOnlyHint: true,
    schema: {
      query: z
        .string()
        .max(300)
        .optional()
        .describe(
          'Optional topic/keyword to search shared projects by meaning. Omit for the most recently ' +
            'shared projects.',
        ),
      seekingCollaborators: z
        .boolean()
        .optional()
        .describe('Only show projects whose owner is looking for collaborators. Omit or false to show all.'),
      mine: z
        .boolean()
        .optional()
        .describe(
          "Only show the caller's own shared projects — ignores query/seekingCollaborators when set. " +
            'Use this to find the exact name of one of your own projects before editing or removing it ' +
            'with share_project.',
        ),
    },
    handler: async (args, { caller }) => {
      assertAtLeast(caller.role, 'member', 'list_projects');
      if (args.mine) {
        const projects = await listOwnProjects(caller.platform, caller.userId);
        if (projects.length === 0) {
          return text("You haven't shared any projects yet.");
        }
        return text(await formatProjectResults(projects));
      }
      const opts = { seekingCollaboratorsOnly: args.seekingCollaborators };
      const projects = args.query
        ? await searchProjects(args.query, LIST_PROJECTS_DEFAULT_LIMIT, opts)
        : await listRecentProjects(LIST_PROJECTS_DEFAULT_LIMIT, opts);
      if (projects.length === 0) {
        return text(
          args.seekingCollaborators
            ? 'No projects are currently looking for collaborators.'
            : args.query
              ? 'No shared projects match that.'
              : 'No projects have been shared yet.',
        );
      }
      return text(await formatProjectResults(projects));
    },
  }),

  // The signal-to-action handoff for share_project's seekingCollaborators
  // flag (issue #840): looks up a project by id and sends its owner at most
  // one DM. Re-checks 'member' in the handler like share_project/find_helper
  // above, and is rate-capped on both the requester and the notified-owner
  // side (see repository.ts PROJECT_CONNECTION_REQUESTER_DAILY_LIMIT /
  // PROJECT_CONNECTION_OWNER_WEEKLY_LIMIT), same shape as find_helper. Unlike
  // find_helper this is not behind a feature flag — no new disclosure class,
  // and the DM is solicited (the owner explicitly opted this specific project
  // in via seekingCollaborators), a stronger consent basis than find_helper's
  // topic-match.
  defineTool({
    name: 'request_project_connection',
    description:
      'Ask to connect with a project owner who marked their project 🤝 looking for collaborators (via ' +
      "share_project's seekingCollaborators) — the action counterpart to that signal. Looks up the project " +
      'by the id shown in list_projects/who_is_into (e.g. 42 from "[#42]") and sends the owner AT MOST ONE ' +
      "direct message naming the caller and the project — never a broadcast, and never discloses the owner's " +
      `identity/handle back to the caller beyond what list_projects already showed. Capped to ` +
      `${PROJECT_CONNECTION_REQUESTER_DAILY_LIMIT} calls per rolling 24 hours. Refuses cleanly if the project ` +
      "isn't found, isn't seeking collaborators, or belongs to the caller.",
    minTier: 'member',
    readOnlyHint: false,
    schema: {
      projectId: z
        .number()
        .int()
        .positive()
        .describe(
          'The id of the project to request a connection for, as shown by list_projects (e.g. 42 from "[#42]").',
        ),
    },
    handler: async (args, { caller, adapterFor }) => {
      // Publishing to a member-facing showcase (share_project/list_projects)
      // floors at 'member', excluding open-mode guests — this reaches a
      // DIFFERENT member's DM, so it inherits the same floor.
      assertAtLeast(caller.role, 'member', 'request_project_connection');
      // Requester daily-cap check FIRST, before any project lookup — same
      // order-of-operations as find_helper's isFindHelperRequesterAtDailyCap
      // check (issue #729 AC #6 precedent).
      if (await isProjectConnectionRequesterAtDailyCap(caller.platform, caller.userId)) {
        return text(
          `You've hit today's connection-request limit (${PROJECT_CONNECTION_REQUESTER_DAILY_LIMIT}). ` +
            'Try again tomorrow.',
          true,
        );
      }
      const project = await getActiveProjectById(args.projectId);
      if (!project) {
        return text('No active project with that id.', true);
      }
      if (!project.seekingCollaborators) {
        return text('That project is not currently looking for collaborators.', true);
      }
      // Self-match structurally impossible: this check runs BEFORE any DB
      // write (issue #729's find_helper precedent for self-exclusion).
      if (project.platform === caller.platform && project.userId === caller.userId) {
        return text("You can't request to connect with your own project.", true);
      }
      const target = adapterFor(project.platform);
      if (!target) {
        return text("That project's owner can't be reached on this deployment right now.", true);
      }
      const claimed = await recordProjectConnectionIfUnderCap(
        project.platform,
        project.userId,
        caller.platform,
        caller.userId,
        project.id,
      );
      if (!claimed) {
        // Generic refusal — never discloses the owner's cap state, same
        // discipline as find_helper's "no one available" message.
        return text("That project's owner can't receive new connection requests right now.", true);
      }
      const requesterLabel = await resolveSanitizedLabel(caller.platform, caller.userId);
      // untrusted() quarantines the member-supplied project name before it
      // reaches a DIFFERENT member's DM (issue #840 SECURITY criterion) —
      // same discipline find_helper's topic field already uses.
      const message =
        `${requesterLabel} is interested in collaborating on ` +
        `${untrusted('project', project.name)} — reach out if you're able to.`;
      // Best-effort send, same fire-and-forget/WindowClosedError-queue shape
      // as find_helper/notifySuggestionResolved — a failed or queued send
      // still counts as "the one DM this call sends" (the connection-request
      // row above is already committed).
      await target.sendDirectMessage(project.userId, message).catch((err) => {
        if (err instanceof WindowClosedError && target.queueForWindowReopen) {
          target.queueForWindowReopen(project.userId, message, 'low');
          logger.warn(
            { userId: hashId(project.userId), platform: project.platform },
            "request_project_connection DM: recipient's window is closed, queued for reopen",
          );
          return;
        }
        logger.warn({ err, userId: hashId(project.userId) }, 'request_project_connection DM failed');
      });
      return text('Reached out to the project owner — hang tight.');
    },
  }),
];
