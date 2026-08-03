import { z } from 'zod';
import { assertAtLeast } from '../../../base/auth/tiers.js';
import { formatNzEventTime } from '../../../base/util/nzTime.js';
import { isoInstantSchema, parseIsoInstant, text } from './helpers.js';
import { defineTool } from '../../../base/agent/tools/types.js';

/**
 * create_event (issue #230) Discord Scheduled Event field bounds — Discord's
 * own hard limits (name/description/location length), enforced at the zod
 * schema boundary same as the create_poll bounds above:
 * https://discord.com/developers/docs/resources/guild-scheduled-event.
 */
export const EVENT_NAME_MAX_CHARS = 100;
export const EVENT_DESCRIPTION_MAX_CHARS = 1000;
export const EVENT_LOCATION_MAX_CHARS = 100;

/**
 * cancel_event's audit-only `reason` (issue #424) has no Discord field to
 * bound it against — same shape as report_content's `reason`, so the same
 * 500-char cap.
 */
export const EVENT_CANCEL_REASON_MAX_CHARS = 500;

export const eventsTools = [
  // Discord Scheduled Event creation (issue #230) — outward + member-
  // notifying (RSVP/reminders), so admin-tier + CONFIRM, a genuinely higher
  // floor than announce/create_poll. See docs/SECURITY.md.
  defineTool({
    name: 'create_event',
    description:
      "Create a real Discord Scheduled Event (shows in the server's Events tab with RSVP + reminders) for a " +
      'meetup — much higher signal than a text announcement that scrolls away. Discord only. Admin only; ' +
      'requires confirmation, since it is an outward artifact that notifies the whole server. startTime/' +
      'endTime must be concrete, resolved ISO 8601 timestamps — resolve relative phrases like "next Tuesday ' +
      '7pm" against the current NZ date yourself first; never pass relative or ambiguous text.',
    minTier: 'admin',
    platforms: ['discord'],
    requiresCapability: 'create_event',
    readOnlyHint: false,
    schema: {
      name: z.string().min(1).max(EVENT_NAME_MAX_CHARS).describe('Event name/title'),
      startTime: isoInstantSchema(
        'Concrete ISO 8601 start instant with an explicit offset or "Z", e.g. "2026-07-14T19:00:00+12:00" ' +
          '(NZ = Pacific/Auckland). Must be in the future.',
      ),
      endTime: isoInstantSchema(
        'Concrete ISO 8601 end instant, same format as startTime. Optional for a channel-hosted event; ' +
          'required for an external/physical location.',
      ).optional(),
      description: z
        .string()
        .max(EVENT_DESCRIPTION_MAX_CHARS)
        .optional()
        .describe('Event description, shown on the event page'),
      location: z
        .string()
        .min(1)
        .max(EVENT_LOCATION_MAX_CHARS)
        .describe(
          'Either a physical/external location (e.g. "Wellington Central Library") or the id of a Discord ' +
            'voice/stage channel the bot can see, for an online meetup.',
        ),
    },
    handler: async (args, { caller, adapter, requireConfirm, audited }) => {
      assertAtLeast(caller.role, 'admin', 'create_event');
      if (!adapter.adminCapabilities.has('create_event')) {
        return text(`This platform (${adapter.platform}) does not support scheduled events.`, true);
      }
      // Format validity is a zod schema boundary (isoInstantSchema); the
      // future/ordering checks are cross-field and depend on wall-clock time,
      // so they run here, before ever registering a CONFIRM — same discipline
      // as assign_community_role's pre-checks (issue #232).
      const start = parseIsoInstant(args.startTime)!;
      if (start.getTime() <= Date.now()) {
        return text('Refusing: startTime must be in the future.', true);
      }
      if (args.endTime) {
        const end = parseIsoInstant(args.endTime)!;
        if (end.getTime() <= start.getTime()) {
          return text('Refusing: endTime must be after startTime.', true);
        }
      }
      const params = {
        name: args.name,
        description: args.description ?? '',
        startTime: args.startTime,
        endTime: args.endTime,
        location: args.location,
      };
      // CONFIRM text quotes every salient mutated field — name, start time,
      // location, and a truncated description (binding acceptance criterion
      // from the adversarial verdict on #230, sharpened by review on the PR:
      // location/description are just as outward-facing as name/startTime, so
      // the human must see them too before confirming). requireConfirm strips
      // the newline/angle-bracket forgery class from the whole description at
      // its choke point (the 2026-07-28 audit N2 generalisation of #227), so
      // these fields reach the human as the actual values minus those chars —
      // NOT byte-for-byte verbatim — and the human still confirms the real
      // artifact rather than model-composed prose. Same truncation pattern as
      // delete_member_note's note preview.
      const descPreview = args.description
        ? ` ("${args.description.slice(0, 80)}${args.description.length > 80 ? '…' : ''}")`
        : '';
      return requireConfirm(
        `create event "${args.name}" starting ${args.startTime} at "${args.location}"${descPreview}`,
        'admin',
        async () => {
          const { success, result } = await audited({
            actionKind: 'create_event',
            params,
            run: () => adapter.performAdminAction({ kind: 'create_event', params }),
          });
          return success ? `Done: ${result}` : `Failed: ${result}`;
        },
      );
    },
  }),

  // Symmetric destroy-adjacent counterpart to create_event (issue #424),
  // same pattern create_poll/end_poll and create_thread/archive_thread
  // already established: admin-tier + CONFIRM, marks the event Canceled
  // rather than deleting it. See docs/SECURITY.md.
  defineTool({
    name: 'cancel_event',
    description:
      'Cancel a Discord Scheduled Event created via create_event: marks it Canceled (stays visible, ' +
      "struck-through, RSVP history intact) rather than deleting it — Discord's own UI convention for a " +
      'meetup that fell through. CONFIRM required. Discord only, admin only. Only a Scheduled event can be ' +
      'canceled — an event that is already Active, Completed, or Canceled is refused.',
    minTier: 'admin',
    platforms: ['discord'],
    requiresCapability: 'cancel_event',
    readOnlyHint: false,
    schema: {
      eventId: z.string().describe("The scheduled event's id (see list_events)"),
      reason: z
        .string()
        .max(EVENT_CANCEL_REASON_MAX_CHARS)
        .optional()
        .describe(
          `Optional note for the audit log (Discord has no public cancellation-reason field), max ` +
            `${EVENT_CANCEL_REASON_MAX_CHARS} characters`,
        ),
    },
    handler: async (args, { caller, adapter, requireConfirm, audited }) => {
      assertAtLeast(caller.role, 'admin', 'cancel_event');
      if (!adapter.adminCapabilities.has('cancel_event') || !adapter.getScheduledEvent) {
        return text(`This platform (${adapter.platform}) does not support scheduled events.`, true);
      }
      // Target validation live from Discord, not the DB (scheduled events
      // aren't tracked in `interactions`) — same "the bot must be able to
      // verify what it's acting on" discipline as isKnownConversation/
      // isKnownMessage, before a CONFIRM is ever registered (issue #424).
      const event = await adapter.getScheduledEvent(args.eventId);
      if (!event) {
        return text(`Refusing: scheduled event "${args.eventId}" was not found in this guild.`, true);
      }
      if (event.status !== 'scheduled') {
        return text(
          `Refusing: event "${event.name}" is currently ${event.status}, not scheduled — only a scheduled ` +
            'event can be canceled.',
          true,
        );
      }
      const params = { eventId: args.eventId, reason: args.reason };
      // CONFIRM text quotes the resolved event name + start time verbatim,
      // same discipline as create_event's own CONFIRM prompt — the human
      // confirms the actual artifact, not model-composed prose.
      return requireConfirm(
        `cancel event "${event.name}" starting ${formatNzEventTime(event.scheduledStartAt)}` +
          `${args.reason ? ` (reason: ${args.reason})` : ''}`,
        'admin',
        async () => {
          const { success, result } = await audited({
            actionKind: 'cancel_event',
            params,
            run: () => adapter.performAdminAction({ kind: 'cancel_event', params }),
          });
          return success ? `Done: ${result}` : `Failed: ${result}`;
        },
      );
    },
  }),
];
