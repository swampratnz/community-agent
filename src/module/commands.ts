import { atLeast } from '@swampratnz/agent-base/auth/rbac.js';
import {
  formatCommunityInfoText,
  formatInterestResults,
  formatProjectResults,
  LIST_PROJECTS_DEFAULT_LIMIT,
} from './agent/tools.js';
import { TEXT_COMMAND_UNMATCHED, type RegisteredCommand } from '@swampratnz/agent-base/commands/registry.js';

/**
 * The community command registry (agent-base plan §3 `commands` row): ONE
 * ordered list of `{ name, platforms, handler }` entries consumed by BOTH
 * command surfaces — Discord slash registration/dispatch
 * (`platforms/discord/slashCommands.ts`) and the router's WhatsApp
 * `!`-text-command intercept (`router.ts`, via the registered list in
 * `commands/registry.ts`). Handlers were moved VERBATIM from their previous
 * homes; registry order is the previous `buildSlashCommands()` order (kb,
 * projects, whois, guidelines, digest), plus `help` appended at the end
 * (issue #993) — also safe for the WhatsApp side because every `!` matcher
 * is anchored and mutually exclusive.
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
    whatsapp: async (text, _msg, role, deps) => {
      if (!/^!digest$/i.test(text)) return TEXT_COMMAND_UNMATCHED;
      if (!atLeast(role, 'member')) return null;
      const message = await deps.buildDigestContentFn();
      return message ?? 'Nothing to report right now.';
    },
  },
  {
    name: 'help',
    platforms: ['discord', 'whatsapp'],
    // No tier gate, matching community_info's own `minTier: 'member'` floor
    // (a guest-reachable member-floor tool, same reasoning as `guidelines`
    // above) — formatCommunityInfoText branches its own content on `role`,
    // so the caller's actual tier is what determines what comes back, not a
    // dispatch-time gate here.
    whatsapp: async (text, msg, role) => {
      if (!/^!help$/i.test(text)) return TEXT_COMMAND_UNMATCHED;
      return formatCommunityInfoText(role, msg.platform);
    },
  },
];

// Registration is the manifest's job now (src/module/agentModule.ts):
// `createAgent` hands this list to `commands/registry.ts` before a turn can
// run, and both command surfaces read it back from there. The base mechanism
// still fails loud if nothing ever registered.
