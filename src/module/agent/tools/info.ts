import { atLeast } from '@swampratnz/agent-base/auth/tiers.js';
import type { Tier } from '@swampratnz/agent-base/auth/tiers.js';
import type { Platform } from '@swampratnz/agent-base/platforms/types.js';
import { config } from '@swampratnz/agent-base/config.js';
import { getCommunityGuidelines, getCommunityGuidelinesMi } from '../../storage/policies.js';
import { getLanguagePreference } from '@swampratnz/agent-base/storage/repository.js';
import { formatStatusMessage, getStatusCache } from '../../status/anthropicStatus.js';
import { formatEventTime } from '@swampratnz/agent-base/util/eventTime.js';
import type { UpcomingEvent } from '@swampratnz/agent-base/platforms/types.js';
import { text } from './helpers.js';
import { notice } from '../../strings/notices.js';
import { defineTool } from '@swampratnz/agent-base/agent/tools/types.js';

/**
 * Fixed-literal rundown of the WhatsApp `!`-prefixed text-command shortcuts
 * (issue #859), appended to the `communityInfoMemberCapabilities` notice text
 * only for a WhatsApp caller when `config.behaviour.whatsappTextCommandsEnabled`
 * is true (issue #872) — Discord already gets free discovery via its native
 * `/` picker (`SlashCommandBuilder.setDescription`,
 * `src/platforms/discord/slashCommands.ts`), which WhatsApp has no
 * client-native equivalent of. No `!kb`: the existing KNOWLEDGE_SHORTCUT_ENABLED
 * shortcut already covers WhatsApp for that one (#859's own decision). `!kbtopics`
 * (issue #1036) was added here by issue #1044, closing a gap where it shipped
 * without ever being added to this list. Never interpolates caller or message
 * data — same trust level as the member capabilities notice, and (unlike it,
 * and unlike the admin/super-admin segments as of issue #1056) English-only —
 * out of scope for this constant; a WhatsApp `!kbtopics`-style `mi` variant
 * is separate follow-up territory (issue #1034), not duplicated here.
 */
const WHATSAPP_TEXT_COMMANDS_TEXT =
  "You're on WhatsApp, so you can also use these zero-wait shortcuts:\n" +
  '- `!whois <topic>` — find members into a topic\n' +
  '- `!projects [query]` — browse the project showcase\n' +
  '- `!guidelines` — community guidelines\n' +
  "- `!digest` — this week's digest\n" +
  '- `!status` — check for a known Anthropic outage\n' +
  '- `!kbtopics` — browse what the knowledge base covers\n' +
  '- `!warnings` — your own active warning count\n' +
  '- `!mysubmissions` — status of your filed suggestions/reports\n' +
  '- `!mydata` — what the bot has stored about you\n' +
  '- `!help` — this capability rundown';

/**
 * Fixed cap on how many upcoming events `list_events` returns (issue #388) —
 * a small hardcoded constant over a config knob, matching this repo's
 * existing convention for tool-shape limits (e.g. `GATED_NOTICE_MAX_ADMIN_NAMES`).
 */
export const EVENTS_LIST_LIMIT = 10;

/**
 * Pure-in-shape formatter behind `community_info` AND the `/help`/`!help`
 * commands (issue #993) — factored out so the tool handler and both command
 * entry points render byte-identical text for the same (role, platform,
 * language), rather than each re-deriving the role/platform branching (or
 * the language lookup) independently. Async since issue #1028: the member
 * segment now honours the caller's standing `language_preference` (the same
 * `getLanguagePreference` accessor `community_guidelines` uses), read ONCE
 * here rather than at each of the three call sites, so the DB read and the
 * variant-selection logic exist in exactly one place. Issue #1056 extended
 * that same `language` value to the admin/super-admin segments (previously
 * unconditionally English), closing the mid-message language mix #1028 left
 * for any admin/super-admin caller with a standing `'mi'` preference. Depends
 * only on its
 * arguments plus `config.behaviour.whatsappTextCommandsEnabled` (the same
 * flag the tool handler already read) and the caller's own stored language
 * preference — never on message content, and never on a language belonging
 * to anyone but `(platform, userId)` itself.
 */
export async function formatCommunityInfoText(
  role: Tier,
  platform: Platform,
  userId: string,
): Promise<string> {
  const language = await getLanguagePreference(platform, userId);
  const memberCapabilitiesText = notice('communityInfoMemberCapabilities', { language });
  const memberSegment =
    platform === 'whatsapp' && config.behaviour.whatsappTextCommandsEnabled && atLeast(role, 'member')
      ? `${memberCapabilitiesText}\n${WHATSAPP_TEXT_COMMANDS_TEXT}`
      : memberCapabilitiesText;
  if (role === 'super_admin') {
    const adminCapabilitiesText = notice('communityInfoAdminCapabilities', { language });
    const superAdminCapabilitiesText = notice('communityInfoSuperAdminCapabilities', { language });
    return `${memberSegment}\n${adminCapabilitiesText}\n${superAdminCapabilitiesText}`;
  }
  if (role === 'admin') {
    return `${memberSegment}\n${notice('communityInfoAdminCapabilities', { language })}`;
  }
  return memberSegment;
}

