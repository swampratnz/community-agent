import {
  Client,
  Events,
  GatewayIntentBits,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  GuildScheduledEventStatus,
  MessageFlags,
  Partials,
  PermissionFlagsBits,
  type GuildMember,
  type Guild,
  type Role,
  type TextChannel,
  type NewsChannel,
  type ForumChannel,
  type CategoryChannel,
  type VoiceChannel,
  type StageChannel,
  type MediaChannel,
  type GuildBasedChannel,
  type NonThreadGuildBasedChannel,
  type PartialGuildMember,
  type Message,
  type PartialMessage,
  type DMChannel,
  type PermissionOverwrites,
  ChannelType,
} from 'discord.js';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { filterOutbound } from '../../agent/outbound.js';
import { runtimeSecrets } from '../../agent/secrets.js';
import {
  getCodeAnswersPolicy,
  getCommunityGuidelines,
  getWelcomeMessage,
  getWelcomeMessageMi,
} from '../../storage/policies.js';
import { createModerator, type ModerationEnforcer, type Moderator } from '../../moderation/index.js';
import { atLeast } from '../../auth/rbac.js';
import { resolveRole, superAdminIds } from '../../auth/roles.js';
import {
  countActiveWarnings,
  deleteInteractionByMessageId,
  getLanguagePreference,
  markRosterLeave,
  updateInteractionByMessageId,
  upsertRosterMember,
} from '../../storage/repository.js';
import { shouldNotifyMutedRoleOverwriteFailed } from '../../mutedRoleAlertNotice.js';
import { chunkText } from '../textChunk.js';
import {
  paramString,
  type AdminAction,
  type IncomingMessage,
  type MessageHandler,
  type OutgoingMessage,
  type PlatformAdapter,
  type ScheduledEventLookup,
  type UpcomingEvent,
} from '../types.js';

const MAX_DISCORD_LEN = 2000;
const MEMBERSHIP_CACHE_TTL_MS = 60_000;
// Matches MEMBERSHIP_CACHE_TTL_MS's "implementations cache briefly" convention
// (see PlatformAdapter.listUpcomingEvents' doc comment) — a busy channel of
// members asking "what's on?" can't turn into a scheduledEvents.fetch() call
// per turn (issue #388).
const EVENTS_CACHE_TTL_MS = 60_000;
// Bounded retry for a transient permission-overwrite failure (issue #276):
// initial attempt + 2 retries, short fixed delay — enough to ride out a
// blip without meaningfully slowing a mute/channel-create handler. Small
// hardcoded constants, not operator-tunable, matching this repo's existing
// convention for this class of constant (e.g. THREAD_CREATE_RATE_LIMIT_PER_HOUR).
const MUTED_ROLE_OVERWRITE_MAX_ATTEMPTS = 3;
const MUTED_ROLE_OVERWRITE_RETRY_DELAY_MS = 500;
// 15 minutes — mirrors #203's BUDGET_CHECK_FAILURE_ALERT_WINDOW_MS shape; a
// permission-overwrite failure is a systemic condition, not a per-channel one.
const MUTED_ROLE_ALERT_WINDOW_MS = 900_000;

/** Maps discord.js's numeric `GuildScheduledEventStatus` to `ScheduledEventLookup`'s closed string union. */
function mapScheduledEventStatus(status: GuildScheduledEventStatus): ScheduledEventLookup['status'] {
  switch (status) {
    case GuildScheduledEventStatus.Scheduled:
      return 'scheduled';
    case GuildScheduledEventStatus.Active:
      return 'active';
    case GuildScheduledEventStatus.Completed:
      return 'completed';
    case GuildScheduledEventStatus.Canceled:
      return 'canceled';
  }
}

export const WELCOME_MESSAGE =
  "Kia ora, welcome! 👋 This server's bot answers Claude/Anthropic questions and remembers context, " +
  'but it only replies to registered members. Ask an admin to add you, or just say hi to the bot here ' +
  'and an admin will see your request.';

// Selected instead of WELCOME_MESSAGE when config.rbac.accessMode.discord is
// 'open' (issue #351) — that mode already lets a guest message the bot with
// no admin approval (router.ts gates on this exact value), so the default
// text must say so rather than claim gating that isn't in effect. Generic
// and static like WELCOME_MESSAGE — no joiner-supplied data interpolated.
export const WELCOME_MESSAGE_OPEN =
  "Kia ora, welcome! 👋 This server's bot answers Claude/Anthropic questions and remembers context — " +
  'go ahead and message me any time, no admin approval needed. Ask me "what can you do?" any time for ' +
  'a quick rundown.';

export class DiscordAdapter implements PlatformAdapter, ModerationEnforcer {
  readonly platform = 'discord' as const;
  readonly adminCapabilities = new Set([
    'timeout_user',
    'kick_user',
    'ban_user',
    'delete_message',
    'warn_user',
    'unmute_user',
    'mute_user',
    'assign_community_role',
    'remove_community_role',
    'list_assignable_roles',
    'create_poll',
    'end_poll',
    'create_thread',
    'archive_thread',
    'create_event',
    'cancel_event',
  ]);

  private readonly client: Client;
  private handler: MessageHandler | null = null;
  private readonly membershipCache = new Map<string, { expires: number; ids: string[] }>();
  // Single-entry cache (guild-wide, not per-user) for listUpcomingEvents —
  // holds the full filtered/sorted list; each call slices to its own limit
  // so the fetch itself is shared across differing limits (issue #388).
  private eventsCache: { expires: number; events: UpcomingEvent[] } | null = null;
  private connected = false;
  private readonly moderator: Moderator;
  // Resolved lazily on first use and cached: the muted role and the admin
  // alerts channel are created on demand (needs Manage Roles / Manage Channels).
  private mutedRoleId: string | null = null;
  private adminChannelId: string | null = null;
  // Process-wide debounce latch for the muted-role overwrite retry-exhaustion
  // alert (issue #276) — a systemic condition, not a per-channel one, so a
  // burst of failing channels/scans collapses into a single DM.
  private mutedRoleAlertNotifiedAt: number | undefined;

