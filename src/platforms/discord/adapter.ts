import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type GuildMember,
  type PartialGuildMember,
  type Message,
  ChannelType,
} from 'discord.js';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { filterOutbound } from '../../agent/outbound.js';
import { runtimeSecrets } from '../../agent/secrets.js';
import { getCodeAnswersPolicy } from '../../storage/policies.js';
import { markRosterLeave, upsertRosterMember } from '../../storage/repository.js';
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

const WELCOME_MESSAGE =
  "Kia ora, welcome! 👋 This server's bot answers Claude/Anthropic questions and remembers context, " +
  'but it only replies to registered members. Ask an admin to add you, or just say hi to the bot here ' +
  'and an admin will see your request.';

export class DiscordAdapter implements PlatformAdapter {
  readonly platform = 'discord' as const;
  readonly adminCapabilities = new Set(['timeout_user', 'kick_user', 'delete_message', 'warn_user']);

  private readonly client: Client;
  private handler: MessageHandler | null = null;
  private readonly membershipCache = new Map<string, { expires: number; ids: string[] }>();
  private connected = false;

  constructor() {
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

    this.client.on(Events.GuildMemberAdd, (member) => {
      this.onGuildMemberAdd(member).catch((err) => logger.error({ err }, 'Member join handling failed'));
    });
    this.client.on(Events.GuildMemberRemove, (member) => {
      this.onGuildMemberRemove(member).catch((err) => logger.error({ err }, 'Roster leave failed'));
    });

    this.client.once(Events.ClientReady, (c) => {
      this.connected = true;
      logger.info({ user: c.user.tag }, 'Discord connected');
      // One-shot idempotent roster backfill so "everyone already here" is
      // covered, not just future joiners. Fire-and-forget: a backfill
      // failure must never block message handling.
      void this.backfillRoster();
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

    // Optional channel allowlist.
    if (
      !isDM &&
      config.discord.allowedChannelIds.length > 0 &&
      !config.discord.allowedChannelIds.includes(message.channelId)
    ) {
      return;
    }

    const botId = this.client.user?.id;
    const mentioned = botId ? message.mentions.users.has(botId) : false;
    const repliedToBot =
      message.reference?.messageId != null && (await this.isReplyToBot(message).catch(() => false));

    // Strip the bot mention from the text for a clean prompt.
    const cleanText = botId
      ? message.content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim()
      : message.content.trim();

    const normalised: IncomingMessage = {
      platform: 'discord',
      conversationId: message.channelId,
      userId: message.author.id,
      userName: message.member?.displayName ?? message.author.username,
      text: cleanText,
      isDirect: isDM,
      addressedToBot: mentioned || repliedToBot,
      timestamp: message.createdTimestamp,
      raw: message,
    };

    await this.handler(normalised);
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
   * member has DMs closed.
   */
  private async onGuildMemberAdd(member: GuildMember): Promise<void> {
    if (member.guild.id !== config.discord.guildId) return;

    if (!member.user.bot) {
      await upsertRosterMember({
        platform: 'discord',
        userId: member.id,
        displayName: member.displayName,
      }).catch((err) => logger.warn({ err, userId: member.id }, 'Roster join record failed'));
    }

    if (!config.discord.welcome.enabled) return;

    try {
      await member.send({ content: WELCOME_MESSAGE, allowedMentions: { parse: [] } });
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
        content: `Welcome <@${member.id}>! ${WELCOME_MESSAGE}`,
        allowedMentions: { users: [member.id] },
      });
    } catch (err) {
      logger.warn({ err, userId: member.id, channelId }, 'Welcome channel fallback failed');
    }
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
    // never parsed so an injected "@everyone" can't mass-ping.
    for (const chunk of chunkText(await this.filtered(out.text), MAX_DISCORD_LEN)) {
      await channel.send({ content: chunk, allowedMentions: { parse: [] } });
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
      await user.send({ content: chunk, allowedMentions: { parse: [] } });
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
    const guild = await this.client.guilds.fetch(config.discord.guildId);

    switch (action.kind) {
      case 'timeout_user': {
        const member = await guild.members.fetch(action.targetUserId!);
        const minutes = Number(action.params?.durationMinutes ?? 10);
        await member.timeout(minutes * 60_000, paramString(action.params?.reason, 'No reason given'));
        return `Timed out ${member.user.tag} for ${minutes} minute(s).`;
      }
      case 'kick_user': {
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
      default:
        throw new Error(`Unsupported Discord action: ${action.kind}`);
    }
  }
}
