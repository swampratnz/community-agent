import { z } from 'zod';
import { assertAtLeast } from '../../auth/rbac.js';
import { config } from '../../config.js';
import { makeSlidingWindowReserver } from '../../util/rateReservation.js';
import { isKnownConversation, isKnownMessage } from '../../storage/repository.js';
import { text, unreachableConversationRefusal } from './helpers.js';
import { defineTool } from './types.js';

/**
 * create_poll (issue #228) bounds — the Discord Poll API's own hard limits
 * (question/answer length, answer count, duration), enforced here so a
 * malformed request fails at our zod schema boundary instead of a late
 * Discord API error: https://discord.com/developers/docs/resources/poll.
 */
export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 10;
export const POLL_QUESTION_MAX_CHARS = 300;
export const POLL_OPTION_MAX_CHARS = 55;
export const POLL_MIN_DURATION_HOURS = 1;
export const POLL_MAX_DURATION_HOURS = 32 * 24;
export const POLL_DEFAULT_DURATION_HOURS = 24;

/**
 * Per-conversation cap on new polls within a rolling hour. `create_poll` is
 * an outward-posting, announce-class action (same abuse surface as
 * `announce`); the adversarial review for #228 called for a per-window cap
 * rather than CONFIRM-gating, since a poll is lower-consequence than an
 * announcement and `announce` itself isn't CONFIRM-gated either.
 */
export const POLL_RATE_LIMIT_PER_HOUR = 5;

/**
 * Per-conversation cap on `end_poll` within a rolling hour (PR #272 review).
 * `end_poll` has the same admin-tier/scope/capability guards as `create_poll`
 * but ends (rather than posts) a poll, so it needs its own cap for the same
 * threat: an injected/hijacked admin turn should not be able to end every live
 * poll in scope unthrottled. Kept slightly higher than the create cap because a
 * legitimate admin more plausibly closes several polls than posts several.
 */
export const POLL_END_RATE_LIMIT_PER_HOUR = 10;

/** create_thread (issue #229) bound — Discord's own hard limit on a thread's name. */
export const THREAD_NAME_MAX_CHARS = 100;

/**
 * Per-channel cap on new threads within a rolling hour, same additive/
 * rate-capped-not-CONFIRM-gated treatment as `create_poll` (issue #228) — the
 * adversarial review for #229 agreed `create_thread` is additive and can be
 * ungated with a per-window cap, unlike `archive_thread` (CONFIRM-gated, it
 * hides an active discussion).
 */
export const THREAD_CREATE_RATE_LIMIT_PER_HOUR = 5;

/**
 * Per-conversation cap on `announce` within a rolling hour (issue #315).
 * `announce` was the only one of the four residual-risk levers named in
 * `docs/SECURITY.md` with zero throttle, despite being the *higher*-
 * consequence sibling of `create_poll` (the #228 code comment already treats
 * them as the same abuse surface). Same value as `POLL_RATE_LIMIT_PER_HOUR`.
 */
export const ANNOUNCE_RATE_LIMIT_PER_HOUR = 5;

/**
 * Reserve one create_poll slot for `conversationId` against a rolling
 * hourly cap (POLL_RATE_LIMIT_PER_HOUR; sliding window, unlike
 * reserveImageGenDaily's calendar-day bucket — a 1-hour cap doesn't align
 * to midnight). Returns false without reserving if the conversation already
 * hit `limit` within the last hour.
 */
const reservePollSlot = makeSlidingWindowReserver(60 * 60 * 1000);

/**
 * Reserve one `end_poll` slot for `conversationId`
 * (POLL_END_RATE_LIMIT_PER_HOUR) — same sliding-hour shape as
 * `reservePollSlot`, but a SEPARATE window so ending polls neither consumes
 * nor is blocked by the create_poll budget (PR #272 review).
 */
const reservePollEndSlot = makeSlidingWindowReserver(60 * 60 * 1000);

/**
 * Reserve one create_thread slot for the parent channel against a rolling
 * hourly cap (THREAD_CREATE_RATE_LIMIT_PER_HOUR), same sliding-window shape
 * as `reservePollSlot`. Returns false without reserving if the channel
 * already hit `limit` within the last hour.
 */
const reserveThreadSlot = makeSlidingWindowReserver(60 * 60 * 1000);