/**
 * Pure render of `listUpcomingEvents`' rows into `list_events`' reply text —
 * hoisted out of the tool handler (issue #1004) so the `/events` slash
 * command can call the exact same formatting, mirroring how
 * `formatProjectResults`/`formatInterestResults` were hoisted out of
 * `agent/tools.ts`'s tool-factory closure for the same reason. Caller must
 * handle the empty-list case ("No upcoming events.") itself, matching the
 * tool handler below.
 */
export function formatUpcomingEvents(events: readonly UpcomingEvent[]): string {
  return events
    .map((e) => {
      const when = e.scheduledEndAt
        ? `${formatEventTime(e.scheduledStartAt)} – ${formatEventTime(e.scheduledEndAt)}`
        : formatEventTime(e.scheduledStartAt);
      const desc = e.description ? `: ${e.description}` : '';
      return `- ${e.name} (${when}) @ ${e.location}${desc} [id: ${e.id}]`;
    })
    .join('\n');
}

export const infoTools = [
  defineTool({
    name: 'community_info',
    description:
      'Tell the caller, in concrete terms, what they can ask this bot to do. Call this whenever someone ' +
      'asks "what can you do?", "how do I report someone?", or otherwise wants a capability rundown — ' +
      'do not answer that from general knowledge alone.',
    minTier: 'member',
    readOnlyHint: true,
    schema: {},
    handler: async (_args, { caller }) =>
      text(await formatCommunityInfoText(caller.role, caller.platform, caller.userId)),
  }),

  // Read-only, no arguments; returns the admin-set guidelines text verbatim,
  // or a clear not-set-yet message (issue #212).
  defineTool({
    name: 'community_guidelines',
    description:
      "Return this community's guidelines/rules, exactly as an admin set them. Call this whenever someone " +
      'asks "what are the rules?", "what am I not allowed to do?", or wants to know why they were warned ' +
      'or muted. Relay the returned text to the caller verbatim — do not summarise, paraphrase, or add to it.',
    minTier: 'member',
    readOnlyHint: true,
    schema: {},
    handler: async (_args, { caller }) => {
      const languagePreference = await getLanguagePreference(caller.platform, caller.userId);
      const guidelines =
        languagePreference === 'mi'
          ? ((await getCommunityGuidelinesMi()) ?? (await getCommunityGuidelines()))
          : await getCommunityGuidelines();
      return text(guidelines ?? 'No community guidelines have been set yet — ask an admin.');
    },
  }),

  // Read-only, no arguments, reveals nothing about this community — only
  // Anthropic's own public status page (issue #206) — so it's reachable by
  // guests in open mode too, same tier as community_info/knowledge_search.
  defineTool({
    name: 'check_status',
    description:
      'Check whether Anthropic has a known service incident right now — call this when a member reports an ' +
      "error, timeout, or unexpected behaviour from Claude/the API and wants to know if it's a known Anthropic " +
      "problem rather than something on their end. Read-only, no arguments, sourced from Anthropic's own public " +
      'status page (a background poll, never a live fetch on this call).',
    minTier: 'member',
    readOnlyHint: true,
    schema: {},
    handler: async () => text(formatStatusMessage(getStatusCache(), Date.now())),
  }),

  // Read-only, no arguments, no CONFIRM (issue #388) — the read counterpart
  // to the admin-tier, CONFIRM-gated create_event (issue #230). Publicly
  // visible via Discord's own Events tab the moment create_event runs, so
  // there's no confidentiality boundary to gate at admin tier, same
  // reasoning as community_guidelines/check_status. Discord-only; other
  // adapters simply don't implement PlatformAdapter.listUpcomingEvents.
  defineTool({
    name: 'list_events',
    description:
      'List upcoming Discord scheduled meetups/events (id, name, start/end time, location) — call this when ' +
      'someone asks "what\'s coming up?", "when\'s the next meetup?", or similar, instead of guessing from ' +
      'general knowledge or stale knowledge-base entries. Also the only way to discover a valid eventId for ' +
      'cancel_event. Read-only, no arguments, sourced live from ' +
      "Discord's own Scheduled Events (the read counterpart to create_event). Discord-only.",
    minTier: 'member',
    platforms: ['discord'],
    requiresCapability: 'list_events',
    readOnlyHint: true,
    schema: {},
    handler: async (_args, { caller, adapter }) => {
      if (!adapter.listUpcomingEvents) {
        return text(`Event listings aren't available on ${caller.platform}.`, true);
      }
      const events = await adapter.listUpcomingEvents(EVENTS_LIST_LIMIT);
      if (events.length === 0) return text('No upcoming events.');
      return text(formatUpcomingEvents(events));
    },
  }),
];
