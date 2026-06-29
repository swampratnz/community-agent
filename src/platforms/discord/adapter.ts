import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
  ChannelType,
} from 'discord.js';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { resolveDiscordRole } from '../../auth/rbac.js';
import type {
  AdminAction,
  IncomingMessage,
  MessageHandler,
  OutgoingMessage,
  PlatformAdapter,
} from '../types.js';

const MAX_DISCORD_LEN = 2000;

export class DiscordAdapter implements PlatformAdapter {
  readonly platform = 'discord' as const;
  readonly adminCapabilities = new Set(['timeout_user', 'kick_user', 'delete_message', 'warn_user']);

  private readonly client: Client;
  private handler: MessageHandler | null = null;

  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.client.on(Events.MessageCreate, (message) => {
      this.onDiscordMessage(message).catch((err) => logger.error({ err }, 'Discord message handling failed'));
    });

    this.client.once(Events.ClientReady, (c) => {
      logger.info({ user: c.user.tag }, 'Discord connected');
    });

    await this.client.login(config.discord.botToken);
  }

  async stop(): Promise<void> {
    await this.client.destroy();
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
      message.reference?.messageId != null &&
      (await this.isReplyToBot(message).catch(() => false));

    const memberRoleIds = message.member ? [...message.member.roles.cache.keys()] : [];
    const role = resolveDiscordRole(message.author.id, memberRoleIds, {
      adminRoleIds: config.discord.adminRoleIds,
      adminUserIds: config.discord.adminUserIds,
    });

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
      role,
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

  async sendMessage(out: OutgoingMessage): Promise<void> {
    const channel = await this.client.channels.fetch(out.conversationId);
    if (!channel || !channel.isTextBased() || !('send' in channel)) {
      throw new Error(`Discord channel ${out.conversationId} is not sendable`);
    }
    // Discord caps messages at 2000 chars; chunk longer replies.
    for (const chunk of chunkText(out.text, MAX_DISCORD_LEN)) {
      await channel.send(chunk);
    }
  }

  async performAdminAction(action: AdminAction): Promise<string> {
    const guild = await this.client.guilds.fetch(config.discord.guildId);

    switch (action.kind) {
      case 'timeout_user': {
        const member = await guild.members.fetch(action.targetUserId!);
        const minutes = Number(action.params?.durationMinutes ?? 10);
        await member.timeout(minutes * 60_000, String(action.params?.reason ?? 'No reason given'));
        return `Timed out ${member.user.tag} for ${minutes} minute(s).`;
      }
      case 'kick_user': {
        const member = await guild.members.fetch(action.targetUserId!);
        await member.kick(String(action.params?.reason ?? 'No reason given'));
        return `Kicked ${member.user.tag}.`;
      }
      case 'delete_message': {
        const channel = await this.client.channels.fetch(action.conversationId!);
        if (!channel || !channel.isTextBased()) throw new Error('Channel not found or not text-based');
        const messageId = String(action.params?.messageId ?? '');
        if (!messageId) throw new Error('delete_message requires params.messageId');
        const msg = await channel.messages.fetch(messageId);
        await msg.delete();
        return `Deleted message ${messageId}.`;
      }
      case 'warn_user': {
        // A "warn" is a DM to the user; recorded in the audit log by the caller.
        const user = await this.client.users.fetch(action.targetUserId!);
        await user.send(`⚠️ Warning from NZ Claude Community moderators: ${action.params?.reason ?? ''}`);
        return `Warned ${user.tag}.`;
      }
      default:
        throw new Error(`Unsupported Discord action: ${action.kind}`);
    }
  }
}

function chunkText(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > size) {
    let cut = remaining.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = size; // avoid tiny chunks if no newline near the limit
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
