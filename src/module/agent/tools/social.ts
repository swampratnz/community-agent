import { z } from 'zod';
import { assertAtLeast } from '@swampratnz/agent-base/auth/tiers.js';
import { config } from '@swampratnz/agent-base/config.js';
import { logger, hashId } from '@swampratnz/agent-base/logger.js';
import type { Platform } from '@swampratnz/agent-base/platforms/types.js';
import { WindowClosedError } from '@swampratnz/agent-base/platforms/types.js';
import { untrustedEntryContent } from '@swampratnz/agent-base/agent/systemPrompt.js';
import {
  FIND_HELPER_REQUESTER_DAILY_LIMIT,
  FIND_HELPER_TOPIC_MAX_CHARS,
  FIND_HELPER_WEEKLY_LIMIT_PER_HELPER,
  findHelperCandidates,
  getActiveProjectById,
  getLanguagePreference,
  getPublishedInterestsForOwners,
  isFindHelperRequesterAtDailyCap,
  isProjectConnectionRequesterAtDailyCap,
  type LanguagePreference,
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
  SUGGESTION_RESOLUTION_ECHO_CHARS,
  text,
  untrusted,
} from './helpers.js';
import { notifyInterestsRemoved, notifyProjectRemoved } from './notify.js';
import { defineTool } from '@swampratnz/agent-base/agent/tools/types.js';

/** list_projects' row cap for both the no-query (recent) and query (similarity) paths. */
export const LIST_PROJECTS_DEFAULT_LIMIT = 8;

/**
 * who_is_into's no-query, no-published-row guidance — shared verbatim (issue
 * #1022) between the existing self-match fallback and the new `mine: true`
 * empty state, so a caller with no published interests sees byte-identical
 * wording regardless of which path told them.
 */
export const WHO_IS_INTO_NO_PROFILE_HINT =
  "You haven't published interests yet — call set_my_interests first, then who_is_into with no " +
  'topic will search using your own published interests.';

/**
 * `list_projects`' four bot-authored empty-state strings — the "one
 * function, two entry points" split `formatMyWarningsText`/
 * `formatMySubmissionsText`/`formatMyDataText` (`selfService.ts`) established
 * for #1077/#1030, applied here (issue #1105) so this tool's handler and its
 * `!projects`/`/projects` command mirrors (`commands.ts`, `slashCommands.ts`)
 * can never drift from each other or from this one source of truth. Every
 * branch below only swaps the surrounding prose — the rendered project rows
 * themselves (`formatProjectResults`) are member-authored free text and stay
 * untranslated, out of scope for this proposal.
 *
 * `'mine'`/`'none'` name `share_project` as the fix (issue #1118), mirroring
 * `WHO_IS_INTO_NO_PROFILE_HINT`'s "you have nothing yet" pattern below — both
 * are true dead ends without it, unlike `'seeking'`/`'query'`, which are "no
 * match for this filter" rather than "you have nothing", so they stay as-is.
 */
export function formatListProjectsEmptyText(
  kind: 'mine' | 'seeking' | 'query' | 'none',
  language: LanguagePreference,
): string {
  const mi = language === 'mi';
  switch (kind) {
    case 'mine':
      return mi
        ? 'Kāore anō koe kia tohatoha i tētahi kaupapa — karangahia te share_project ki te tāpiri i tētahi.'
        : "You haven't shared any projects yet — call share_project to add one.";
    case 'seeking':
      return mi
        ? 'Kāore he kaupapa e rapu hoa mahi ana i tēnei wā.'
        : 'No projects are currently looking for collaborators.';
    case 'query':
      return mi ? 'Kāore he kaupapa kua tohaina e ōrite ana ki tērā.' : 'No shared projects match that.';
    case 'none':
      return mi
        ? 'Kāore anō he kaupapa kua tohaina — karangahia te share_project ki te tāpiri i tētahi.'
        : 'No projects have been shared yet — call share_project to add one.';
  }
}

/**
 * `who_is_into`'s bot-authored empty-state/guidance strings, same shape as
 * `formatListProjectsEmptyText` above and shared with its `!whois`/`/whois`
 * command mirrors. `'noProfile'` is byte-identical to the standalone
 * `WHO_IS_INTO_NO_PROFILE_HINT` constant in English (kept exported above
 * since existing call sites reference it directly); this function is what
 * threads the caller's own `getLanguagePreference` result through it. The
 * Discord slash command's own differently-worded no-profile hint (it tells a
 * member to talk to the bot rather than call a tool by name) is NOT one of
 * these — it stays local to `slashCommands.ts`, since consolidating it here
 * would change its English wording, not just add a language branch.
 */
