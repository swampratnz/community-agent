import { atLeast } from '@swampratnz/agent-base/auth/rbac.js';
import { config } from '@swampratnz/agent-base/config.js';
import {
  countActiveWarnings,
  countRepliesToUser,
  getLanguagePreference,
  getMyDataSummary,
  getPublishedInterestsForOwners,
  listKnowledge,
  listKnowledgeTopics,
  listOwnAppeals,
  listOwnKnowledgeCandidates,
  listOwnProjectConnectionRequests,
  listOwnReports,
  listOwnSuggestions,
  listRecentProjects,
} from '@swampratnz/agent-base/storage/repository.js';
import {
  formatCommunityInfoText,
  formatInterestResults,
  formatKnowledgeTopics,
  formatMostHelpfulKnowledge,
  formatProjectResults,
  LIST_PROJECTS_DEFAULT_LIMIT,
  MOST_HELPFUL_KNOWLEDGE_FETCH_CAP,
  rankKnowledgeByRetrieval,
  WHO_IS_INTO_NO_PROFILE_HINT,
} from './agent/tools.js';
import { buildMemberDigestContent } from './memberDigest.js';
import {
  formatMyDataText,
  formatMySubmissionsText,
  formatMyWarningsText,
} from './agent/tools/selfService.js';
import { TEXT_COMMAND_UNMATCHED, type RegisteredCommand } from '@swampratnz/agent-base/commands/registry.js';
import { formatStatusMessage, getStatusCache } from './status/anthropicStatus.js';

/**
 * The community command registry (agent-base plan §3 `commands` row): ONE
 * ordered list of `{ name, platforms, handler }` entries consumed by BOTH
 * command surfaces — Discord slash registration/dispatch
 * (`platforms/discord/slashCommands.ts`) and the router's WhatsApp
 * `!`-text-command intercept (`router.ts`, via the registered list in
 * `commands/registry.ts`). Handlers were moved VERBATIM from their previous
 * homes; registry order is the previous `buildSlashCommands()` order (kb,
 * projects, whois, guidelines, digest), with `events` (issue #1004),
 * `status` (issue #995), `warnings` (issue #1000), `mysubmissions`/`mydata`
 * (issue #1018), `help` (issue #993), `kbtopics` (issue #1036), and
 * `kbhelpful` (issue #1087) appended — also safe for the WhatsApp side
 * because every `!` matcher is anchored and mutually exclusive.
 *
 * The Discord halves are BOUND by `bindCommunitySlashCommands()`
 * (slashCommands.ts), which `createConfiguredAdapters()` calls — never at
 * module load, because binding reads the command list and `createAgent`
 * registers that list from the manifest only when index.ts's BODY runs, long
 * after the static import graph has been evaluated. Binding at load threw
 * `registeredCommands: no command list registered` and killed startup.
 * Defining them there rather than inline also keeps this file — loaded by the
 * composition root on every platform — from pulling discord.js into the
 * runtime graph; only its types.
 *
 * Since the mechanism/content split (plan §Phase-2 Stage 3a) the sentinel,
 * the handler/binding/command types and the registration slot live in
 * `commands/registry.ts`; this file is the community side and registers
 * `COMMUNITY_COMMANDS` there at its own module scope (`registerCommands`
 * below), the same self-registration shape as `strings/notices.ts`.
 */

