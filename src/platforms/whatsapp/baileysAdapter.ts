import { Boom } from '@hapi/boom';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { extractText, isLidJid, jidLocalPart, senderPhoneNumber } from './wire.js';
import type {
  AdminAction,
  IncomingMessage,
  MessageHandler,
  OutgoingMessage,
  PlatformAdapter,
} from '../types.js';

const MAX_RECONNECT_DELAY_MS = 5 * 60_000;
const MEMBERSHIP_CACHE_TTL_MS = 60_000;

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
  private reconnectAttempts = 0;
  private readonly membershipCache = new Map<string, { expires: number; ids: string[] }>();
  /** WA Web version is fetched once and reused across reconnects. */
  private cachedVersion: [number, number, number] | null = null;

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
        this.cachedVersion = version as [number, number, number];
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
      logger: logger.child({ mod: 'baileys' }) as never,
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        logger.info('Scan this QR with WhatsApp > Linked Devices to link the bot number:');
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'open') {
        this.reconnectAttempts = 0;
        this.botNumber = jidLocalPart(sock.user?.id);
        this.botLid = jidLocalPart((sock.user as { lid?: string } | undefined)?.lid);
        logger.info({ number: this.botNumber }, 'WhatsApp connected');
      }
      if (connection === 'close') {
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
    const text = rawText.trim();
    if (!text) return;

    // In groups, only respond if the bot is mentioned. mentionedJid entries
    // may be phone JIDs or LIDs — match either identity of the bot.
    const mentioned =
      contextInfo?.mentionedJid?.some((j) => {
        const local = jidLocalPart(j);
        return local === this.botNumber || (this.botLid !== '' && local === this.botLid);
      }) ?? false;

    // Identity must be a real phone number for tier resolution to work; a
    // LID sender without a resolvable number falls back to the LID and can
    // therefore never match a member/admin/super-admin grant.
    const senderId =
      senderNumber || jidLocalPart(isGroup ? msg.key.participant : remoteJid) || 'unknown';

    const normalised: IncomingMessage = {
      platform: 'whatsapp',
      conversationId: remoteJid,
      userId: senderId,
      userName: msg.pushName ?? senderId,
      text,
      isDirect,
      addressedToBot: isDirect || mentioned,
      timestamp: Number(msg.messageTimestamp ?? 0) * 1000,
      raw: msg,
    };

    await this.handler(normalised);
  }

  async sendMessage(out: OutgoingMessage): Promise<void> {
    if (!this.sock) throw new Error('WhatsApp socket not connected');
    await this.sock.sendMessage(out.conversationId, { text: out.text });
  }

  async sendDirectMessage(userId: string, text: string): Promise<void> {
    if (!this.sock) throw new Error('WhatsApp socket not connected');
    await this.sock.sendMessage(`${userId}@s.whatsapp.net`, { text });
  }

  /**
   * WhatsApp groups this user (phone number) is currently a participant of,
   * plus their own 1:1 with the bot. Backs admin conversation scoping;
   * cached ~60s (see SECURITY.md for the staleness window).
   */
  async conversationsForUser(userId: string): Promise<string[]> {
    const cached = this.membershipCache.get(userId);
    if (cached && cached.expires > Date.now()) return cached.ids;

    const ids: string[] = [`${userId}@s.whatsapp.net`];
    try {
      if (!this.sock) throw new Error('socket not connected');
      const groups = await this.sock.groupFetchAllParticipating();
      for (const [jid, meta] of Object.entries(groups)) {
        const inGroup = meta.participants?.some((p) => {
          const pid = jidLocalPart(p.id);
          const pn = jidLocalPart((p as { phoneNumber?: string }).phoneNumber);
          return pid === userId || pn === userId;
        });
        if (inGroup) ids.push(jid);
      }
    } catch (err) {
      logger.warn({ err, userId }, 'Failed to resolve WhatsApp conversations for user');
    }

    this.membershipCache.set(userId, { expires: Date.now() + MEMBERSHIP_CACHE_TTL_MS, ids });
    return ids;
  }

  async performAdminAction(action: AdminAction): Promise<string> {
    if (!this.sock) throw new Error('WhatsApp socket not connected');
    switch (action.kind) {
      case 'warn_user': {
        const jid = `${action.targetUserId}@s.whatsapp.net`;
        await this.sock.sendMessage(jid, {
          text: `⚠️ Warning from NZ Claude Community: ${action.params?.reason ?? ''}`,
        });
        return `Warned ${action.targetUserId}.`;
      }
      case 'kick_user': {
        const groupJid = action.conversationId;
        if (!groupJid?.endsWith('@g.us')) throw new Error('kick_user requires a group conversationId');
        const jid = `${action.targetUserId}@s.whatsapp.net`;
        await this.sock.groupParticipantsUpdate(groupJid, [jid], 'remove');
        return `Removed ${action.targetUserId} from the group.`;
      }
      case 'delete_message': {
        const groupJid = action.conversationId!;
        const messageId = String(action.params?.messageId ?? '');
        if (!messageId) throw new Error('delete_message requires params.messageId');
        if (!action.targetUserId) throw new Error('delete_message requires the author (targetUserId)');
        // Revoking someone else's group message requires the author in the key.
        await this.sock.sendMessage(groupJid, {
          delete: {
            remoteJid: groupJid,
            id: messageId,
            fromMe: false,
            participant: `${action.targetUserId}@s.whatsapp.net`,
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
    this.sock?.end(undefined);
  }
}