export function formatWhoIsIntoEmptyText(
  kind: 'noProfile' | 'query' | 'selfNoMatch',
  language: LanguagePreference,
): string {
  const mi = language === 'mi';
  switch (kind) {
    case 'noProfile':
      return mi
        ? 'Kāore anō koe kia whakaputa i ō hiahia, karangahia te set_my_interests i te tuatahi, kātahi, ' +
            'ki te kore he kaupapa e tohua ana ki a who_is_into, ka rapu mā ō hiahia kua whakaputaina.'
        : WHO_IS_INTO_NO_PROFILE_HINT;
    case 'query':
      return mi
        ? 'Kāore anō he mema kua whakaputa i ngā hiahia e ōrite ana ki tērā.'
        : 'No members have published interests matching that yet.';
    case 'selfNoMatch':
      return mi
        ? 'Kāore anō ētahi atu mema kua whakaputa i ngā hiahia e ōrite ana ki ōu.'
        : 'No other members have published interests matching yours yet.';
  }
}

/**
 * `set_helper_availability`'s four caller-facing reply strings (issue #1163),
 * same "language threaded as an explicit parameter" shape as
 * `formatAppealModerationText`/`formatRateAnswerText` (issue #1147) —
 * `weeklyLimit` is an unchanged interpolation in both languages, passed
 * through even for the branches that don't use it, matching
 * `formatRateAnswerText`'s precedent.
 */
export function formatSetHelperAvailabilityText(
  outcome: 'disabled' | 'noProfile' | 'optedIn' | 'optedOut',
  weeklyLimit: number,
  language: LanguagePreference,
): string {
  const mi = language === 'mi';
  switch (outcome) {
    case 'disabled':
      return mi
        ? 'Kāore i whakahohea te whakawhiti āwhina-ā-mema i tēnei tūmau.'
        : 'Peer-help handoff is not enabled on this server.';
    case 'noProfile':
      return mi
        ? 'Kāore anō koe kia whakaputa i ō hiahia — karangahia te set_my_interests i te tuatahi, kātahi ka ' +
            'taea e set_helper_availability te whakahohe i ngā whakamōhiotanga mō ngā kaupapa e ōrite ana ki ērā.'
        : "You don't have published interests yet — call set_my_interests first, then " +
            'set_helper_availability can turn on notifications for topics matching them.';
    case 'optedIn':
      return mi
        ? `Ka whakamōhiotia koe ināianei (kia ${weeklyLimit} noa ngā wā ia wiki) ina ōrite tētahi kaupapa ` +
            'find_helper a tētahi atu mema ki ō hiahia kua whakaputaina.'
        : `You'll now be notified (at most ${weeklyLimit} times a week) when ` +
            "another member's find_helper topic matches your published interests.";
    case 'optedOut':
      return mi
        ? 'Kāore koe e whakamōhiotia anō mō ngā tono find_helper.'
        : "You won't be notified for find_helper requests anymore.";
  }
}

/**
 * `find_helper`'s no-live-match fetch/render caps (issue #1178) — module-scope
 * constants, no new env var (a new knob would be an agent-base config-schema
 * change). FETCH pulls a few extra rows so the caller's own project(s) can be
 * filtered out before the LIMIT slice still leaves up to LIMIT results.
 */
export const FIND_HELPER_PROJECT_SUGGESTION_FETCH_LIMIT = 4;
export const FIND_HELPER_PROJECT_SUGGESTION_LIMIT = 2;

/**
 * `find_helper`'s four caller-facing reply strings (issue #1163). The two
 * DMs it sends to the MATCHED helper (not the caller) stay untranslated by
 * design — out of scope, per the issue's explicit carve-out for
 * member-to-member DM bodies. `dailyLimit` is an unchanged interpolation.
 *
 * Issue #1178: `noMatch` optionally accepts a pre-rendered `suggestionBlock`
 * (already-quarantined `formatProjectResults` output over seeking-
 * collaborators projects related to the caller's topic) and appends it after
 * an added bot-authored framing sentence. Omitting it (the common case today)
 * renders byte-identical to the pre-#1178 `noMatch` text — only the framing
 * sentence is bilingual; the appended project rows stay member-authored and
 * untranslated, same as `formatProjectResults`' other call sites.
 */
