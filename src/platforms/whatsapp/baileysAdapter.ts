import { Boom } from '@hapi/boom';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type BaileysEventMap,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { filterOutbound } from '../../agent/outbound.js';
import { runtimeSecrets } from '../../agent/secrets.js';
import { getCodeAnswersPolicy } from '../../storage/policies.js';
import {
  extractText,
  isLidJid,
  isPhoneUserId,
  jidLocalPart,
  lidFallbackId,
  senderPhoneNumber,
} from './wire.js';
import {
  paramString,
  type AdminAction,
  type IncomingMessage,
  type MessageHandler,
  type OutgoingMessage,
  type PlatformAdapter,
} from '../types.js';

const MAX_RECONNECT_DELAY_MS = 5 * 60_000;
const MEMBERSHIP_CACHE_TTL_MS = 60_000;

// Generic and static — no @-mention or echo of the joiner, so a bulk add
// can't be turned into a mass-ping and no participant JID reaches the chat.
const WHATSAPP_GROUP_WELCOME_MESSAGE =
  "Kia ora! 👋 This bot only replies to registered members. If you're new here, ask an admin in this group to add you as a member.";

export interface WelcomeCooldownState {
  readonly lastSentAt: Readonly<Record<string, number>>;
}

export function initialWelcomeCooldownState(): WelcomeCooldownState {
  return { lastSentAt: {} };
}

/**
 * Pure per-group latch, same shape as usageAlert.ts's stepUsageAlertTracker:
 * at most one welcome per group per `cooldownMs`, so a burst of sequential
 * joins collapses into a single message instead of one per join.
 */
export function stepWelcomeCooldown(
  state: WelcomeCooldownState,
  groupJid: string,
  now: number,
  cooldownMs: number,
): { state: WelcomeCooldownState; shouldSend: boolean } {
  const last = state.lastSentAt[groupJid];
  if (last !== undefined && now - last < cooldownMs) {
    return { state, shouldSend: false };
  }
  return { state: { lastSentAt: { ...state.lastSentAt, [groupJid]: now } }, shouldSend: true };
}

/**
 * WhatsApp via Baileys (unofficial WhatsApp Web protocol, dedicated number).
 * Link the number once with `npm run whatsapp:link`, then this adapter reuses
 * the stored credentials in WHATSAPP_AUTH_DIR.
 */
export class BaileysAdapter implements PlatformAdapter {
  readonly platform = 'whatsapp' as const;
  readonly adminCapabilities = new Set(['warn_user', 'kick_user', 'delete_message']);