/**
 * Reserve one announce slot for `conversationId` against a rolling hourly
 * cap (ANNOUNCE_RATE_LIMIT_PER_HOUR), same sliding-window shape as
 * `reservePollSlot`. Returns false without reserving if the conversation
 * already hit `limit` within the last hour.
 */
const reserveAnnounceSlot = makeSlidingWindowReserver(60 * 60 * 1000);

export const broadcastTools = [
  defineTool({
    name: 'announce',
    description:
      'Post an announcement to a conversation. Admins can only announce in conversations they are in.',
    minTier: 'admin',
    readOnlyHint: false,
    schema: {
      message: z.string().describe('The announcement text'),
      conversationId: z
        .string()
        .optional()
        .describe('Target channel/conversation id; defaults to the current one'),
    },
    handler: async (args, { caller, adapter, callerScope, audited }) => {
      assertAtLeast(caller.role, 'admin', 'announce');
      const target = args.conversationId ?? caller.conversationId;
      const allowed = await callerScope();
      if (allowed && !allowed.includes(target)) {
        return text(`Refusing: you are not a participant of conversation "${target}".`, true);
      }
      if (
        target !== caller.conversationId &&
        !(await isKnownConversation(caller.platform, target)) &&
        !(await adapter.canPostTo?.(target))
      ) {
        return text(unreachableConversationRefusal(target), true);
      }
      if (!reserveAnnounceSlot(target, ANNOUNCE_RATE_LIMIT_PER_HOUR)) {
        return text(
          `Refusing: conversation "${target}" already hit the announce limit (${ANNOUNCE_RATE_LIMIT_PER_HOUR}/hour) — try again later.`,
          true,
        );
      }
      const { success, result } = await audited({
        actionKind: 'announce',
        conversationId: target,
        params: { message: args.message },
        run: async () => {
          await adapter.sendMessage({ conversationId: target, text: args.message });
          return 'sent';
        },
      });
      return text(success ? `Announcement posted to ${target}.` : `Failed: ${result}`, !success);
    },
  }),

  defineTool({
    name: 'create_poll',
    description:
      'Post a native Discord poll to gauge interest (e.g. meetup dates, topic preferences) — a structured ' +
      'vote with a visible tally and duration, unlike a reaction straw poll. Discord only. Admins can only ' +
      'post in conversations they are in. Set multiChoice to let voters pick more than one option. NOTE: ' +
      'Discord polls cannot be edited after posting — the question, options, duration, and single-vs-multi ' +
      'choice setting are fixed at creation. To change a poll, end it (end_poll) and post a new one; the new ' +
      "poll starts with zero votes (the old poll's votes cannot be carried over).",
    minTier: 'admin',
    platforms: ['discord'],
    readOnlyHint: false,
    schema: {
      question: z.string().max(POLL_QUESTION_MAX_CHARS).describe('The poll question'),
      options: z
        .array(z.string().max(POLL_OPTION_MAX_CHARS))
        .min(POLL_MIN_OPTIONS)
        .max(POLL_MAX_OPTIONS)
        .describe(
          `${POLL_MIN_OPTIONS}-${POLL_MAX_OPTIONS} answer options, each up to ${POLL_OPTION_MAX_CHARS} characters`,
        ),
      multiChoice: z
        .boolean()
        .optional()
        .describe(
          'Allow selecting more than one option (default: single choice). Fixed at creation — cannot be changed later.',
        ),
      durationHours: z
        .number()
        .min(POLL_MIN_DURATION_HOURS)
        .max(POLL_MAX_DURATION_HOURS)
        .optional()
        .describe(
          `Poll duration in hours (${POLL_MIN_DURATION_HOURS}-${POLL_MAX_DURATION_HOURS}, default ${POLL_DEFAULT_DURATION_HOURS})`,
        ),
      conversationId: z
        .string()
        .optional()
        .describe('Target channel/conversation id; defaults to the current one'),
    },
    handler: async (args, { caller, adapter, callerScope, audited }) => {
      assertAtLeast(caller.role, 'admin', 'create_poll');
      if (!adapter.adminCapabilities.has('create_poll')) {
        return text(`This platform (${adapter.platform}) does not support polls.`, true);
      }
      const target = args.conversationId ?? caller.conversationId;
      const allowed = await callerScope();
      if (allowed && !allowed.includes(target)) {
        return text(`Refusing: you are not a participant of conversation "${target}".`, true);
      }
      if (
        target !== caller.conversationId &&
        !(await isKnownConversation(caller.platform, target)) &&
        !(await adapter.canPostTo?.(target))
      ) {
        return text(unreachableConversationRefusal(target), true);
      }
      if (!reservePollSlot(target, POLL_RATE_LIMIT_PER_HOUR)) {
        return text(
          `Refusing: conversation "${target}" already hit the poll limit (${POLL_RATE_LIMIT_PER_HOUR}/hour) — try again later.`,
          true,
        );
      }
      // Range is enforced at the zod schema boundary above; only truncate to
      // whole hours here (the schema permits fractional values in-range).
      const duration = Math.trunc(args.durationHours ?? POLL_DEFAULT_DURATION_HOURS);
      const params = {
        question: args.question,
        options: args.options,
        durationHours: duration,
        multiChoice: args.multiChoice ?? false,
      };
      const { success, result } = await audited({
        actionKind: 'create_poll',
        conversationId: target,
        params,
        run: () =>
          adapter.performAdminAction({
            kind: 'create_poll',
            conversationId: target,
            params,
          }),
      });
      return text(success ? `Poll posted to ${target}.` : `Failed: ${result}`, !success);
    },
  }),

  defineTool({
    name: 'end_poll',
    description:
      'End (finalize) a running Discord poll early: freezes its current results and stops further voting. ' +
      'Discord only; admins can only act in conversations they are in. This is IRREVERSIBLE, but it does NOT ' +
      'delete the poll or its votes — the final tally stays visible. Discord polls cannot be edited or ' +
      'converted (e.g. to multi-choice) after posting; to change one, end it here and post a fresh poll with ' +
      'create_poll.',
    minTier: 'admin',
    platforms: ['discord'],
    readOnlyHint: false,
    schema: {
      messageId: z
        .string()
        .describe("The poll message's id (in Discord: right-click the poll → Copy Message ID)"),
      conversationId: z
        .string()
        .optional()
        .describe('Channel/conversation id the poll is in; defaults to the current one'),
    },
    handler: async (args, { caller, adapter, callerScope, audited }) => {
      assertAtLeast(caller.role, 'admin', 'end_poll');
      if (!adapter.adminCapabilities.has('end_poll')) {
        return text(`This platform (${adapter.platform}) does not support polls.`, true);
      }
      const target = args.conversationId ?? caller.conversationId;
      const allowed = await callerScope();
      if (allowed && !allowed.includes(target)) {
        return text(`Refusing: you are not a participant of conversation "${target}".`, true);
      }
      if (target !== caller.conversationId && !(await isKnownConversation(caller.platform, target))) {
        return text(`Refusing: conversation "${target}" is unknown.`, true);
      }
      if (!reservePollEndSlot(target, POLL_END_RATE_LIMIT_PER_HOUR)) {
        return text(
          `Refusing: conversation "${target}" already hit the end-poll limit (${POLL_END_RATE_LIMIT_PER_HOUR}/hour) — try again later.`,
          true,
        );
      }
      const params = { messageId: args.messageId };
      const { success, result } = await audited({
        actionKind: 'end_poll',
        conversationId: target,
        params,
        run: () =>
          adapter.performAdminAction({
            kind: 'end_poll',
            conversationId: target,
            params,
          }),
      });
      return text(success ? result : `Failed: ${result}`, !success);
    },
  }),

  defineTool({
    name: 'create_thread',
    description:
      'Open a Discord thread under a channel to split a longer discussion out of the main flow, optionally ' +
      'seeded from an existing message. Discord only. Admins can only open threads in conversations they are in.',
    minTier: 'admin',
    platforms: ['discord'],
    readOnlyHint: false,
    schema: {
      name: z
        .string()
        .min(1)
        .max(THREAD_NAME_MAX_CHARS)
        .describe(`The thread's title, up to ${THREAD_NAME_MAX_CHARS} characters`),
      channelId: z
        .string()
        .optional()
        .describe('Parent channel id to open the thread under; defaults to the current conversation'),
      seedMessageId: z
        .string()
        .optional()
        .describe('Optional existing message id in that channel to start the thread from'),
    },
    handler: async (args, { caller, adapter, callerScope, audited }) => {
      assertAtLeast(caller.role, 'admin', 'create_thread');
      if (!adapter.adminCapabilities.has('create_thread')) {
        return text(`This platform (${adapter.platform}) does not support creating threads.`, true);
      }
      const target = args.channelId ?? caller.conversationId;
      const allowed = await callerScope();
      if (allowed && !allowed.includes(target)) {
        return text(`Refusing: you are not a participant of conversation "${target}".`, true);
      }
      if (
        target !== caller.conversationId &&
        !(await isKnownConversation(caller.platform, target)) &&
        !(await adapter.canPostTo?.(target))
      ) {
        return text(unreachableConversationRefusal(target), true);
      }
      // Defensive guard (adversarial review, issue #229): thread messages are
      // moderation-scanned under their PARENT channel's allowlist membership
      // (DiscordAdapter.scopeChannelId resolves a thread to its parent for the
      // scan gate in onDiscordMessage), so a thread opened under a
      // non-allowlisted parent would be an unmoderated space the bot itself
      // manufactured. Refuse rather than rely solely on that scan-side fix
      // staying correct.
      if (
        config.moderation.enabled &&
        config.discord.allowedChannelIds.length > 0 &&
        !config.discord.allowedChannelIds.includes(target)
      ) {
        return text(
          `Refusing: moderation is enabled with a channel allowlist and "${target}" is not on it — a thread ` +
            'there would not be moderation-scanned.',
          true,
        );
      }
      if (args.seedMessageId && !(await isKnownMessage(caller.platform, target, args.seedMessageId))) {
        return text(`Refusing: message "${args.seedMessageId}" is unknown in "${target}".`, true);
      }
      if (!reserveThreadSlot(target, THREAD_CREATE_RATE_LIMIT_PER_HOUR)) {
        return text(
          `Refusing: conversation "${target}" already hit the thread-creation limit ` +
            `(${THREAD_CREATE_RATE_LIMIT_PER_HOUR}/hour) — try again later.`,
          true,
        );
      }
      const params = { name: args.name, seedMessageId: args.seedMessageId };
      const { success, result } = await audited({
        actionKind: 'create_thread',
        conversationId: target,
        params,
        run: () =>
          adapter.performAdminAction({
            kind: 'create_thread',
            conversationId: target,
            params,
          }),
      });
      return text(success ? result : `Failed: ${result}`, !success);
    },
  }),

  defineTool({
    name: 'archive_thread',
    description:
      'Archive a Discord thread the bot can see, ending active discussion there. CONFIRM required — this hides ' +
      "the thread from the channel's active list. Discord only. Admins can only archive threads in " +
      'conversations they are in.',
    minTier: 'admin',
    platforms: ['discord'],
    readOnlyHint: false,
    schema: {
      threadId: z.string().describe('The thread id to archive'),
      reason: z.string().optional().describe('Optional note for the audit log'),
    },
    handler: async (args, { caller, adapter, callerScope, audited, requireConfirm }) => {
      assertAtLeast(caller.role, 'admin', 'archive_thread');
      if (!adapter.adminCapabilities.has('archive_thread')) {
        return text(`This platform (${adapter.platform}) does not support archiving threads.`, true);
      }
      const allowed = await callerScope();
      if (allowed && !allowed.includes(args.threadId)) {
        return text(`Refusing: you are not a participant of conversation "${args.threadId}".`, true);
      }
      if (
        args.threadId !== caller.conversationId &&
        !(await isKnownConversation(caller.platform, args.threadId))
      ) {
        return text(unreachableConversationRefusal(args.threadId), true);
      }
      const params = { reason: args.reason };
      const run = async () => {
        const { success, result } = await audited({
          actionKind: 'archive_thread',
          conversationId: args.threadId,
          params,
          run: () =>
            adapter.performAdminAction({
              kind: 'archive_thread',
              conversationId: args.threadId,
              params,
            }),
        });
        return success ? `Done: ${result}` : `Failed: ${result}`;
      };

      return requireConfirm(
        `archive_thread on ${args.threadId}${args.reason ? ` (reason: ${args.reason})` : ''}`,
        'admin',
        run,
      );
    },
  }),
];