export function formatFindHelperText(
  outcome: 'disabled' | 'dailyCap' | 'matched' | 'noMatch',
  dailyLimit: number,
  language: LanguagePreference,
  suggestionBlock?: string,
): string {
  const mi = language === 'mi';
  switch (outcome) {
    case 'disabled':
      return mi
        ? 'Kāore i whakahohea te whakawhiti āwhina-ā-mema i tēnei tūmau.'
        : 'Peer-help handoff is not enabled on this server.';
    case 'dailyCap':
      return mi
        ? `Kua eke koe ki te tepe tono-āwhina o tēnei rā (${dailyLimit}). Whakamātauria anō āpōpō.`
        : `You've hit today's ask-for-help limit (${dailyLimit}). Try again tomorrow.`;
    case 'matched':
      return mi
        ? 'Kua whakapā atu ki tētahi tangata ka taea pea te āwhina — kia manawanui.'
        : 'Reached out to someone who may be able to help — hang tight.';
    case 'noMatch': {
      const base = mi
        ? 'Kāore he tangata e wātea ana hei āwhina i tērā i tēnei wā.'
        : 'No one available to help with that right now.';
      if (!suggestionBlock) return base;
      const framing = mi
        ? 'Engari, kei kōnei tētahi kaupapa e rapu hoa mahi ana mō tētahi mea e rite ana ki tērā:'
        : "but there's a project already looking for help with something similar:";
      return `${base} ${framing}\n\n${suggestionBlock}`;
    }
  }
}

/**
 * `share_project`'s write-time duplicate-content nudge (issue #1190), mirroring
 * `save_knowledge`'s own similarity check (`knowledgeAdmin.ts`). A high bar —
 * two members legitimately building similar-sounding tools must never be
 * blocked or discouraged from showcasing their own work, so this only ever
 * appends an informational note, never blocks the share. `PROJECT_DUPLICATE_SEARCH_LIMIT`
 * is the small, bounded `N` passed to `searchProjects` — only the top
 * non-self hit is ever compared against the threshold.
 */
export const PROJECT_DUPLICATE_SIMILARITY_THRESHOLD = 0.9;
export const PROJECT_DUPLICATE_SEARCH_LIMIT = 3;

/**
 * `share_project`'s eight caller-facing reply outcomes (issue #1163, `similar`
 * added by #1190). `name`/`limit` are unchanged interpolations, threaded
 * through as discriminated union fields — same shape
 * `formatReportContentText`/`formatSuggestImprovementText` use for an outcome
 * that carries data.
 *
 * `similar` (issue #1190) is appended after the plain `created` line rather
 * than replacing it — a near-duplicate share is never blocked, only flagged,
 * mirroring `save_knowledge`'s own write-time similarity nudge
 * (`knowledgeAdmin.ts`). `matchName` is rendered through `untrustedEntryContent`
 * because it is ANOTHER member's stored project name reaching the caller's
 * reply — the same quarantine `formatProjectResults` applies to every project
 * name it renders — so a crafted name can't escape this sentence or forge
 * additional reply content. `matchOwner` arrives pre-sanitized (the caller
 * resolves it via `resolveSanitizedLabel` before constructing this outcome,
 * same convention as `find_helper`'s `requesterLabel`).
 */