export const COMMUNITY_COMMANDS: readonly RegisteredCommand[] = [
  { name: 'kb', platforms: ['discord'] },
  // Discord-only, same shape as 'kb' above — Discord Scheduled Events have no
  // WhatsApp equivalent, matching the list_events tool itself (issue #1004).
  { name: 'events', platforms: ['discord'] },
  {
    name: 'projects',
    platforms: ['discord', 'whatsapp'],
    whatsapp: async (text, msg, role, deps) => {
      // Checked BEFORE the general `!projects [query]` branch below so the
      // literal word "mine" is never swallowed as a `searchProjectsFn` query
      // (issue #916) — mirrors `list_projects({ mine: true })`'s own ignore-
      // query-when-mine behaviour rather than blending the two.
      if (/^!projects\s+mine$/i.test(text)) {
        if (!atLeast(role, 'member')) return null;
        const projects = await deps.listOwnProjectsFn(msg.platform, msg.userId);
        return projects.length === 0
          ? "You haven't shared any projects yet."
          : await formatProjectResults(projects);
      }

      // Same anchoring discipline as `mine` above (issue #1046 SECURITY
      // criteria 3-4): checked BEFORE the general query regex so the literal
      // word "seeking" is never swallowed as a searchProjectsFn query, and
      // `!projects seeking <anything>` falls through instead of matching.
      // Calls listRecentProjects directly (not deps.listRecentProjectsFn) —
      // that dependency's type is agent-base's fixed, zero-opts
      // WhatsAppTextCommandDeps shape and cannot carry seekingCollaboratorsOnly
      // through, the same constraint `digest` above already hit and solved
      // the same way.
      if (/^!projects\s+seeking$/i.test(text)) {
        if (!atLeast(role, 'member')) return null;
        const opts = { seekingCollaboratorsOnly: true };
        const projects = await listRecentProjects(LIST_PROJECTS_DEFAULT_LIMIT, opts);
        return projects.length === 0
          ? 'No projects are currently looking for collaborators.'
          : await formatProjectResults(projects);
      }

      const projectsMatch = /^!projects(?:\s+(.+))?$/i.exec(text);
      if (!projectsMatch) return TEXT_COMMAND_UNMATCHED;
      if (!atLeast(role, 'member')) return null;
      const query = projectsMatch[1]?.trim();
      const projects = query
        ? await deps.searchProjectsFn(query, LIST_PROJECTS_DEFAULT_LIMIT)
        : await deps.listRecentProjectsFn(LIST_PROJECTS_DEFAULT_LIMIT);
      return projects.length === 0
        ? query
          ? 'No shared projects match that.'
          : 'No projects have been shared yet.'
        : await formatProjectResults(projects);
    },
  },
  {
    name: 'whois',
    platforms: ['discord', 'whatsapp'],
    whatsapp: async (text, msg, role, deps) => {
      // Checked BEFORE the general `!whois [query]` branch below so the
      // literal word "mine" is never swallowed as a `searchMemberInterestsFn`
      // query (issue #1048) — mirrors `!projects mine`'s (issue #916)
      // ordering discipline and `who_is_into({ mine: true })`'s own
      // ignore-query-when-mine behaviour rather than blending the two.
      // Calls getPublishedInterestsForOwners directly (not via deps) — that
      // dependency isn't part of agent-base's fixed, zero-opts
      // WhatsAppTextCommandDeps shape, the same constraint `!projects seeking`
      // (issue #1046) hit and solved the same way. This mirrors
      // handleWhois's Discord `mine` branch (slashCommands.ts) byte-for-byte.
      if (/^!whois\s+mine$/i.test(text)) {
        if (!atLeast(role, 'member')) return null;
        const interestsByOwner = await getPublishedInterestsForOwners([
          { platform: msg.platform, userId: msg.userId },
        ]);
        const own = interestsByOwner.get(`${msg.platform}:${msg.userId}`);
        return own
          ? await formatInterestResults([{ platform: msg.platform, userId: msg.userId, interests: own }])
          : WHO_IS_INTO_NO_PROFILE_HINT;
      }

      const whoisMatch = /^!whois(?:\s+(.+))?$/i.exec(text);
      if (!whoisMatch) return TEXT_COMMAND_UNMATCHED;
      if (!atLeast(role, 'member')) return null;
      const query = whoisMatch[1]?.trim();
      if (query) {
        const hits = await deps.searchMemberInterestsFn(query);
        return hits.length === 0
          ? 'No members have published interests matching that yet.'
          : await formatInterestResults(hits);
      }
      // Bare `!whois` (issue #889): mirror who_is_into's/`/whois`'s own
      // no-argument self-match — the implicit query is the caller's own
      // already-stored `member_interests` embedding, keyed on
      // `msg.platform`/`msg.userId` only, never re-embedded and never
      // sourced from the surrounding message text (SECURITY: #634 AC #4 /
      // #882's "never inferred from chat content" invariant).
      const selfMatch = await deps.searchMemberInterestsForSelfFn(msg.platform, msg.userId);
      if (!selfMatch.hasProfile) {
        // Issue #920: same no-profile browse fallback as who_is_into's chat
        // path and /whois — a separate call site, wired independently via
        // the injected listRecentInterestsFn.
        const hint =
          "You haven't published interests yet — call set_my_interests first, then who_is_into with no " +
          'topic will search using your own published interests.';
        const recent = await deps.listRecentInterestsFn();
        return recent.length === 0 ? hint : `${await formatInterestResults(recent)}\n\n${hint}`;
      }
      return selfMatch.hits.length === 0
        ? 'No members have published interests matching that yet.'
        : await formatInterestResults(selfMatch.hits);
    },
  },
  {
    name: 'guidelines',
    platforms: ['discord', 'whatsapp'],
    whatsapp: async (text, msg, _role, deps) => {
      if (!/^!guidelines$/i.test(text)) return TEXT_COMMAND_UNMATCHED;
      const languagePreference = await deps.getLangPref(msg.platform, msg.userId);
      const guidelines =
        languagePreference === 'mi'
          ? ((await deps.getLocalisedConductGuidelinesFn()) ?? (await deps.getConductGuidelinesFn()))
          : await deps.getConductGuidelinesFn();
      return guidelines ?? 'No community guidelines have been set yet — ask an admin.';
    },
  },
  {
    name: 'digest',
    platforms: ['discord', 'whatsapp'],
    whatsapp: async (text, msg, role, deps) => {
      if (!/^!digest$/i.test(text)) return TEXT_COMMAND_UNMATCHED;
      if (!atLeast(role, 'member')) return null;
      // deps.buildDigestContentFn (agent-base's WhatsAppTextCommandDeps) is
      // fixed zero-arg — base owns that type, so it cannot carry the caller's
      // identity through to buildMemberDigestContent for localisation
      // (issue #1042). It stays the default/English-preference path (same
      // DI-tested call as before); a standing 'mi' preference calls
      // buildMemberDigestContent directly instead, exactly as /digest and
      // community_digest already do, so its rendering is real (DB-backed)
      // rather than the deps-stubbed fixture.
      const language = await deps.getLangPref(msg.platform, msg.userId);
      const message =
        language === 'mi'
          ? await buildMemberDigestContent(undefined, { platform: msg.platform, userId: msg.userId })
          : await deps.buildDigestContentFn();
      return message ?? 'Nothing to report right now.';
    },
  },
  {
    // No tier gate — mirrors `guidelines` above: `check_status` reveals
    // nothing about this community, only Anthropic's own public status page,
    // so it must never be gated tighter than the tool it fronts (issue #995).
    name: 'status',
    platforms: ['discord', 'whatsapp'],
    whatsapp: async (text) => {
      if (!/^!status$/i.test(text)) return TEXT_COMMAND_UNMATCHED;
      return formatStatusMessage(getStatusCache(), Date.now());
    },
  },
  {
    // Anchored, argument-rejecting matcher (issue #1000 SECURITY criterion
    // 6): `!warnings anything` falls through to TEXT_COMMAND_UNMATCHED rather
    // than matching, so no message-supplied identifier can ever reach
    // countActiveWarnings — the identity passed below is always the
    // adapter-resolved (msg.platform, msg.userId).
    name: 'warnings',
    platforms: ['discord', 'whatsapp'],
    whatsapp: async (text, msg, role, deps) => {
      if (!/^!warnings$/i.test(text)) return TEXT_COMMAND_UNMATCHED;
      if (!atLeast(role, 'member')) return null;
      const limit = config.moderation.strikeLimit;
      const windowDays = config.moderation.strikeWindowDays;
      const active = await countActiveWarnings(msg.platform, msg.userId);
      const windowed =
        active > 0 && active < limit && windowDays
          ? await countActiveWarnings(msg.platform, msg.userId, windowDays)
          : null;
      const language = await deps.getLangPref(msg.platform, msg.userId);
      return formatMyWarningsText(active, limit, windowed, language);
    },
  },
  {
    // Anchored, argument-rejecting matcher, same discipline as `warnings`
    // above (issue #1018 SECURITY criterion 5): `!mysubmissions anything`
    // falls through to TEXT_COMMAND_UNMATCHED rather than matching, so no
    // message-supplied identifier can ever reach the self-scoped listOwn*
    // reads — the identity passed below is always the adapter-resolved
    // (msg.platform, msg.userId).
    name: 'mysubmissions',
    platforms: ['discord', 'whatsapp'],
    whatsapp: async (text, msg, role, deps) => {
      if (!/^!mysubmissions$/i.test(text)) return TEXT_COMMAND_UNMATCHED;
      if (!atLeast(role, 'member')) return null;
      const [suggestions, reports, appeals, knowledgeTips, connectionRequests, language] = await Promise.all([
        listOwnSuggestions(msg.platform, msg.userId, 10),
        listOwnReports(msg.platform, msg.userId, 10),
        listOwnAppeals(msg.platform, msg.userId, 10),
        listOwnKnowledgeCandidates(msg.platform, msg.userId, 10),
        listOwnProjectConnectionRequests(msg.platform, msg.userId, 10),
        deps.getLangPref(msg.platform, msg.userId),
      ]);
      return formatMySubmissionsText(
        suggestions,
        reports,
        appeals,
        knowledgeTips,
        connectionRequests,
        language,
      );
    },
  },
  {
    // Anchored, argument-rejecting matcher, same discipline as `warnings`/
    // `mysubmissions` above (issue #1018 SECURITY criterion 5).
    name: 'mydata',
    platforms: ['discord', 'whatsapp'],
    whatsapp: async (text, msg, role) => {
      if (!/^!mydata$/i.test(text)) return TEXT_COMMAND_UNMATCHED;
      if (!atLeast(role, 'member')) return null;
      const summary = await getMyDataSummary(msg.platform, msg.userId);
      const limit = config.behaviour.dailyReplyLimitPerUser;
      const used =
        role !== 'super_admin' && limit !== 0 ? await countRepliesToUser(msg.platform, msg.userId) : null;
      const language = await getLanguagePreference(msg.platform, msg.userId);
      return formatMyDataText(summary, role, limit, used, language);
    },
  },
  {
    name: 'help',
    platforms: ['discord', 'whatsapp'],
    // No tier gate, matching community_info's own `minTier: 'member'` floor
    // (a guest-reachable member-floor tool, same reasoning as `guidelines`
    // above) — formatCommunityInfoText branches its own content on `role`
    // (and, since issue #1028, on the caller's own stored language
    // preference), so the caller's actual tier is what determines what comes
    // back, not a dispatch-time gate here.
    whatsapp: async (text, msg, role) => {
      if (!/^!help$/i.test(text)) return TEXT_COMMAND_UNMATCHED;
      return await formatCommunityInfoText(role, msg.platform, msg.userId);
    },
  },
  {
    // Anchored, argument-rejecting matcher, same discipline as `warnings`/
    // `mysubmissions`/`mydata` above (issue #1036 SECURITY criterion 3):
    // `!kbtopics anything` falls through to TEXT_COMMAND_UNMATCHED rather
    // than matching, so no message-supplied text can ever reach the scope
    // predicate — the conversationId passed below is always the
    // adapter-resolved (msg.platform, msg.conversationId), never parsed
    // from `text`.
    name: 'kbtopics',
    platforms: ['discord', 'whatsapp'],
    whatsapp: async (text, msg, role) => {
      if (!/^!kbtopics$/i.test(text)) return TEXT_COMMAND_UNMATCHED;
      if (!atLeast(role, 'member')) return null;
      const { titles, totalCount } = await listKnowledgeTopics(
        { platform: msg.platform, conversationId: msg.conversationId },
        config.behaviour.knowledgeTopicsListLimit,
      );
      return formatKnowledgeTopics(titles, totalCount);
    },
  },
  {
    // Anchored, argument-rejecting matcher, same discipline as `kbtopics`
    // above (issue #1087 SECURITY criterion 2): `!kbhelpful anything` falls
    // through to TEXT_COMMAND_UNMATCHED rather than matching, so no message-
    // supplied text can ever reach the query. Unlike `kbtopics`, the read
    // itself is never scoped by the caller's platform/conversation —
    // `most_helpful_knowledge` (issue #1070) hardcodes `scope: 'global'`
    // (that tool's own SECURITY comment: a member can never request a
    // narrower scope), and this shortcut reuses that exact
    // listKnowledge → rankKnowledgeByRetrieval → formatMostHelpfulKnowledge
    // path, never a wider or differently-scoped query (issue #1087 SECURITY
    // criterion 4), always the tool's own fixed default of 10 (no
    // caller-supplied limit, issue #1087 acceptance criterion 1).
    name: 'kbhelpful',
    platforms: ['discord', 'whatsapp'],
    whatsapp: async (text, _msg, role) => {
      if (!/^!kbhelpful$/i.test(text)) return TEXT_COMMAND_UNMATCHED;
      if (!atLeast(role, 'member')) return null;
      const entries = await listKnowledge({
        scope: 'global',
        offset: 0,
        limit: MOST_HELPFUL_KNOWLEDGE_FETCH_CAP,
      });
      const ranked = rankKnowledgeByRetrieval(entries, 10);
      return formatMostHelpfulKnowledge(ranked);
    },
  },
];

// Registration is the manifest's job now (src/module/agentModule.ts):
// `createAgent` hands this list to `commands/registry.ts` before a turn can
// run, and both command surfaces read it back from there. The base mechanism
// still fails loud if nothing ever registered.
