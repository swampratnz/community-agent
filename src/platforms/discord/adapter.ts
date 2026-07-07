import {
  Client,
  Events,
  GatewayIntentBits,
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
  ChannelType,
} from 'discord.js';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { filterOutbound } from '../../agent/outbound.js';
import { runtimeSecrets } from '../../agent/secrets.js';
import { getCodeAnswersPolicy, getCommunityGuidelines } from '../../storage/policies.js';
import { createModerator, type ModerationEnforcer, type Moderator } from '../../moderation/index.js';
import { atLeast } from '../../auth/rbac.js';
import { resolveRole } from '../../auth/roles.js';
import {
  countActiveWarnings,
  deleteInteractionByMessageId,
  markRosterLeave,
  updateInteractionByMessageId,
  upsertRosterMember,
} from '../../storage/repository.js';
import { chunkText } from '../textChunk.js';
import {
  paramString,
  type AdminAction,
  type IncomingMessage,
  type MessageHandler,
  type OutgoingMessage,
  type PlatformAdapter,
} from '../types.js';

const MAX_DISCORD_LEN = 2000;
const MEMBERSHIP_CACHE_TTL_MS = 60_000;

export const WELCOME_MESSAGE =
  "Kia ora, welcome! 👋 This server's bot answers Claude/Anthropic questions and remembers context, " +
  'but it only replies to registered members. Ask an admin to add you, or just say hi to the bot here ' +
  'and an admin will see your request.';

export class DiscordAdapter implements PlatformAdapter, ModerationEnforcer {
  readonly platform = 'discord' as const;
  readonly adminCapabilities = new Set([
    'timeout_user',
    'kick_user',
    'delete_message',
    'warn_user',
    'unmute_user',
    'assign_community_role',
    'remove_community_role',
    'list_assignable_roles',
    'create_poll',
    'create_thread',
    'archive_thread',
  ]);

  private readonly client: Client;
  private handler: MessageHandler | null = null;
  private readonly membershipCache = new Map<string, { expires: number; ids: string[] }>();
  private connected = false;
  private readonly moderator: Moderator;
  // Resolved lazily on first use and cached: the muted role and the admin
  // alerts channel are created on demand (needs Manage Roles / Manage Channels).
  private mutedRoleId: string | null = null;
  private adminChannelId: string | null = null;

  constructor() {
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
   * member has DMs closed. When community guidelines are set (issue #212),
   * they're appended verbatim to the static message — never run through the
   * model, so there's no paraphrase risk on this path.
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

    const guidelines = await getCommunityGuidelines();
    const welcomeText = guidelines
      ? `${WELCOME_MESSAGE}\n\nCommunity guidelines:\n${guidelines}`
      : WELCOME_MESSAGE;

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
    await markRosterLeave('discord', member.id).catch((err) =>
      logger.warn({ err, userId: member.id }, 'Roster leave record failed'),
    );
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
   */
  private async filtered(text: string): Promise<string> {
    return filterOutbound(text, await getCodeAnswersPolicy(), runtimeSecrets());
  }

  async sendMessage(out: OutgoingMessage): Promise<void> {
    const channel = await this.client.channels.fetch(out.conversationId);
    if (!channel || !channel.isTextBased() || !('send' in channel)) {
      throw new Error(`Discord channel ${out.conversationId} is not sendable`);
    }
    // Discord caps messages at 2000 chars; chunk longer replies. Mentions are
    // never parsed so an injected "@everyone" can't mass-ping. SuppressEmbeds
    // stops Discord from expanding any links in the reply into preview cards.
    for (const chunk of chunkText(await this.filtered(out.text), MAX_DISCORD_LEN)) {
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
   * DM with the bot. Backs admin conversation scoping; cached ~60s (a member
   * removed from a channel may retain scope for up to the TTL — documented in
   * SECURITY.md).
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
            allowMultiselect: false,
          },
          // Poll question/answer text is a distinct media field (not
          // `content`) and isn't mention-parsed, but every other outbound
          // path here sets this — keep the invariant textually true rather
          // than relying on that Discord behavior being unstated.
          allowedMentions: { parse: [] },
        });
        return `Poll posted with ${answers.length} option(s), open ${durationHours}h.`;
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
    for (const channel of channels.values()) {
      if (!channel || !this.isMutableOverwriteChannel(channel)) continue;
      await this.applyMutedRoleOverwrite(channel, role);
    }
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
    await this.applyMutedRoleOverwrite(channel, role);
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
      for (const channel of channels.values()) {
        if (!channel || !this.isMutableOverwriteChannel(channel)) continue;
        await this.applyMutedRoleOverwrite(channel, role);
      }
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

  private async applyMutedRoleOverwrite(
    channel:
      TextChannel | NewsChannel | ForumChannel | CategoryChannel | VoiceChannel | StageChannel | MediaChannel,
    role: Role,
  ): Promise<void> {
    try {
      await channel.permissionOverwrites.edit(role, {
        SendMessages: false,
        SendMessagesInThreads: false,
        CreatePublicThreads: false,
        CreatePrivateThreads: false,
        AddReactions: false,
      });
    } catch (err) {
      logger.warn({ err, channelId: channel.id }, 'Failed to apply muted-role overwrite');
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