export function formatShareProjectText(
  outcome:
    | { kind: 'missingDescription' }
    | { kind: 'cap'; limit: number }
    | { kind: 'rateLimit'; limit: number }
    | { kind: 'removed'; name: string }
    | { kind: 'notFound'; name: string }
    | { kind: 'created'; name: string }
    | { kind: 'updated'; name: string }
    | { kind: 'similar'; name: string; matchId: number; matchName: string; matchOwner: string },
  language: LanguagePreference,
): string {
  const mi = language === 'mi';
  switch (outcome.kind) {
    case 'missingDescription':
      return mi
        ? 'Me whai whakaahuatanga hei tohatoha, hei whakatika rānei i tētahi kaupapa.'
        : 'A description is required to share or edit a project.';
    case 'cap':
      return mi
        ? `Kua ${outcome.limit} ō kaupapa kua tohaina kētia — tangohia tētahi i te tuatahi (share_project me ` +
            `te remove: true) i mua i te tāpiri i tētahi atu.`
        : `You already have ${outcome.limit} shared projects — remove one first (share_project ` +
            'with remove: true) before adding another.';
    case 'rateLimit':
      return mi
        ? `Kua tohaina kētia e koe ${outcome.limit} ngā kaupapa hou i roto i ngā haora 24 kua hipa. Tēnā koa, ` +
            'tatari i mua i te tohatoha i tētahi atu.'
        : `You've already shared ${outcome.limit} new projects in the last 24 hours. ` +
            'Please wait before sharing another.';
    case 'removed':
      return mi
        ? `Kua tangohia a "${outcome.name}" mai i te whakaaturanga kaupapa.`
        : `Removed "${outcome.name}" from the project showcase.`;
    case 'notFound':
      return mi
        ? `Kāore āu kaupapa kua tohaina e kīia ana ko "${outcome.name}".`
        : `You don't have a shared project named "${outcome.name}".`;
    case 'created':
      return mi
        ? `Kua tohaina a "${outcome.name}" — ka kitea e ētahi atu mema mā te list_projects.`
        : `Shared "${outcome.name}" — other members can find it with list_projects.`;
    case 'updated':
      return mi ? `Kua whakahoutia a "${outcome.name}".` : `Updated "${outcome.name}".`;
    case 'similar': {
      const matchName = untrustedEntryContent(outcome.matchName);
      return mi
        ? `Kua tohaina a "${outcome.name}" — ka kitea e ētahi atu mema mā te list_projects. Tuhinga: he rite ` +
            `tēnei ki te kaupapa #${outcome.matchId} "${matchName}" a ${outcome.matchOwner} — tirohia te ` +
            'list_projects, whakamahia rānei te request_project_connection mēnā he pai ake te mahi tahi.'
        : `Shared "${outcome.name}" — other members can find it with list_projects. Note: this looks similar ` +
            `to #${outcome.matchId} "${matchName}" by ${outcome.matchOwner} — check list_projects, or ` +
            "request_project_connection if you'd rather team up.";
    }
  }
}

/**
 * `request_project_connection`'s seven caller-facing reply outcomes (issue
 * #1163). The DM to the PROJECT OWNER stays untranslated by design — out of
 * scope, same carve-out as `find_helper`'s match notification. `limit` is an
 * unchanged interpolation on the one outcome that carries it, mirroring
 * `formatRateAnswerText`'s mixed bare-literal/object union shape.
 */