  constructor(private readonly mutedRoleOverwriteRetryDelayMs = MUTED_ROLE_OVERWRITE_RETRY_DELAY_MS) {
    this.moderator = createModerator(this);
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages,
      ],
      // GuildMember partial so guildMemberRemove still fires for members the
      // cache never held (needed by the roster's leave tracking). Partials
      // are a caching setting, not a gateway intent — no new intent here.
      partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
    });
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.client.on(Events.MessageCreate, (message) => {
      this.onDiscordMessage(message).catch((err) => logger.error({ err }, 'Discord message handling failed'));
    });

    // Delete/edit honouring for stored messages (issue #48): only wired when
    // ambient archiving is on, so the default-off posture is byte-identical
    // to before. A user deleting or editing their Discord message deletes or
    // updates the stored copy.
    if (config.discord.archiveAllMessages) {
      this.client.on(Events.MessageDelete, (message) => {
        if (!this.inArchiveScope(message.guildId, this.scopeChannelId(message.channel, message.channelId)))
          return;
        deleteInteractionByMessageId('discord', message.channelId, message.id).catch((err) =>
          logger.warn({ err, messageId: message.id }, 'Stored-message delete failed'),
        );
      });
      this.client.on(Events.MessageBulkDelete, (messages) => {
        for (const message of messages.values()) {
          if (!this.inArchiveScope(message.guildId, this.scopeChannelId(message.channel, message.channelId)))
            continue;
          deleteInteractionByMessageId('discord', message.channelId, message.id).catch((err) =>
            logger.warn({ err, messageId: message.id }, 'Stored-message bulk delete failed'),
          );
        }
      });
      this.client.on(Events.MessageUpdate, (_old, newMessage) => {
        this.onMessageUpdate(newMessage).catch((err) =>
          logger.warn({ err, messageId: newMessage.id }, 'Stored-message update failed'),
        );
      });
    }

    this.client.on(Events.GuildMemberAdd, (member) => {
      this.onGuildMemberAdd(member).catch((err) => logger.error({ err }, 'Member join handling failed'));
    });
    this.client.on(Events.GuildMemberRemove, (member) => {
      this.onGuildMemberRemove(member).catch((err) => logger.error({ err }, 'Roster leave failed'));
    });
    // Closes the "new channel doesn't inherit the muted role" gap (see
    // ensureMutedRole's doc comment / SECURITY.md): apply the overwrite to a
    // new channel immediately instead of waiting for the next mute event.
    this.client.on(Events.ChannelCreate, (channel) => {
      this.onChannelCreate(channel).catch((err) => logger.error({ err }, 'Channel create handling failed'));
    });
    // Narrows the last documented residual membership-scope staleness gap
    // (issue #328, the follow-up #286 deferred — see `conversationsForUser`'s
    // doc comment / SECURITY.md "Membership-scope staleness"): a
    // channel-specific permission-overwrite revoke with no guild exit had no
    // listener, so a scope refusal could lag up to MEMBERSHIP_CACHE_TTL_MS.
    // Wrapped like every other listener here: an uncaught throw from a
    // discord.js event handler propagates out of the client's emit chain and
    // can crash the whole process (Discord *and* WhatsApp handling).
    this.client.on(Events.ChannelUpdate, (oldChannel, newChannel) => {
      try {
        this.onChannelUpdate(oldChannel, newChannel);
      } catch (err) {
        logger.error({ err }, 'Channel update handling failed');
      }
    });
    // Narrows the last documented membership-scope-staleness gap (issue
    // #350; see `conversationsForUser`'s doc comment / SECURITY.md
    // "Membership-scope staleness"): a Discord role added to/removed from a
    // member, a role's own permissions edited, or a role deleted entirely
    // had no listener, so the more common admin revocation workflow
    // (pulling someone out of a role, vs. #328's channel-overwrite edit)
    // still carried the full stale-scope window. Wrapped like every other
    // listener here: an uncaught throw from a discord.js event handler
    // propagates out of the client's emit chain and can crash the whole
    // process (Discord *and* WhatsApp handling).
    this.client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
      try {
        this.onGuildMemberUpdate(oldMember, newMember);
      } catch (err) {
        logger.error({ err }, 'Guild member update handling failed');
      }
    });
    this.client.on(Events.GuildRoleUpdate, (oldRole, newRole) => {
      try {
        this.onGuildRoleUpdate(oldRole, newRole);
      } catch (err) {
        logger.error({ err }, 'Guild role update handling failed');
      }
    });
    this.client.on(Events.GuildRoleDelete, (role) => {
      try {
        this.onGuildRoleDelete(role);
      } catch (err) {
        logger.error({ err }, 'Guild role delete handling failed');
      }
    });

    this.client.once(Events.ClientReady, (c) => {
      this.connected = true;
      logger.info({ user: c.user.tag }, 'Discord connected');
      // One-shot idempotent roster backfill so "everyone already here" is
      // covered, not just future joiners. Fire-and-forget: a backfill
      // failure must never block message handling.
      void this.backfillRoster();
      // Re-apply the muted-role deny overwrite across all channels on startup,
      // so a channel created while the bot was offline (which `onChannelCreate`
      // never saw) doesn't stay postable for muted members until the next mute
      // event. Fire-and-forget; no-op if moderation is off or no muted role
      // exists yet.
      void this.reconcileMutedRole();
    });
    // Steady-state signal for /healthz + disconnect alerting — discord.js
    // handles gateway resume internally, but a shard going down means we're
    // not receiving messages, which is what these signals care about.
    this.client.on(Events.ShardDisconnect, () => {
      this.connected = false;
      logger.warn('Discord shard disconnected');
    });
    this.client.on(Events.ShardResume, () => {
      this.connected = true;
      logger.info('Discord shard resumed');
    });

    await this.client.login(config.discord.botToken);
  }

  async stop(): Promise<void> {
    this.connected = false;
    await this.client.destroy();
  }

  isConnected(): boolean {
    return this.connected;
  }

  private async onDiscordMessage(message: Message): Promise<void> {
    if (message.author.bot) return; // ignore bots (incl. ourselves)
    if (!this.handler) return;

    const isDM = message.channel.type === ChannelType.DM;

    // Restrict to the configured guild (DMs always allowed).
    if (!isDM && message.guildId !== config.discord.guildId) return;

    // Optional channel allowlist. A message posted in a thread reports the
    // thread's own id as `channelId`, not its parent's, so gating on that id
    // alone silently excludes every thread under an allowed channel — those
    // messages were never processed OR moderation-scanned. Resolve a thread to
    // its parent channel id for the allowlist decision (recall/session still
    // key on the real thread id via `conversationId` below). The same
    // resolution is applied to the delete/edit-honouring listeners via
    // `scopeChannelId`, so a thread message that is archived is also honoured
    // when deleted/edited.
    const gateChannelId = this.scopeChannelId(message.channel, message.channelId);
    if (
      !isDM &&
      config.discord.allowedChannelIds.length > 0 &&
      !config.discord.allowedChannelIds.includes(gateChannelId)
    ) {
      return;
    }

    // Auto-moderation scans EVERY in-scope guild message (not just addressed
    // ones), independently of the agent path below. Fire-and-forget so a scan
    // failure can never block or delay normal handling. DMs aren't scanned —
    // muting is a guild concept. A no-op unless DISCORD_MODERATION_ENABLED.
    if (!isDM) {
      void this.moderator
        .scan({
          platform: 'discord',
          userId: message.author.id,
          userName: message.member?.displayName ?? message.author.username,
          text: this.cleanContent(message.content),
          channelId: message.channelId,
        })
        .catch((err) => logger.warn({ err }, 'Moderation scan failed'));
    }

    const botId = this.client.user?.id;
    const mentioned = botId ? message.mentions.users.has(botId) : false;
    const repliedToBot =
      message.reference?.messageId != null && (await this.isReplyToBot(message).catch(() => false));

    const normalised: IncomingMessage = {
      platform: 'discord',
      conversationId: message.channelId,
      userId: message.author.id,
      userName: message.member?.displayName ?? message.author.username,
      text: this.cleanContent(message.content),
      isDirect: isDM,
      addressedToBot: mentioned || repliedToBot,
      messageId: message.id,
      timestamp: message.createdTimestamp,
      raw: message,
    };

    await this.handler(normalised);
  }

  /** Strip the bot mention from message text for a clean prompt. */
  private cleanContent(content: string): string {
    const botId = this.client.user?.id;
    return botId ? content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim() : content.trim();
  }

  /** True when a message id belongs to the configured guild + allowed channels (archiving scope). */
  private inArchiveScope(guildId: string | null, channelId: string): boolean {
    if (guildId !== config.discord.guildId) return false;
    return (
      config.discord.allowedChannelIds.length === 0 || config.discord.allowedChannelIds.includes(channelId)
    );
  }

  /**
   * Archive/allowlist scope is keyed on the PARENT channel: a thread reports
   * its own id as `channelId`, and a thread id is never in `allowedChannelIds`.
   * Resolve a thread to its parent for every scope decision — the allowlist
   * gate in `onDiscordMessage` AND the delete/edit-honouring listeners — so a
   * thread message under an allowed channel is both processed and, when later
   * deleted/edited, has its stored copy honoured (issue #48). The stored
   * `conversation_id` (and thus the delete/update match) stays the thread id;
   * only the scope check uses the parent. Falls back to the raw id for a
   * non-thread or an uncached channel.
   */
  private scopeChannelId(
    channel: { isThread(): boolean; parentId?: string | null } | null | undefined,
    channelId: string,
  ): string {
    return channel?.isThread() ? (channel.parentId ?? channelId) : channelId;
  }

  private async onMessageUpdate(newMessage: Message | PartialMessage): Promise<void> {
    if (
      !this.inArchiveScope(newMessage.guildId, this.scopeChannelId(newMessage.channel, newMessage.channelId))
    )
      return;
    const full = newMessage.partial ? await newMessage.fetch() : newMessage;
    if (full.author.bot || !full.content) return;
    await updateInteractionByMessageId('discord', full.channelId, full.id, this.cleanContent(full.content));
  }

  private async isReplyToBot(message: Message): Promise<boolean> {
    const refId = message.reference?.messageId;
    if (!refId) return false;
    const ref = await message.channel.messages.fetch(refId);
    return ref.author.id === this.client.user?.id;
  }

  /**
   * Roster join recording (always, identity metadata only — never message
   * content, see SECURITY.md) plus the static, non-agent welcome — no LLM
   * call, same cost profile as the gated notice. The welcome stays off
   * unless DISCORD_WELCOME_ENABLED=true, so existing deployments are
   * unaffected. DM-first; falls back to the configured channel if the
   * member has DMs closed. The welcome text itself is admin-configurable
   * (set_welcome_message, issue #253), falling back to the hardcoded
   * WELCOME_MESSAGE default when unset — WELCOME_MESSAGE_OPEN instead when
   * config.rbac.accessMode.discord is 'open' (issue #351), since that mode
   * already lets guests through without admin approval. A rejoining member with a standing
   * set_language_preference('mi') gets the admin-configured welcome_message_mi
   * variant instead, if one is set (issue #282) — falling back to the
   * default-language welcome unchanged when it isn't. Guidelines (below) stay
   * default-language regardless; only the welcome text itself is mi-aware.
   * When community guidelines are set (issue #212), they're appended verbatim
   * to it — never run through the model, so there's no paraphrase risk on
   * this path.
   */
  private async onGuildMemberAdd(member: GuildMember): Promise<void> {
    if (member.guild.id !== config.discord.guildId) return;

    if (!member.user.bot) {
      await upsertRosterMember({
        platform: 'discord',
        userId: member.id,
        displayName: member.displayName,
      }).catch((err) => logger.warn({ err, userId: member.id }, 'Roster join record failed'));

      // Closes the "leave/rejoin sheds the muted role" gap (see SECURITY.md):
      // re-mute before any welcome-message logic runs, gated the same as the
      // rest of moderation.
      if (config.moderation.enabled) {
        await this.remuteOnRejoinIfNeeded(member).catch((err) =>
          logger.warn({ err, userId: member.id }, 'Rejoin re-mute check failed'),
        );
      }
    }

    if (!config.discord.welcome.enabled) return;

    const languagePreference = await getLanguagePreference('discord', member.id);
    const welcomeMessageMi = languagePreference === 'mi' ? await getWelcomeMessageMi() : null;
    const defaultWelcomeMessage =
      config.rbac.accessMode.discord === 'open' ? WELCOME_MESSAGE_OPEN : WELCOME_MESSAGE;
    const welcomeMessage = welcomeMessageMi ?? (await getWelcomeMessage()) ?? defaultWelcomeMessage;
    const guidelines = await getCommunityGuidelines();
    const welcomeText = guidelines
      ? `${welcomeMessage}\n\nCommunity guidelines:\n${guidelines}`
      : welcomeMessage;

    try {
      await member.send({ content: welcomeText, allowedMentions: { parse: [] } });
      return;
    } catch (err) {
      logger.warn({ err, userId: member.id }, 'Welcome DM failed; trying channel fallback');
    }

    const channelId = config.discord.welcome.channelId;
    if (!channelId) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !('send' in channel)) return;
      await channel.send({
        content: `Welcome <@${member.id}>! ${welcomeText}`,
        allowedMentions: { users: [member.id] },
      });
    } catch (err) {
      logger.warn({ err, userId: member.id, channelId }, 'Welcome channel fallback failed');
    }
  }

  /**
   * A muted member can shed the role by leaving and rejoining (SECURITY.md
   * documented bypass) — re-mute immediately if they're still at/above the
   * strike limit. Honours the same exemption guard as `Moderator.scan`
   * (moderator.ts:112: `isExempt` = admin-tier-or-above), so a member who
   * accrued warnings before being promoted is not auto-muted on rejoin.
   * Unlike the routine new-channel re-apply (which stays silent), this posts
   * an admin alert — an evasion attempt was just auto-handled and admins
   * should know.
   */
  private async remuteOnRejoinIfNeeded(member: GuildMember): Promise<void> {
    if (atLeast(await resolveRole('discord', member.id), 'admin')) return;
    // Deliberately UNWINDOWED (no strikeWindowDays): this check exists to
    // close the leave/rejoin mute-evasion bypass, so it must see every
    // uncleared strike regardless of age — otherwise leaving and waiting out
    // MODERATION_STRIKE_WINDOW_DAYS would be a de facto auto-unmute that
    // bypasses clear_warnings (see docs/SECURITY.md).
    const active = await countActiveWarnings('discord', member.id);
    if (active < config.moderation.strikeLimit) return;
    await this.muteUser(member.id);
    await this.postAdminAlert(
      `🔁 **${member.displayName}** (\`${member.id}\`) left and rejoined while still at ` +
        `${active}/${config.moderation.strikeLimit} warnings — automatically re-muted.`,
    );
  }

  private async onGuildMemberRemove(member: GuildMember | PartialGuildMember): Promise<void> {
    if (member.guild.id !== config.discord.guildId) return;
    if (member.user?.bot) return;
    // A full guild exit invalidates every scope entry for this user, so a
    // full delete (not a partial recompute) is correct — see docs/SECURITY.md
    // "Membership-scope staleness".
    this.membershipCache.delete(member.id);
    await markRosterLeave('discord', member.id).catch((err) =>
      logger.warn({ err, userId: member.id }, 'Roster leave record failed'),
    );
  }

  /**
   * Narrows the channel-permission-overwrite membership-scope-staleness gap
   * (issue #328): ignores channels outside `config.discord.guildId` and
   * non-text channels (the same guard `conversationsForUser` already
   * applies), and no-ops when the edit didn't actually touch
   * `permissionOverwrites` (a name/topic edit, which is routine and must stay
   * free). On a genuine overwrite change, clears the ENTIRE cache rather than
   * diffing which users/roles it affects — see the issue's "smallest viable
   * version": correct-by-construction (only ever invalidates sooner, never
   * grants scope a live check wouldn't), and cheap since permission edits are
   * infrequent. A per-user/per-role diff is the documented growth path, not
   * implemented here.
   */
  private onChannelUpdate(
    oldChannel: DMChannel | NonThreadGuildBasedChannel,
    newChannel: DMChannel | NonThreadGuildBasedChannel,
  ): void {
    if (oldChannel.isDMBased() || newChannel.isDMBased()) return;
    if (newChannel.guild.id !== config.discord.guildId) return;
    if (!oldChannel.isTextBased() || !newChannel.isTextBased()) return;
    if (
      this.permissionOverwritesEqual(
        oldChannel.permissionOverwrites.cache,
        newChannel.permissionOverwrites.cache,
      )
    )
      return;
    this.membershipCache.clear();
  }

  /** True when two channels' permission-overwrite collections carry the same ids and allow/deny bitfields. */
  private permissionOverwritesEqual(
    a: ReadonlyMap<string, PermissionOverwrites>,
    b: ReadonlyMap<string, PermissionOverwrites>,
  ): boolean {
    if (a.size !== b.size) return false;
    for (const [id, overwrite] of a) {
      const other = b.get(id);
      if (!other) return false;
      if (
        overwrite.allow.bitfield !== other.allow.bitfield ||
        overwrite.deny.bitfield !== other.deny.bitfield
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * Narrows the Discord role-based-access membership-scope-staleness gap
   * (issue #350): `conversationsForUser` derives per-channel visibility from
   * `channel.permissionsFor(member)`, which depends on the member's roles,
   * so a role added to or removed from a member must invalidate the cache
   * as immediately as a full guild exit (`onGuildMemberRemove`, #286) or a
   * channel permission-overwrite edit (`onChannelUpdate`, #328) already do.
   * No-ops on a routine update that leaves the role id set unchanged (e.g.
   * nickname, avatar, timeout, boost) — mirrors `onChannelUpdate`'s guard
   * that a routine edit is free. Whole-cache clear on a genuine change,
   * same correct-by-construction reasoning as the two precedents.
   *
   * Fail-safe edge: a partial `oldMember` (e.g. wasn't in the member cache
   * when the event fired) means its role set at the time of the event is
   * unknowable — treat that as a change and clear the cache rather than
   * risk silently treating a real revocation as unchanged.
   */
  private onGuildMemberUpdate(oldMember: GuildMember | PartialGuildMember, newMember: GuildMember): void {
    if (newMember.guild.id !== config.discord.guildId) return;
    if (oldMember.partial || !this.roleIdSetsEqual(oldMember.roles.cache, newMember.roles.cache)) {
      this.membershipCache.clear();
    }
  }

  /**
   * Narrows the same gap as `onGuildMemberUpdate` from the other direction:
   * a role's own permissions can change without any member's role list
   * changing. No-ops on a color/name/hoist-only edit (routine, must stay
   * free); clears the whole cache on a genuine `permissions` change.
   */
  private onGuildRoleUpdate(oldRole: Role, newRole: Role): void {
    if (newRole.guild.id !== config.discord.guildId) return;
    if (oldRole.permissions.bitfield !== newRole.permissions.bitfield) {
      this.membershipCache.clear();
    }
  }

  /**
   * A deleted role can only ever remove access a live `permissionsFor`
   * check wouldn't already reflect, so this is unconditional (within the
   * configured guild) — no permission-diff guard needed, unlike
   * `onGuildRoleUpdate`.
   */
  private onGuildRoleDelete(role: Role): void {
    if (role.guild.id !== config.discord.guildId) return;
    this.membershipCache.clear();
  }

  /** True when two member role-collections carry the same set of role ids. */
  private roleIdSetsEqual(a: ReadonlyMap<string, unknown>, b: ReadonlyMap<string, unknown>): boolean {
    if (a.size !== b.size) return false;
    for (const id of a.keys()) {
      if (!b.has(id)) return false;
    }
    return true;
  }

  /**
   * Idempotent upsert of every current (non-bot) guild member, so the roster
   * covers lurkers who joined before this feature existed. Uses the member
   * list the GuildMembers intent already streams to the bot — no new intent,
   * no message content.
   */
  private async backfillRoster(): Promise<void> {
    try {
      const guild = await this.client.guilds.fetch(config.discord.guildId);
      const members = await guild.members.fetch();
      let count = 0;
      for (const member of members.values()) {
        if (member.user.bot) continue;
        await upsertRosterMember({
          platform: 'discord',
          userId: member.id,
          displayName: member.displayName,
        });
        count += 1;
      }
      logger.info({ count }, 'Roster backfill complete');
    } catch (err) {
      logger.warn({ err }, 'Roster backfill failed');
    }
  }

  /**
   * Every outbound path is filtered HERE (secret redaction + code policy) so
   * no caller — router reply, announce, warn, super-admin alert — can forget.
   * `language` is optional (issue #339): only `sendMessage`'s main-reply path
   * passes it through; every other call site below omits it, so their output
   * stays English-only by construction (never `_MI`).
   */
  private async filtered(text: string, language?: 'mi'): Promise<string> {
    return filterOutbound(text, await getCodeAnswersPolicy(), runtimeSecrets(), undefined, language);
  }

  async sendMessage(out: OutgoingMessage): Promise<void> {
    const channel = await this.client.channels.fetch(out.conversationId);
    if (!channel || !channel.isTextBased() || !('send' in channel)) {
      throw new Error(`Discord channel ${out.conversationId} is not sendable`);
    }
    // Discord caps messages at 2000 chars; chunk longer replies. Mentions are
    // never parsed so an injected "@everyone" can't mass-ping. SuppressEmbeds
    // stops Discord from expanding any links in the reply into preview cards.
    for (const chunk of chunkText(await this.filtered(out.text, out.language), MAX_DISCORD_LEN)) {
      await channel.send({
        content: chunk,
        allowedMentions: { parse: [] },
        flags: MessageFlags.SuppressEmbeds,
      });
    }
  }

  /** Best-effort typing indicator; Discord auto-clears it after ~10s or on the next message. */
  async sendTypingIndicator(message: IncomingMessage): Promise<void> {
    const channel = await this.client.channels.fetch(message.conversationId);
    if (!channel || !channel.isTextBased() || !('sendTyping' in channel)) return;
    await channel.sendTyping();
  }

  async sendDirectMessage(userId: string, text: string): Promise<void> {
    const user = await this.client.users.fetch(userId);
    for (const chunk of chunkText(await this.filtered(text), MAX_DISCORD_LEN)) {
      await user.send({
        content: chunk,
        allowedMentions: { parse: [] },
        flags: MessageFlags.SuppressEmbeds,
      });
    }
  }

  /**
   * Channels in the configured guild the user can currently view, plus their
   * DM with the bot. Backs admin conversation scoping; cached ~60s, but a
   * full guild exit invalidates the cache immediately via
   * `onGuildMemberRemove`, a genuine channel permission-overwrite change in
   * the configured guild invalidates the whole cache immediately via
   * `onChannelUpdate` (issue #328), and a genuine role change — a role
   * added to/removed from a member, a role's own permissions edited, or a
   * role deleted — invalidates the whole cache immediately via
   * `onGuildMemberUpdate`/`onGuildRoleUpdate`/`onGuildRoleDelete` (issue
   * #350). The TTL only bounds staleness from membership changes this
   * adapter still doesn't observe at all — documented in SECURITY.md.
   */
  async conversationsForUser(userId: string): Promise<string[]> {
    const cached = this.membershipCache.get(userId);
    if (cached && cached.expires > Date.now()) return cached.ids;

    const ids: string[] = [];
    try {
      const guild = await this.client.guilds.fetch(config.discord.guildId);
      const member = await guild.members.fetch(userId);
      const channels = await guild.channels.fetch();
      for (const channel of channels.values()) {
        if (!channel || !channel.isTextBased()) continue;
        if (channel.permissionsFor(member)?.has('ViewChannel')) ids.push(channel.id);
      }
      // Their 1:1 DM with the bot is always in scope.
      const dm = await member.user.createDM();
      ids.push(dm.id);
    } catch (err) {
      logger.warn({ err, userId }, 'Failed to resolve Discord conversations for user');
    }

    this.membershipCache.set(userId, { expires: Date.now() + MEMBERSHIP_CACHE_TTL_MS, ids });
    return ids;
  }

  /**
   * Upcoming/active Discord scheduled events (issue #388, the read
   * counterpart to `create_event`/#230) — `Scheduled`/`Active` only,
   * `Completed`/`Canceled` excluded, sorted by start time ascending, capped
   * at `limit`. Cached ~60s (`EVENTS_CACHE_TTL_MS`) as a single guild-wide
   * entry holding the full filtered/sorted list, so differing `limit`
   * callers share one `scheduledEvents.fetch()` and only the final slice
   * differs. Includes each event's `id` (issue #424) — the only path by
   * which `cancel_event` can ever learn a valid target id.
   */
  async listUpcomingEvents(limit: number): Promise<UpcomingEvent[]> {
    const now = Date.now();
    if (!this.eventsCache || this.eventsCache.expires <= now) {
      const guild = await this.client.guilds.fetch(config.discord.guildId);
      const fetched = await guild.scheduledEvents.fetch();
      const events: UpcomingEvent[] = [];
      for (const event of fetched.values()) {
        if (
          event.status !== GuildScheduledEventStatus.Scheduled &&
          event.status !== GuildScheduledEventStatus.Active
        ) {
          continue;
        }
        events.push({
          id: event.id,
          name: event.name ?? '',
          scheduledStartAt: (event.scheduledStartAt ?? new Date(0)).toISOString(),
          scheduledEndAt: event.scheduledEndAt?.toISOString(),
          location: await this.resolveEventLocation(event),
          description: event.description ?? undefined,
        });
      }
      events.sort((a, b) => Date.parse(a.scheduledStartAt) - Date.parse(b.scheduledStartAt));
      this.eventsCache = { expires: now + EVENTS_CACHE_TTL_MS, events };
    }
    return this.eventsCache.events.slice(0, limit);
  }

  /**
   * Live lookup of a single scheduled event by id, for `cancel_event`'s
   * pre-CONFIRM target validation (issue #424) — mirrors the "the bot must
   * be able to verify what it's acting on" discipline `isKnownConversation`/
   * `isKnownMessage` apply to DB-tracked targets, just sourced from Discord's
   * live API since scheduled events aren't stored in `interactions`.
   * `guild.scheduledEvents.fetch(id)` is scoped to THIS guild already, so an
   * id belonging to a different guild fails the fetch exactly like an
   * unknown id — both return `null` here rather than throwing.
   */
  async getScheduledEvent(eventId: string): Promise<ScheduledEventLookup | null> {
    const guild = await this.client.guilds.fetch(config.discord.guildId);
    const event = await guild.scheduledEvents.fetch(eventId).catch(() => null);
    if (!event) return null;
    return {
      name: event.name ?? '',
      status: mapScheduledEventStatus(event.status),
      scheduledStartAt: (event.scheduledStartAt ?? new Date(0)).toISOString(),
    };
  }

  /**
   * Resolve a scheduled event's location the same direction `create_event`
   * already resolves it the other way (`performAdminAction`'s `location`
   * handling): a voice/stage-hosted event's `channelId` resolves to that
   * channel's name; anything else (external/physical) falls back to the raw
   * `entityMetadata.location` string Discord stores for it.
   */
  private async resolveEventLocation(event: {
    channelId: string | null;
    entityMetadata: { location: string | null } | null;
  }): Promise<string> {
    if (event.channelId) {
      const channel = await this.client.channels.fetch(event.channelId).catch(() => null);
      if (channel && !channel.isDMBased() && 'name' in channel && channel.name) return channel.name;
    }
    return event.entityMetadata?.location ?? 'Unknown location';
  }

  /**
   * Fallback reachability check for `announce`/`create_poll`/`create_thread`
   * (issue #270) when `isKnownConversation` says no because the bot has never
   * recorded chatter there — e.g. a brand-new or quiet channel. Unlike
   * WhatsApp (where any phone number is dialable and "seen before" is the
   * real abuse boundary), Discord can only ever reach channels inside the one
   * configured guild, so a real, sendable, in-guild channel is a legitimate
   * target even with zero recorded interactions. Requires the guild match
   * explicitly rather than relying on `isKnownConversation`'s implicit one,
   * so this stays at least as strict as today for cross-guild targets.
   */
  async canPostTo(conversationId: string): Promise<boolean> {
    const channel = await this.client.channels.fetch(conversationId).catch(() => null);
    if (!channel || !channel.isTextBased() || !('send' in channel) || channel.isDMBased()) {
      return false;
    }
    const guildId = 'guildId' in channel ? channel.guildId : undefined;
    return guildId === config.discord.guildId;
  }

  async performAdminAction(action: AdminAction): Promise<string> {
    switch (action.kind) {
      case 'timeout_user': {
        const guild = await this.client.guilds.fetch(config.discord.guildId);
        const member = await guild.members.fetch(action.targetUserId!);
        const minutes = Number(action.params?.durationMinutes ?? 10);
        await member.timeout(minutes * 60_000, paramString(action.params?.reason, 'No reason given'));
        return `Timed out ${member.user.tag} for ${minutes} minute(s).`;
      }
      case 'kick_user': {
        const guild = await this.client.guilds.fetch(config.discord.guildId);
        const member = await guild.members.fetch(action.targetUserId!);
        await member.kick(paramString(action.params?.reason, 'No reason given'));
        return `Kicked ${member.user.tag}.`;
      }
      case 'ban_user': {
        const guild = await this.client.guilds.fetch(config.discord.guildId);
        await guild.members.ban(action.targetUserId!, {
          reason: paramString(action.params?.reason, 'No reason given'),
        });
        return `Banned ${action.targetUserId}.`;
      }
      case 'delete_message': {
        const channel = await this.client.channels.fetch(action.conversationId!);
        if (!channel || !channel.isTextBased()) throw new Error('Channel not found or not text-based');
        const messageId = paramString(action.params?.messageId);
        if (!messageId) throw new Error('delete_message requires params.messageId');
        const msg = await channel.messages.fetch(messageId);
        await msg.delete();
        return `Deleted message ${messageId}.`;
      }
      case 'warn_user': {
        // A "warn" is a DM to the user; recorded in the audit log by the caller.
        await this.sendDirectMessage(
          action.targetUserId!,
          `⚠️ Warning from NZ Claude Community moderators: ${paramString(action.params?.reason)}`,
        );
        return `Warned ${action.targetUserId}.`;
      }
      case 'unmute_user': {
        // Lift an auto-moderation mute (remove the muted role). Used by the
        // clear_warnings admin tool after it clears the DB strikes.
        await this.removeMutedRole(action.targetUserId!);
        return `Unmuted ${action.targetUserId}.`;
      }
      case 'mute_user': {
        // Internal-only capability (never in `moderate`'s action enum):
        // invoked by the `warn_user` branch when a manual warning pushes a
        // member's strike count to the limit (issue #384), reusing the exact
        // enforcement primitive `Moderator.scan` already uses for
        // auto-detected strikes. `params.alertText`, when given, is posted to
        // the admin-alerts channel so the mute isn't silent to admins —
        // best-effort, never lets an alert failure mask a successful mute.
        await this.muteUser(action.targetUserId!);
        const alertText = paramString(action.params?.alertText);
        if (alertText) {
          await this.postAdminAlert(alertText).catch((err) =>
            logger.warn({ err, targetUserId: action.targetUserId }, 'Manual-warn mute admin alert failed'),
          );
        }
        return `Muted ${action.targetUserId}.`;
      }
      case 'assign_community_role': {
        const guild = await this.client.guilds.fetch(config.discord.guildId);
        const roleId = paramString(action.params?.roleId);
        if (!roleId) throw new Error('assign_community_role requires params.roleId');
        const role = await this.resolveAssignableRole(guild, roleId);
        // The load-bearing check (issue #232): DISCORD_ASSIGNABLE_ROLES is a
        // curation-time allowlist, but a role's permission bitfield is
        // mutable afterwards — someone with Manage Roles could grant an
        // already-allowlisted "cosmetic" role real Discord permissions later.
        // Re-validate live, at the moment of assignment, that the role still
        // carries ZERO permissions; refuse otherwise even though its id is
        // allowlisted. See docs/SECURITY.md.
        if (role.permissions.bitfield !== 0n) {
          throw new Error(
            `Refusing: role "${role.name}" currently carries Discord permissions, so it can no longer be ` +
              'treated as cosmetic. Strip its permissions before assigning it again.',
          );
        }
        const member = await guild.members.fetch(action.targetUserId!);
        await member.roles.add(role, 'Cosmetic community role assigned via bot');
        return `Assigned "${role.name}" to ${member.user.tag}.`;
      }
      case 'remove_community_role': {
        const guild = await this.client.guilds.fetch(config.discord.guildId);
        const roleId = paramString(action.params?.roleId);
        if (!roleId) throw new Error('remove_community_role requires params.roleId');
        const role = await this.resolveAssignableRole(guild, roleId);
        const member = await guild.members.fetch(action.targetUserId!);
        await member.roles.remove(role, 'Cosmetic community role removed via bot');
        return `Removed "${role.name}" from ${member.user.tag}.`;
      }
      case 'list_assignable_roles': {
        if (config.discord.assignableRoleIds.length === 0) {
          return 'No assignable roles configured (DISCORD_ASSIGNABLE_ROLES is unset).';
        }
        const guild = await this.client.guilds.fetch(config.discord.guildId);
        const lines: string[] = [];
        for (const roleId of config.discord.assignableRoleIds) {
          const role = await guild.roles.fetch(roleId, { force: true }).catch(() => null);
          if (!role) {
            lines.push(`- ${roleId}: not found in this guild`);
            continue;
          }
          const flag =
            role.permissions.bitfield !== 0n
              ? ' ⚠️ currently carries permissions — would be refused if assigned'
              : '';
          lines.push(`- ${role.name} (${role.id})${flag}`);
        }
        return lines.join('\n');
      }
      case 'create_poll': {
        // Outward-posting, same guard as sendMessage: refuse a channel the
        // bot can't actually send into rather than let discord.js throw late.
        const channel = await this.client.channels.fetch(action.conversationId!);
        if (!channel || !channel.isTextBased() || !('send' in channel)) {
          throw new Error(`Discord channel ${action.conversationId} is not sendable`);
        }
        const rawOptions = action.params?.options;
        const options = Array.isArray(rawOptions) ? rawOptions.map((o) => String(o)) : [];
        // Question/answers are member-facing text the model authored — run
        // them through the same outbound filter as every other send path
        // (secret redaction) before they reach the channel.
        const question = await this.filtered(paramString(action.params?.question));
        const answers = await Promise.all(options.map(async (o) => ({ text: await this.filtered(o) })));
        const durationHours = Math.round(Number(action.params?.durationHours ?? 24));
        await channel.send({
          poll: {
            question: { text: question },
            answers,
            duration: durationHours,
            allowMultiselect: Boolean(action.params?.multiChoice),
          },
          // Poll question/answer text is a distinct media field (not
          // `content`) and isn't mention-parsed, but every other outbound
          // path here sets this — keep the invariant textually true rather
          // than relying on that Discord behavior being unstated.
          allowedMentions: { parse: [] },
        });
        const mode = action.params?.multiChoice ? 'multiple choice' : 'single choice';
        return `Poll posted with ${answers.length} option(s) (${mode}), open ${durationHours}h.`;
      }
      case 'end_poll': {
        // Discord's ONLY poll mutation: expire a running poll (POST
        // /channels/{id}/polls/{msg}/expire via Poll#end). Finalizes the tally
        // and stops voting — it does NOT delete the poll or its votes, and a
        // poll cannot be edited/converted (allow_multiselect is creation-only).
        const channel = await this.client.channels.fetch(action.conversationId!);
        if (!channel || !channel.isTextBased()) throw new Error('Channel not found or not text-based');
        const messageId = paramString(action.params?.messageId);
        if (!messageId) throw new Error('end_poll requires params.messageId');
        const msg = await channel.messages.fetch(messageId);
        if (!msg.poll) throw new Error(`Message ${messageId} does not contain a poll.`);
        if (msg.poll.resultsFinalized) return `Poll ${messageId} has already ended.`;
        await msg.poll.end();
        return `Ended poll ${messageId}; its results are now final.`;
      }
      case 'create_thread': {
        // Only text/announcement channels expose GuildTextThreadManager
        // (forum/media channels use a different, tag-based creation API this
        // tool doesn't support — out of scope, see docs/SECURITY.md §11).
        const channel = await this.client.channels.fetch(action.conversationId!);
        if (
          !channel ||
          (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)
        ) {
          throw new Error(`Discord channel ${action.conversationId} does not support threads`);
        }
        const name = await this.filtered(paramString(action.params?.name));
        if (!name) throw new Error('create_thread requires params.name');
        const seedMessageId = paramString(action.params?.seedMessageId) || undefined;
        const thread = await channel.threads.create({ name, startMessage: seedMessageId });
        return `Created thread "${name}" (${thread.id}).`;
      }
      case 'archive_thread': {
        const channel = await this.client.channels.fetch(action.conversationId!);
        if (!channel || !channel.isThread()) {
          throw new Error(`Discord channel ${action.conversationId} is not a thread`);
        }
        await channel.setArchived(true, paramString(action.params?.reason, 'Archived via bot'));
        return `Archived thread ${action.conversationId}.`;
      }
      case 'create_event': {
        // Requires the bot's role to hold Manage Events (docs/SECURITY.md).
        // A single atomic API call — either the whole event is created or
        // discord.js throws before anything is created, so there is no
        // half-created state to clean up if the permission is missing.
        const guild = await this.client.guilds.fetch(config.discord.guildId);
        const name = await this.filtered(paramString(action.params?.name));
        const rawDescription = paramString(action.params?.description);
        const description = rawDescription ? await this.filtered(rawDescription) : undefined;
        const startTime = paramString(action.params?.startTime);
        const endTime = paramString(action.params?.endTime) || undefined;
        const rawLocation = paramString(action.params?.location);

        // "location is either an external string or a validated channel the
        // bot can see" (issue #230): try to resolve it as a real, visible
        // voice/stage channel in THIS guild first — that becomes a proper
        // channel-hosted event (endTime optional). Anything else (not found,
        // a different guild, or a non-voice channel) falls back to treating
        // the raw string as an external/physical location, which Discord
        // requires an endTime for.
        const channel = await this.client.channels.fetch(rawLocation).catch(() => null);
        const isVoiceHosted =
          channel !== null &&
          !channel.isDMBased() &&
          channel.guild.id === guild.id &&
          (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice);

        const created = isVoiceHosted
          ? await guild.scheduledEvents.create({
              name,
              description,
              scheduledStartTime: startTime,
              scheduledEndTime: endTime,
              privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
              entityType:
                channel.type === ChannelType.GuildStageVoice
                  ? GuildScheduledEventEntityType.StageInstance
                  : GuildScheduledEventEntityType.Voice,
              channel: channel.id,
            })
          : await (async () => {
              if (!endTime) {
                throw new Error(
                  'An event at an external/physical location requires an endTime (Discord requires an ' +
                    'end time for events that are not hosted in a voice/stage channel).',
                );
              }
              return guild.scheduledEvents.create({
                name,
                description,
                scheduledStartTime: startTime,
                scheduledEndTime: endTime,
                privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
                entityType: GuildScheduledEventEntityType.External,
                entityMetadata: { location: await this.filtered(rawLocation) },
              });
            })();
        return `Created event "${created.name}" starting ${created.scheduledStartAt?.toISOString() ?? startTime}.`;
      }
      case 'cancel_event': {
        // The tool layer already validates the event live and its Scheduled
        // status before ever registering a CONFIRM (issue #424), but the
        // CONFIRM has a 60s TTL during which the event's state could change
        // (e.g. canceled directly in Discord's own UI) — re-check here too
        // rather than trust a stale pre-CONFIRM read.
        const guild = await this.client.guilds.fetch(config.discord.guildId);
        const eventId = paramString(action.params?.eventId);
        if (!eventId) throw new Error('cancel_event requires params.eventId');
        const event = await guild.scheduledEvents.fetch(eventId).catch(() => null);
        if (!event) throw new Error(`Scheduled event ${eventId} was not found.`);
        if (event.status !== GuildScheduledEventStatus.Scheduled) {
          throw new Error(
            `Event "${event.name}" is currently ${mapScheduledEventStatus(event.status)}, not scheduled — ` +
              'only a scheduled event can be canceled.',
          );
        }
        await guild.scheduledEvents.edit(eventId, { status: GuildScheduledEventStatus.Canceled });
        return `Canceled event "${event.name}".`;
      }
      default:
        throw new Error(`Unsupported Discord action: ${action.kind}`);
    }
  }

  /**
   * Resolve a role for assign/remove_community_role: must be on the
   * human-curated `DISCORD_ASSIGNABLE_ROLES` allowlist, and is always fetched
   * live (`force: true`, bypassing the gateway cache) since the permission
   * bitfield check that follows must see the role's current state, not a
   * possibly-stale cached one (see SECURITY.md).
   */
  private async resolveAssignableRole(guild: Guild, roleId: string): Promise<Role> {
    if (!config.discord.assignableRoleIds.includes(roleId)) {
      throw new Error(`Role ${roleId} is not on the assignable-role allowlist (DISCORD_ASSIGNABLE_ROLES).`);
    }
    const role = await guild.roles.fetch(roleId, { force: true });
    if (!role) throw new Error(`Role ${roleId} was not found in this guild.`);
    return role;
  }

  // --- Moderation enforcement (ModerationEnforcer) ---------------------------

  /** DM a warned member — same outbound filter as every other DM. */
  async warnUser(userId: string, text: string): Promise<void> {
    await this.sendDirectMessage(userId, text);
  }

  /**
   * React to an existing message with an emoji (issue #231). `emoji` is
   * already validated against a closed allowlist by the caller
   * (`react_to_message`) — this method trusts it and just forwards to
   * discord.js, same division of responsibility as `performAdminAction`.
   */
  async reactToMessage(conversationId: string, messageId: string, emoji: string): Promise<void> {
    const channel = await this.client.channels.fetch(conversationId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`Discord channel ${conversationId} is not accessible`);
    }
    const msg = await channel.messages.fetch(messageId);
    await msg.react(emoji);
  }

  /** Post an image attachment (with an optional caption) to a channel. */
  async sendImage(
    conversationId: string,
    image: { data: Buffer; filename: string; mimeType: string },
    caption?: string,
  ): Promise<void> {
    const channel = await this.client.channels.fetch(conversationId).catch(() => null);
    if (!channel?.isTextBased() || channel.isDMBased()) {
      throw new Error(`Discord channel ${conversationId} is not sendable`);
    }
    // Filter once and reuse for both fields — the attachment `description`
    // (screen-reader alt-text) must never carry unfiltered text that `content` doesn't.
    const filteredCaption = caption ? await this.filtered(caption) : undefined;
    await channel.send({
      content: filteredCaption,
      files: [{ attachment: image.data, name: image.filename, description: filteredCaption }],
      allowedMentions: { parse: [] },
    });
  }

  /** Post a public warning in the channel the offending message was posted in. */
  async warnInChannel(channelId: string, text: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased() || channel.isDMBased()) return;
    for (const chunk of chunkText(await this.filtered(text), MAX_DISCORD_LEN)) {
      await channel.send({ content: chunk, allowedMentions: { parse: [] } });
    }
  }

  /** Assign the muted role (creating it + its deny-post overwrites if missing). */
  async muteUser(userId: string): Promise<void> {
    const guild = await this.client.guilds.fetch(config.discord.guildId);
    const role = await this.ensureMutedRole(guild);
    const member = await guild.members.fetch(userId);
    await member.roles.add(role, 'Reached moderation warning limit');
  }

  /** Remove the muted role (idempotent). */
  async unmuteUser(userId: string): Promise<void> {
    await this.removeMutedRole(userId);
  }

  /** Post a moderation alert to the private admin channel (creating it if missing). */
  async postAdminAlert(text: string): Promise<void> {
    const channel = await this.ensureAdminChannel();
    for (const chunk of chunkText(await this.filtered(text), MAX_DISCORD_LEN)) {
      await channel.send({ content: chunk, allowedMentions: { parse: [] } });
    }
  }

  private async removeMutedRole(userId: string): Promise<void> {
    const guild = await this.client.guilds.fetch(config.discord.guildId);
    const role = this.findMutedRole(guild);
    if (!role) return;
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member?.roles.cache.has(role.id)) {
      await member.roles.remove(role, 'Warnings cleared by an admin');
    }
  }

  private findMutedRole(guild: Guild): Role | null {
    if (this.mutedRoleId) {
      const cached = guild.roles.cache.get(this.mutedRoleId);
      if (cached) return cached;
    }
    return guild.roles.cache.find((r) => r.name === config.moderation.mutedRoleName) ?? null;
  }

  /**
   * Find or create the muted role and make sure it actually blocks posting: a
   * deny-SendMessages overwrite is applied to every current text/forum channel
   * and category. `onChannelCreate` now applies the same overwrite the moment
   * a new channel or category appears, so this full re-scan is a fallback (a
   * channel created while the bot was offline, or a prior overwrite attempt
   * that failed) rather than the only path — see SECURITY.md. Needs the bot
   * to have Manage Roles + Manage Channels.
   */
  private async ensureMutedRole(guild: Guild): Promise<Role> {
    let role = this.findMutedRole(guild);
    if (!role) {
      role = await guild.roles.create({
        name: config.moderation.mutedRoleName,
        permissions: [],
        color: 0x607d8b,
        reason: 'Auto-moderation muted role',
      });
    }
    this.mutedRoleId = role.id;

    const channels = await guild.channels.fetch();
    const failed: { id: string; name: string }[] = [];
    for (const channel of channels.values()) {
      if (!channel || !this.isMutableOverwriteChannel(channel)) continue;
      if (!(await this.applyMutedRoleOverwrite(channel, role)))
        failed.push({ id: channel.id, name: channel.name });
    }
    if (failed.length > 0) await this.alertMutedRoleOverwriteFailures(failed);
    return role;
  }

  /**
   * New channels/categories don't inherit an existing muted role's overwrite
   * from Discord itself — creating a channel via the API never copies a
   * parent category's overwrites unless the client explicitly requests it, so
   * this fires for every new channel regardless of nesting, not just
   * top-level ones. Closes the "channels created later won't inherit it"
   * SECURITY.md gap; no-op if moderation is off, the channel is outside the
   * configured guild, its type never carries overwrites, or no mute has ever
   * happened (nothing to inherit yet).
   */
  private async onChannelCreate(channel: NonThreadGuildBasedChannel): Promise<void> {
    if (!config.moderation.enabled) return;
    if (channel.guild.id !== config.discord.guildId) return;
    if (!this.isMutableOverwriteChannel(channel)) return;
    const role = this.findMutedRole(channel.guild);
    if (!role) return;
    if (!(await this.applyMutedRoleOverwrite(channel, role))) {
      await this.alertMutedRoleOverwriteFailures([{ id: channel.id, name: channel.name }]);
    }
  }

  /**
   * Startup catch-up for the muted-role overwrites (SECURITY.md mute-bypass
   * gap). Unlike `ensureMutedRole`, this deliberately does NOT create the role
   * — if no member has ever been muted there is nothing to enforce yet — it
   * only re-applies the deny overwrite to every channel when the role already
   * exists, covering channels created while the bot was offline. No-op when
   * moderation is off or the role doesn't exist.
   */
  private async reconcileMutedRole(): Promise<void> {
    if (!config.moderation.enabled) return;
    try {
      const guild = await this.client.guilds.fetch(config.discord.guildId);
      const role = this.findMutedRole(guild);
      if (!role) return;
      this.mutedRoleId = role.id;
      const channels = await guild.channels.fetch();
      const failed: { id: string; name: string }[] = [];
      for (const channel of channels.values()) {
        if (!channel || !this.isMutableOverwriteChannel(channel)) continue;
        if (!(await this.applyMutedRoleOverwrite(channel, role)))
          failed.push({ id: channel.id, name: channel.name });
      }
      if (failed.length > 0) await this.alertMutedRoleOverwriteFailures(failed);
    } catch (err) {
      logger.warn({ err }, 'Muted-role startup reconcile failed');
    }
  }

  private isMutableOverwriteChannel(
    channel: GuildBasedChannel,
  ): channel is
    TextChannel | NewsChannel | ForumChannel | CategoryChannel | VoiceChannel | StageChannel | MediaChannel {
    return (
      channel.type === ChannelType.GuildText ||
      channel.type === ChannelType.GuildAnnouncement ||
      channel.type === ChannelType.GuildForum ||
      channel.type === ChannelType.GuildCategory ||
      // Voice/Stage channels have a built-in text chat and Media channels are
      // post-bearing like forums — a muted member could otherwise post freely
      // in any of them since the muted role carries no base permissions.
      channel.type === ChannelType.GuildVoice ||
      channel.type === ChannelType.GuildStageVoice ||
      channel.type === ChannelType.GuildMedia
    );
  }

  /**
   * Applies the deny-post overwrite, retrying a failure up to
   * `MUTED_ROLE_OVERWRITE_MAX_ATTEMPTS` times total (a transient Discord API
   * error self-heals within a second or two) before giving up on this
   * channel. Returns whether the overwrite ultimately landed — the caller
   * aggregates any `false` results into a single debounced alert rather than
   * this method silently bare-logging one, which is the residual gap issue
   * #276 closes (see SECURITY.md §6).
   */
  private async applyMutedRoleOverwrite(
    channel:
      TextChannel | NewsChannel | ForumChannel | CategoryChannel | VoiceChannel | StageChannel | MediaChannel,
    role: Role,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= MUTED_ROLE_OVERWRITE_MAX_ATTEMPTS; attempt += 1) {
      try {
        await channel.permissionOverwrites.edit(role, {
          SendMessages: false,
          SendMessagesInThreads: false,
          CreatePublicThreads: false,
          CreatePrivateThreads: false,
          AddReactions: false,
        });
        return true;
      } catch (err) {
        if (attempt === MUTED_ROLE_OVERWRITE_MAX_ATTEMPTS) {
          logger.warn({ err, channelId: channel.id }, 'Failed to apply muted-role overwrite after retries');
          return false;
        }
        logger.warn({ err, channelId: channel.id, attempt }, 'Muted-role overwrite attempt failed, retrying');
        await new Promise((resolve) => setTimeout(resolve, this.mutedRoleOverwriteRetryDelayMs));
      }
    }
    return false;
  }

  /**
   * Debounced super-admin DM when one or more channels exhaust their retries
   * during a mute-overwrite scan (`ensureMutedRole`/`reconcileMutedRole`) or a
   * single `onChannelCreate` handling — mirrors router.ts's
   * `alertSuperAdminsBudgetCheckFailed` shape (issue #203) for the same
   * "systemic background-op failure, debounced, not per-occurrence" posture.
   * A quiet scan (no failures) never calls this, so success sends nothing.
   * Payload is channel id/name only (server metadata, not message content or
   * a member identifier).
   */
  private async alertMutedRoleOverwriteFailures(failed: { id: string; name: string }[]): Promise<void> {
    if (
      !shouldNotifyMutedRoleOverwriteFailed(
        this.mutedRoleAlertNotifiedAt,
        Date.now(),
        MUTED_ROLE_ALERT_WINDOW_MS,
      )
    ) {
      return;
    }
    this.mutedRoleAlertNotifiedAt = Date.now();
    const list = failed.map((c) => `#${c.name} (${c.id})`).join(', ');
    const message =
      `⚠️ Muted-role overwrite failed after retries for ${failed.length} channel(s): ${list}. ` +
      'A muted member may be able to post there until the next mute or restart re-scans it. Check logs / Discord API health.';
    for (const id of superAdminIds('discord')) {
      await this.sendDirectMessage(id, message).catch((err) =>
        logger.warn({ err, id }, 'Muted-role overwrite failure alert DM failed'),
      );
    }
  }

  /**
   * Find or create the private admin alerts channel: @everyone can't view it,
   * the bot can view+send, and the configured super admins can view. Discord
   * members with the Administrator permission see it regardless of overwrites.
   */
  private async ensureAdminChannel(): Promise<TextChannel> {
    const guild = await this.client.guilds.fetch(config.discord.guildId);
    if (this.adminChannelId) {
      const cached = await this.client.channels.fetch(this.adminChannelId).catch(() => null);
      if (cached?.type === ChannelType.GuildText) return cached;
    }
    const channels = await guild.channels.fetch();
    const existing = channels.find(
      (c): c is TextChannel =>
        c?.type === ChannelType.GuildText && c.name === config.moderation.adminChannelName,
    );
    if (existing) {
      this.adminChannelId = existing.id;
      return existing;
    }

    const botId = this.client.user?.id;
    const created = await guild.channels.create({
      name: config.moderation.adminChannelName,
      type: ChannelType.GuildText,
      topic: 'Private moderation alerts — bad-language/abuse warnings and blocks.',
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        ...(botId
          ? [{ id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }]
          : []),
        ...config.rbac.superAdminDiscordIds.map((id) => ({
          id,
          allow: [PermissionFlagsBits.ViewChannel],
        })),
      ],
      reason: 'Auto-moderation admin alerts channel',
    });
    this.adminChannelId = created.id;
    return created;
  }
}
