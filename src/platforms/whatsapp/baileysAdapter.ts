import { Boom } from '@hapi/boom';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WASocket,
  type proto,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { resolveWhatsappRole } from '../../auth/rbac.js';
import type {
  AdminAction,
  IncomingMessage,
  MessageHandler,
  OutgoingMessage,
  PlatformAdapter,
} from '../types.js';

/** Strip the device suffix and domain from a JID to get a bare phone number. */
function jidToNumber(jid: string | undefined | null): string {
  if (!jid) return '';
  return jid.split('@')[0].split(':')[0];
}

function extractText(msg: proto.IWebMessageInfo): string {
  const m = msg.message;
  if (!m) return '';
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    ''
  );
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
  private stopped = false;

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(config.whatsapp.authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
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
        this.botNumber = jidToNumber(sock.user?.id);
        logger.info({ number: this.botNumber }, 'WhatsApp connected');
      }
      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        logger.warn({ statusCode, loggedOut }, 'WhatsApp connection closed');
        if (!loggedOut && !this.stopped) {
          setTimeout(() => this.connect().catch((err) => logger.error({ err }, 'WA reconnect failed')), 3_000);
        } else if (loggedOut) {
          logger.error('WhatsApp logged out — re-run `npm run whatsapp:link` to re-pair.');
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

  private async onWhatsappMessage(msg: proto.IWebMessageInfo): Promise<void> {
    if (!this.handler) return;
    if (msg.key.fromMe) return; // ignore our own messages
    const remoteJid = msg.key.remoteJid;
    if (!remoteJid || remoteJid === 'status@broadcast') return;

    const isGroup = remoteJid.endsWith('@g.us');
    const isDirect = remoteJid.endsWith('@s.whatsapp.net');

    // Optional allowlist of conversations.
    if (config.whatsapp.allowedJids.length > 0 && !config.whatsapp.allowedJids.includes(remoteJid)) {
      return;
    }

    const senderJid = isGroup ? msg.key.participant ?? '' : remoteJid;
    const senderNumber = jidToNumber(senderJid);
    const text = extractText(msg).trim();
    if (!text) return;

    // In groups, only respond if the bot is mentioned.
    const mentioned =
      msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.some(
        (j) => jidToNumber(j) === this.botNumber,
      ) ?? false;

    const role = resolveWhatsappRole(senderNumber, config.whatsapp.adminNumbers);

    const normalised: IncomingMessage = {
      platform: 'whatsapp',
      conversationId: remoteJid,
      userId: senderNumber,
      userName: msg.pushName ?? senderNumber,
      text,
      isDirect,
      role,
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
        await this.sock.sendMessage(groupJid, {
          delete: { remoteJid: groupJid, id: messageId, fromMe: false },
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