export function formatRequestProjectConnectionText(
  outcome:
    | 'notFound'
    | 'notSeeking'
    | 'selfMatch'
    | 'ownerUnreachable'
    | 'ownerCapped'
    | 'sent'
    | { kind: 'dailyCap'; limit: number },
  language: LanguagePreference,
): string {
  const mi = language === 'mi';
  if (typeof outcome !== 'string') {
    return mi
      ? `Kua eke koe ki te tepe tono-hononga o tēnei rā (${outcome.limit}). Whakamātauria anō āpōpō.`
      : `You've hit today's connection-request limit (${outcome.limit}). ` + 'Try again tomorrow.';
  }
  switch (outcome) {
    case 'notFound':
      return mi
        ? 'Kāore he kaupapa e mahi ana e whai ana i taua tuhinga (id).'
        : 'No active project with that id.';
    case 'notSeeking':
      return mi
        ? 'Kāore taua kaupapa e rapu hoa mahi ana i tēnei wā.'
        : 'That project is not currently looking for collaborators.';
    case 'selfMatch':
      return mi
        ? 'Kāore e taea e koe te tono hononga ki tō ake kaupapa.'
        : "You can't request to connect with your own project.";
    case 'ownerUnreachable':
      return mi
        ? 'Kāore e taea te whakapā atu ki te rangatira o taua kaupapa i tēnei whakatakotoranga i tēnei wā.'
        : "That project's owner can't be reached on this deployment right now.";
    case 'ownerCapped':
      return mi
        ? 'Kāore e taea e te rangatira o taua kaupapa te whiwhi tono hononga hou i tēnei wā.'
        : "That project's owner can't receive new connection requests right now.";
    case 'sent':
      return mi
        ? 'Kua whakapā atu ki te rangatira o te kaupapa — kia manawanui.'
        : 'Reached out to the project owner — hang tight.';
  }
}

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
      mine: z
        .boolean()
        .optional()
        .describe(
          "Only show the caller's own published interests text — ignores query when set. Use this to " +
            'check what is currently published before calling set_my_interests to update or clear it.',
        ),
    },
    handler: async (args, { caller }) => {
      assertAtLeast(caller.role, 'member', 'who_is_into');
      // Checked before the query/self-match branches below (issue #1022,
      // mirroring list_projects' mine handling): self-scoped by the caller's
      // OWN identity, never a tool-argument-supplied identifier, and ignores
      // any query passed alongside it rather than falling through to the
      // public search path.
      if (args.mine) {
        const interestsByOwner = await getPublishedInterestsForOwners([
          { platform: caller.platform, userId: caller.userId },
        ]);
        const own = interestsByOwner.get(`${caller.platform}:${caller.userId}`);
        if (!own) {
          const language = await getLanguagePreference(caller.platform, caller.userId);
          return text(formatWhoIsIntoEmptyText('noProfile', language));
        }
        return text(
          await formatInterestResults([{ platform: caller.platform, userId: caller.userId, interests: own }]),
        );
      }
      if (args.query) {
        const hits = await searchMemberInterests(args.query, WHO_IS_INTO_LIMIT);
        if (hits.length === 0) {
          const language = await getLanguagePreference(caller.platform, caller.userId);
          return text(formatWhoIsIntoEmptyText('query', language));
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
        const language = await getLanguagePreference(caller.platform, caller.userId);
        const hint = formatWhoIsIntoEmptyText('noProfile', language);
        const recent = await listRecentInterests(WHO_IS_INTO_LIMIT);
        return text(recent.length === 0 ? hint : `${await formatInterestResults(recent)}\n\n${hint}`);
      }
      if (selfMatch.hits.length === 0) {
        const language = await getLanguagePreference(caller.platform, caller.userId);
        return text(formatWhoIsIntoEmptyText('selfNoMatch', language));
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
        const language = await getLanguagePreference(caller.platform, caller.userId);
        return text(
          formatSetHelperAvailabilityText('disabled', FIND_HELPER_WEEKLY_LIMIT_PER_HELPER, language),
          true,
        );
      }
      const result = await setHelperAvailability(caller.platform, caller.userId, args.available);
      if (!result.ok) {
        const language = await getLanguagePreference(caller.platform, caller.userId);
        return text(
          formatSetHelperAvailabilityText('noProfile', FIND_HELPER_WEEKLY_LIMIT_PER_HELPER, language),
          true,
        );
      }
      const language = await getLanguagePreference(caller.platform, caller.userId);
      return text(
        formatSetHelperAvailabilityText(
          args.available ? 'optedIn' : 'optedOut',
          FIND_HELPER_WEEKLY_LIMIT_PER_HELPER,
          language,
        ),
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
        const language = await getLanguagePreference(caller.platform, caller.userId);
        return text(formatFindHelperText('disabled', FIND_HELPER_REQUESTER_DAILY_LIMIT, language), true);
      }
      if (await isFindHelperRequesterAtDailyCap(caller.platform, caller.userId)) {
        const language = await getLanguagePreference(caller.platform, caller.userId);
        return text(formatFindHelperText('dailyCap', FIND_HELPER_REQUESTER_DAILY_LIMIT, language), true);
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
        const language = await getLanguagePreference(caller.platform, caller.userId);
        return text(formatFindHelperText('matched', FIND_HELPER_REQUESTER_DAILY_LIMIT, language));
      }
      // Issue #1178: no live person matched — before giving up, check
      // list_projects' own seeking-collaborators search for a related
      // project. Read + render only (searchProjects/formatProjectResults are
      // both already side-effect-free), so this adds no DM, no notification
      // row, and no new disclosure — the same data list_projects already
      // shows every member. Self-exclusion runs BEFORE the LIMIT slice so a
      // caller's own project can never consume a suggestion slot.
      const suggestionCandidates = await searchProjects(
        args.topic,
        FIND_HELPER_PROJECT_SUGGESTION_FETCH_LIMIT,
        {
          seekingCollaboratorsOnly: true,
        },
      );
      const suggestions = suggestionCandidates
        .filter((p) => !(p.platform === caller.platform && p.userId === caller.userId))
        .slice(0, FIND_HELPER_PROJECT_SUGGESTION_LIMIT);
      const suggestionBlock = suggestions.length > 0 ? await formatProjectResults(suggestions) : undefined;
      const language = await getLanguagePreference(caller.platform, caller.userId);
      return text(
        formatFindHelperText('noMatch', FIND_HELPER_REQUESTER_DAILY_LIMIT, language, suggestionBlock),
      );
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
        const language = await getLanguagePreference(caller.platform, caller.userId);
        return removed
          ? text(formatShareProjectText({ kind: 'removed', name: args.name }, language))
          : text(formatShareProjectText({ kind: 'notFound', name: args.name }, language), true);
      }
      if (!args.description) {
        const language = await getLanguagePreference(caller.platform, caller.userId);
        return text(formatShareProjectText({ kind: 'missingDescription' }, language), true);
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
        const language = await getLanguagePreference(caller.platform, caller.userId);
        return text(
          formatShareProjectText(
            result.reason === 'cap'
              ? { kind: 'cap', limit: MEMBER_PROJECT_CAP }
              : { kind: 'rateLimit', limit: PROJECT_RATE_LIMIT_PER_DAY },
            language,
          ),
          true,
        );
      }
      const language = await getLanguagePreference(caller.platform, caller.userId);
      if (result.created) {
        // Issue #1190: write-time duplicate-content nudge, only on a
        // brand-new share (never `updated`/`removed`/a cap-or-rate-limit
        // refusal above, which return earlier) — mirroring save_knowledge's
        // own similarity check. Self-exclusion (by platform+userId+name)
        // runs BEFORE the threshold comparison, mirroring find_helper's own
        // pre-slice self-filter above, so the project just created can never
        // be reported as its own match. `hits` is already similarity-ordered
        // (searchProjects, same as list_projects' query path), so the first
        // non-self hit IS the top match.
        const hits = await searchProjects(args.description, PROJECT_DUPLICATE_SEARCH_LIMIT);
        const match = hits.find(
          (p) => !(p.platform === caller.platform && p.userId === caller.userId && p.name === args.name),
        );
        if (match && match.similarity >= PROJECT_DUPLICATE_SIMILARITY_THRESHOLD) {
          const matchOwner = await resolveSanitizedLabel(match.platform, match.userId);
          return text(
            formatShareProjectText(
              { kind: 'similar', name: args.name, matchId: match.id, matchName: match.name, matchOwner },
              language,
            ),
          );
        }
      }
      return text(
        formatShareProjectText(
          result.created ? { kind: 'created', name: args.name } : { kind: 'updated', name: args.name },
          language,
        ),
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
          const language = await getLanguagePreference(caller.platform, caller.userId);
          return text(formatListProjectsEmptyText('mine', language));
        }
        return text(await formatProjectResults(projects));
      }
      const opts = { seekingCollaboratorsOnly: args.seekingCollaborators };
      const projects = args.query
        ? await searchProjects(args.query, LIST_PROJECTS_DEFAULT_LIMIT, opts)
        : await listRecentProjects(LIST_PROJECTS_DEFAULT_LIMIT, opts);
      if (projects.length === 0) {
        const language = await getLanguagePreference(caller.platform, caller.userId);
        return text(
          formatListProjectsEmptyText(
            args.seekingCollaborators ? 'seeking' : args.query ? 'query' : 'none',
            language,
          ),
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
        const language = await getLanguagePreference(caller.platform, caller.userId);
        return text(
          formatRequestProjectConnectionText(
            { kind: 'dailyCap', limit: PROJECT_CONNECTION_REQUESTER_DAILY_LIMIT },
            language,
          ),
          true,
        );
      }
      const project = await getActiveProjectById(args.projectId);
      if (!project) {
        const language = await getLanguagePreference(caller.platform, caller.userId);
        return text(formatRequestProjectConnectionText('notFound', language), true);
      }
      if (!project.seekingCollaborators) {
        const language = await getLanguagePreference(caller.platform, caller.userId);
        return text(formatRequestProjectConnectionText('notSeeking', language), true);
      }
      // Self-match structurally impossible: this check runs BEFORE any DB
      // write (issue #729's find_helper precedent for self-exclusion).
      if (project.platform === caller.platform && project.userId === caller.userId) {
        const language = await getLanguagePreference(caller.platform, caller.userId);
        return text(formatRequestProjectConnectionText('selfMatch', language), true);
      }
      const target = adapterFor(project.platform);
      if (!target) {
        const language = await getLanguagePreference(caller.platform, caller.userId);
        return text(formatRequestProjectConnectionText('ownerUnreachable', language), true);
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
        const language = await getLanguagePreference(caller.platform, caller.userId);
        return text(formatRequestProjectConnectionText('ownerCapped', language), true);
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
      const language = await getLanguagePreference(caller.platform, caller.userId);
      return text(formatRequestProjectConnectionText('sent', language));
    },
  }),

  // Admin-moderation counterpart to share_project's self-service removal
  // (issue #1185) — the project showcase was the one member-authored,
  // community-wide-visible content surface with no admin removal lever.
  // CONFIRM-gated + audited(), identical shape to delete_knowledge; reuses
  // the two repository functions request_project_connection above already
  // imports (getActiveProjectById/removeMemberProject), now with the
  // ADMIN-resolved owner instead of caller — zero new schema, zero new
  // repository export.
  defineTool({
    name: 'remove_project',
    description:
      'Remove a project from the community project showcase, regardless of who owns it — the ' +
      "admin-moderation counterpart to share_project's self-service removal (which only the owner can do), " +
      "for a scam link, harassment in a description, spam, or an uncooperative/blocked member's entry. Looks " +
      'up the project by the id shown in list_projects/who_is_into (e.g. 42 from "[#42]"). Optional reason ' +
      `(max ${SUGGESTION_RESOLUTION_ECHO_CHARS} characters) sends the project's original owner a one-line ` +
      'resolution DM; omit it to remove silently (e.g. for spam/abuse where alerting the actor is ' +
      'undesirable). Requires confirmation. Admin only.',
    minTier: 'admin',
    readOnlyHint: false,
    schema: {
      projectId: z
        .number()
        .int()
        .positive()
        .describe(
          'The id of the project to remove, as shown by list_projects/who_is_into (e.g. 42 from "[#42]").',
        ),
      reason: z
        .string()
        .max(SUGGESTION_RESOLUTION_ECHO_CHARS)
        .optional()
        .describe(
          "Optional, one-line, member-facing explanation sent to the project's original owner as a " +
            'resolution DM — omit to remove the project silently, with no notification. Never persisted.',
        ),
    },
    handler: async (args, { caller, requireConfirm, audited, adapterFor }) => {
      assertAtLeast(caller.role, 'admin', 'remove_project');
      return requireConfirm(`remove project #${args.projectId} from the showcase`, 'admin', async () => {
        // Resolved inside run() so a failed/unknown lookup never produces a
        // successful audited() row, and so the owner is never trusted from
        // anything but this admin-tier repository read.
        const state: { owner: { platform: Platform; userId: string; name: string } | null } = { owner: null };
        const { success, result } = await audited({
          actionKind: 'remove_project',
          // reason is deliberately excluded — it only ever reaches the one DM
          // below, same non-persistence convention as resolve_report's.
          params: { projectId: args.projectId },
          run: async () => {
            const project = await getActiveProjectById(args.projectId);
            if (!project) throw new Error(`No project with id ${args.projectId}.`);
            const removed = await removeMemberProject(project.platform, project.userId, project.name);
            if (!removed) throw new Error(`No project with id ${args.projectId}.`);
            state.owner = { platform: project.platform, userId: project.userId, name: project.name };
            return `removed "${project.name}"`;
          },
        });
        // Best-effort, same fire-and-forget/WindowClosedError-queue shape as
        // notifyReportResolved — only sent when the admin supplied a reason;
        // omitting one keeps the removal silent (useful for spam/abuse).
        if (success && state.owner && args.reason) {
          const target = adapterFor(state.owner.platform);
          if (target) {
            await notifyProjectRemoved(
              target,
              state.owner.userId,
              state.owner.platform,
              undefined,
              args.reason,
            );
          }
        }
        return success
          ? `Removed project #${args.projectId} ("${state.owner?.name}") from the showcase.`
          : `Failed: ${result}`;
      });
    },
  }),

  // Admin-moderation counterpart to set_my_interests' self-service 'clear'
  // (issue #1230) — member_interests was the OTHER member-authored,
  // community-wide-visible content surface with no admin removal lever after
  // remove_project closed the gap for member_projects. Unlike remove_project
  // (which looks a row up by numeric id), member_interests is one row per
  // (platform, user_id) with no id to reference, so this mirrors the
  // moderation-tool family's shape instead (clear_warnings/block_user: a bare
  // targetUserId scoped to caller.platform, no separate platform argument) —
  // this is content moderation against an identity already in view (from a
  // report, or from reading who_is_into), not a cross-platform account
  // operation like the four membership tools. CONFIRM-gated + audited(),
  // same shape as remove_project/delete_knowledge. Calls the exact same
  // exported function set_my_interests('clear') already calls
  // (setMemberInterests), just with an admin-resolved target instead of the
  // caller — zero new repository export, zero schema change, zero migration.
  defineTool({
    name: 'remove_interests',
    description:
      "Clear a member's published interests (set via set_my_interests), regardless of who published them — " +
      "the admin-moderation counterpart to set_my_interests' self-service 'clear' (which only the member " +
      "themselves can do), for a scam link, harassment, or spam string in someone's who_is_into-discoverable " +
      "interests text. Scoped to a single platform user id on the caller's own platform — no separate " +
      'platform argument, same shape as clear_warnings/block_user. Reports plainly (not an error) if the ' +
      `target has no published interests to clear. Optional reason (max ${SUGGESTION_RESOLUTION_ECHO_CHARS} ` +
      'characters) sends the target a one-line resolution DM; omit it to clear silently (e.g. for spam/abuse ' +
      'where alerting the actor is undesirable). Never echoes the removed interests text back — not in the ' +
      'confirmation, not in the audit log. Requires confirmation. Admin only.',
    minTier: 'admin',
    readOnlyHint: false,
    schema: {
      targetUserId: z
        .string()
        .describe(
          "Platform user id whose published interests to clear, on the caller's own platform (same identity " +
            'shape as clear_warnings/block_user — no separate platform argument).',
        ),
      reason: z
        .string()
        .max(SUGGESTION_RESOLUTION_ECHO_CHARS)
        .optional()
        .describe(
          'Optional, one-line, member-facing explanation sent to the target as a resolution DM — omit to ' +
            'clear silently, with no notification. Never persisted.',
        ),
    },
    handler: async (args, { caller, requireConfirm, audited, adapterFor }) => {
      assertAtLeast(caller.role, 'admin', 'remove_interests');
      return requireConfirm(`clear published interests for ${args.targetUserId}`, 'admin', async () => {
        // Resolved inside run() so a no-op clear never produces a
        // notification, and so `hadInterests` is never trusted from anything
        // but this admin-tier repository read's own return value.
        // setMemberInterests('clear') unconditionally DELETEs and always
        // reports { cleared: true } regardless of whether a row existed
        // (the same behaviour set_my_interests('clear') already relies on),
        // so whether there was anything to remove is checked FIRST via
        // getPublishedInterestsForOwners — only its Map membership is read,
        // never the interests text value it carries (SECURITY: the removed
        // text must never re-enter this flow).
        const state = { hadInterests: false };
        const { success, result } = await audited({
          actionKind: 'remove_interests',
          targetUserId: args.targetUserId,
          // reason is deliberately excluded — it only ever reaches the one DM
          // below, same non-persistence convention as remove_project's. The
          // removed interests text itself is never captured anywhere in this
          // flow — only checked for existence, never read — so there is
          // nothing to accidentally include here.
          params: { targetUserId: args.targetUserId },
          run: async () => {
            const before = await getPublishedInterestsForOwners([
              { platform: caller.platform, userId: args.targetUserId },
            ]);
            const hadInterests = before.has(`${caller.platform}:${args.targetUserId}`);
            await setMemberInterests(caller.platform, args.targetUserId, 'clear');
            state.hadInterests = hadInterests;
            return hadInterests
              ? `cleared published interests for ${args.targetUserId}`
              : `${args.targetUserId} has no published interests to remove`;
          },
        });
        // Best-effort, same fire-and-forget/WindowClosedError-queue shape as
        // notifyProjectRemoved — only sent when the admin supplied a reason
        // AND something was actually cleared; omitting a reason keeps the
        // removal silent (useful for spam/abuse), and a no-op clear has
        // nothing to notify about.
        if (success && state.hadInterests && args.reason) {
          const target = adapterFor(caller.platform);
          if (target) {
            await notifyInterestsRemoved(target, args.targetUserId, caller.platform, undefined, args.reason);
          }
        }
        if (!success) return `Failed: ${result}`;
        return state.hadInterests
          ? `Cleared published interests for ${args.targetUserId}.`
          : `${args.targetUserId} has no published interests to remove.`;
      });
    },
  }),
];