  private sock: WASocket | null = null;
  private handler: MessageHandler | null = null;
  private botNumber = '';
  private botLid = '';
  private stopped = false;
  private connected = false;
  private reconnectAttempts = 0;
  private readonly membershipCache = new Map<string, { expires: number; ids: string[] }>();
  /** WA Web version is fetched once and reused across reconnects. */
  private cachedVersion: [number, number, number] | null = null;
  private welcomeCooldown: WelcomeCooldownState = initialWelcomeCooldownState();

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(3_000 * 2 ** (this.reconnectAttempts - 1), MAX_RECONNECT_DELAY_MS);
    logger.warn({ attempt: this.reconnectAttempts, delayMs: delay }, 'Scheduling WhatsApp reconnect');
    setTimeout(() => {
      this.connect().catch((err) => {
        // connect() can itself fail (e.g. network still down) — keep retrying
        // with backoff instead of dying permanently.
        logger.error({ err }, 'WA reconnect failed; will retry');
        this.scheduleReconnect();
      });
    }, delay);
  }

  private async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(config.whatsapp.authDir);
    if (!this.cachedVersion) {
      try {
        const { version } = await fetchLatestBaileysVersion();
        this.cachedVersion = version;
      } catch (err) {
        logger.warn({ err }, 'Could not fetch WA Web version; using Baileys default');
      }
    }

    // Tear down any previous socket before replacing it.
    this.sock?.end(undefined);

    const sock = makeWASocket({
      ...(this.cachedVersion ? { version: this.cachedVersion } : {}),
      auth: state,
      printQRInTerminal: false,
      // Baileys is chatty; route its logs through pino at warn+.
      logger: logger.child({ mod: 'baileys' }),
    });
    this.sock = sock;

    sock.ev.on('creds.update', () => {
      saveCreds().catch((err: unknown) => logger.error({ err }, 'Failed to save Baileys credentials'));
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        logger.info('Scan this QR with WhatsApp > Linked Devices to link the bot number:');
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'open') {
        this.connected = true;
        this.reconnectAttempts = 0;
        this.botNumber = jidLocalPart(sock.user?.id);
        this.botLid = jidLocalPart((sock.user as { lid?: string } | undefined)?.lid);
        logger.info({ number: this.botNumber }, 'WhatsApp connected');
      }
      if (connection === 'close') {
        this.connected = false;
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        logger.warn({ statusCode, loggedOut }, 'WhatsApp connection closed');
        if (loggedOut) {
          logger.error('WhatsApp logged out — re-run `npm run whatsapp:link` to re-pair.');
        } else {
          this.scheduleReconnect();
        }
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        this.onWhatsappMessage(msg).catch((err) => logger.error({ err }, 'WA message handling failed'));
      }
    });

    sock.ev.on('group-participants.update', (update) => {
      this.onGroupParticipantsUpdate(update).catch((err) =>
        logger.error({ err }, 'WhatsApp group welcome failed'),
      );
    });
  }

  private async onWhatsappMessage(msg: WAMessage): Promise<void> {
    if (!this.handler) return;
    if (msg.key.fromMe) return; // ignore our own messages
    const remoteJid = msg.key.remoteJid;
    if (!remoteJid || remoteJid === 'status@broadcast') return;

    const isGroup = remoteJid.endsWith('@g.us');
    // A non-group chat is a DM whether it's routed by phone JID or LID.
    const isDirect = remoteJid.endsWith('@s.whatsapp.net') || isLidJid(remoteJid);
    if (!isGroup && !isDirect) return; // newsletters/broadcast lists etc.

    // Optional allowlist of conversations.
    if (config.whatsapp.allowedJids.length > 0 && !config.whatsapp.allowedJids.includes(remoteJid)) {
      return;
    }

    const senderNumber = senderPhoneNumber(msg, isGroup);
    const { text: rawText, contextInfo } = extractText(msg);

    // In groups, only respond if the bot is mentioned OR the message quotes
    // (replies to) one of the bot's messages. mentionedJid entries may be
    // phone JIDs or LIDs — match either identity of the bot.
    const isBotJid = (j: string | null | undefined) => {
      const local = jidLocalPart(j);
      return local !== '' && (local === this.botNumber || (this.botLid !== '' && local === this.botLid));
    };
    const mentioned = contextInfo?.mentionedJid?.some(isBotJid) ?? false;
    const repliedToBot = isBotJid(contextInfo?.participant);

    // Strip the bot's own mention token(s) so "@bot CONFIRM" classifies
    // cleanly (mirrors the Discord adapter stripping <@id>).
    let text = rawText;
    for (const id of [this.botNumber, this.botLid]) {
      if (id) text = text.split(`@${id}`).join(' ');
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) return;

    // Identity must be a real phone number for tier resolution to work. A
    // LID sender without a resolvable number gets a `lid:`-prefixed id: it
    // can never match a member/admin grant AND can never be mis-routed as a
    // phone JID by warn/kick (see performAdminAction's isPhoneUserId guard).
    const rawFallback = jidLocalPart(isGroup ? msg.key.participant : remoteJid);
    const senderId = senderNumber || (rawFallback ? lidFallbackId(rawFallback) : 'unknown');

    const normalised: IncomingMessage = {
      platform: 'whatsapp',
      conversationId: remoteJid,
      userId: senderId,
      userName: msg.pushName ?? senderId,
      text,
      isDirect,
      addressedToBot: isDirect || mentioned || repliedToBot,
      timestamp: Number(msg.messageTimestamp ?? 0) * 1000,
      raw: msg,
    };

    await this.handler(normalised);
  }

  /**
   * WhatsApp's analogue of Discord's onGuildMemberAdd: `group-participants.update`
   * fires whenever someone joins (or is added to) a group the linked number is
   * in. Off unless WHATSAPP_WELCOME_ENABLED=true. Posts ONE static, non-agent
   * message (no LLM call) to the group itself — deliberately never a 1:1 DM to
   * the new participant, since an unsolicited DM to a stranger's number is
   * exactly the Baileys ban-risk pattern this avoids. Baileys batches
   * simultaneous joins into one event already; the cooldown additionally
   * collapses sequential joins across time into a single message per window.
   */
  private async onGroupParticipantsUpdate(
    update: BaileysEventMap['group-participants.update'],
  ): Promise<void> {
    if (!config.whatsapp.welcome.enabled) return;
    if (update.action !== 'add') return;
    if (config.whatsapp.allowedJids.length > 0 && !config.whatsapp.allowedJids.includes(update.id)) return;
    if (!this.sock) return;

    const cooldownMs = config.whatsapp.welcome.cooldownMinutes * 60_000;
    const step = stepWelcomeCooldown(this.welcomeCooldown, update.id, Date.now(), cooldownMs);
    this.welcomeCooldown = step.state;
    if (!step.shouldSend) return;

    await this.sock.sendMessage(update.id, { text: WHATSAPP_GROUP_WELCOME_MESSAGE });
  }

  /**
   * Every outbound path is filtered HERE (secret redaction + code policy) so
   * no caller — router reply, announce, warn, super-admin alert — can forget.
   */
  private async filtered(text: string): Promise<string> {
    return filterOutbound(text, await getCodeAnswersPolicy(), runtimeSecrets(), 'whatsapp');
  }

  async sendMessage(out: OutgoingMessage): Promise<void> {
    if (!this.sock) throw new Error('WhatsApp socket not connected');
    await this.sock.sendMessage(out.conversationId, { text: await this.filtered(out.text) });
    // Clear the "composing" indicator now that the reply has actually sent.
    // Best-effort: a presence update failing here must not affect the send
    // that already succeeded above.
    this.sock
      .sendPresenceUpdate('paused', out.conversationId)
      .catch((err) => logger.debug({ err }, 'Failed to clear WhatsApp presence'));
  }

  /** Best-effort "composing…" presence update while a turn is in flight. */
  async sendTypingIndicator(message: IncomingMessage): Promise<void> {
    if (!this.sock) return;
    await this.sock.sendPresenceUpdate('composing', message.conversationId);
  }

  async sendDirectMessage(userId: string, text: string): Promise<void> {
    if (!this.sock) throw new Error('WhatsApp socket not connected');
    if (!isPhoneUserId(userId)) {
      throw new Error(`Refusing to DM "${userId}": not a phone-number id (LID-only sender?).`);
    }
    await this.sock.sendMessage(`${userId}@s.whatsapp.net`, { text: await this.filtered(text) });
  }

  /**
   * WhatsApp groups this user (phone number) is currently a participant of,
   * plus their own 1:1 with the bot. Backs admin conversation scoping;
   * cached ~60s (see SECURITY.md for the staleness window).
   */
  async conversationsForUser(userId: string): Promise<string[]> {
    const cached = this.membershipCache.get(userId);
    if (cached && cached.expires > Date.now()) return cached.ids;

    // Their own 1:1 with the bot (phone ids only; lid: fallbacks have their
    // DM keyed by the LID JID instead).
    const ids: string[] = isPhoneUserId(userId)
      ? [`${userId}@s.whatsapp.net`]
      : userId.startsWith('lid:')
        ? [`${userId.slice(4)}@lid`]
        : [];
    try {
      if (!this.sock) throw new Error('socket not connected');
      const groups = await this.sock.groupFetchAllParticipating();
      for (const [jid, meta] of Object.entries(groups)) {
        const inGroup = meta.participants?.some((p) => {
          const pid = jidLocalPart(p.id);
          const pn = jidLocalPart((p as { phoneNumber?: string }).phoneNumber);
          return pid === userId || pn === userId || lidFallbackId(pid) === userId;
        });
        if (inGroup) ids.push(jid);
      }
    } catch (err) {
      logger.warn({ err, userId }, 'Failed to resolve WhatsApp conversations for user');
    }

    this.membershipCache.set(userId, { expires: Date.now() + MEMBERSHIP_CACHE_TTL_MS, ids });
    return ids;
  }

  /**
   * Targets must be plain phone-number ids. `lid:`-fallback ids (or anything
   * else) are refused: LID digits routed as a phone JID could hit an
   * unrelated real number.
   */
  private targetJid(userId: string | undefined): string {
    if (!userId || !isPhoneUserId(userId)) {
      throw new Error(
        `Refusing to act on "${userId ?? ''}": not a phone-number id. ` +
          `(LID-only senders cannot be targeted until their number is known.)`,
      );
    }
    return `${userId}@s.whatsapp.net`;
  }

  async performAdminAction(action: AdminAction): Promise<string> {
    if (!this.sock) throw new Error('WhatsApp socket not connected');
    switch (action.kind) {
      case 'warn_user': {
        await this.sendDirectMessage(
          action.targetUserId ?? '',
          `⚠️ Warning from NZ Claude Community: ${paramString(action.params?.reason)}`,
        );
        return `Warned ${action.targetUserId}.`;
      }
      case 'kick_user': {
        const groupJid = action.conversationId;
        if (!groupJid?.endsWith('@g.us')) throw new Error('kick_user requires a group conversationId');
        await this.sock.groupParticipantsUpdate(groupJid, [this.targetJid(action.targetUserId)], 'remove');
        return `Removed ${action.targetUserId} from the group.`;
      }
      case 'delete_message': {
        const groupJid = action.conversationId!;
        const messageId = paramString(action.params?.messageId);
        if (!messageId) throw new Error('delete_message requires params.messageId');
        // Revoking someone else's group message requires the author in the key.
        await this.sock.sendMessage(groupJid, {
          delete: {
            remoteJid: groupJid,
            id: messageId,
            fromMe: false,
            participant: this.targetJid(action.targetUserId),
          },
        });
        return `Deleted message ${messageId}.`;
      }
      default:
        throw new Error(`Unsupported WhatsApp action: ${action.kind}`);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.connected = false;
    this.sock?.end(undefined);
  }

  isConnected(): boolean {
    return this.connected;
  }
}
