import { Boom } from '@hapi/boom';
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  proto,
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
import { getCodeAnswersPolicy, getCommunityGuidelines, getWelcomeMessage } from '../../storage/policies.js';
import {
  deleteInteractionByMessageId,
  getInteractionAuthorByMessageId,
  updateInteractionByMessageId,
} from '../../storage/repository.js';
import { isSuperAdmin } from '../../auth/roles.js';
import { transcribeVoiceNote } from '../../media/voiceTranscribe.js';
import {
  extractAudio,
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
export const WHATSAPP_GROUP_WELCOME_MESSAGE =
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

    // Optional allowlist of conversations. Checked BEFORE protocol-message
    // handling: a group we never process normal messages for was never
    // archived, so there is nothing for a revoke/edit to legitimately act on,
    // and a revoke/edit for a non-allowed JID must not reach the DB either.
    if (config.whatsapp.allowedJids.length > 0 && !config.whatsapp.allowedJids.includes(remoteJid)) {
      return;
    }

    // Delete/edit honouring for archived groups (issue #103, mirrors #48):
    // WhatsApp delivers "delete for everyone" and edits as a protocolMessage
    // over the same messages.upsert stream, not a separate socket event —
    // intercept it before the normal text handling below, since a
    // revoke/edit carries no text of its own and would otherwise just be
    // dropped by the `!text` check further down.
    if (await this.handleProtocolMessage(msg, remoteJid, isGroup)) return;

    const { text: rawText, contextInfo: textContextInfo } = extractText(msg);
    const { audio, contextInfo: audioContextInfo } = extractAudio(msg);
    // A voice note carries its OWN contextInfo (not the extendedText one), so
    // reply-to-bot detection keeps working when the message is audio.
    const contextInfo = textContextInfo ?? audioContextInfo;

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

    // Identity must be a real phone number for tier resolution to work. A
    // LID sender without a resolvable number gets a `lid:`-prefixed id: it
    // can never match a member/admin grant AND can never be mis-routed as a
    // phone JID by warn/kick (see performAdminAction's isPhoneUserId guard).
    const senderId = this.resolveSenderId(msg, isGroup, remoteJid);

    // Voice notes (super-admin only, issue: WA voice): a message with no text
    // but a voice note is transcribed locally and the transcript becomes the
    // message text — the rest of the pipeline (RBAC, tools, CONFIRM) is
    // untouched. The super-admin + feature-flag gate lives inside
    // maybeTranscribeVoiceNote and runs BEFORE any media download, so a
    // non-super-admin voice note is dropped exactly like an unhandled type.
    if (!text && audio) {
      text = await this.maybeTranscribeVoiceNote(msg, audio, senderId);
    }
    if (!text) return;

    const normalised: IncomingMessage = {
      platform: 'whatsapp',
      conversationId: remoteJid,
      userId: senderId,
      userName: msg.pushName ?? senderId,
      text,
      isDirect,
      addressedToBot: isDirect || mentioned || repliedToBot,
      messageId: msg.key.id ?? undefined,
      timestamp: Number(msg.messageTimestamp ?? 0) * 1000,
      raw: msg,
    };

    await this.handler(normalised);
  }

  /**
   * Transcribe a super admin's WhatsApp voice note to text, or return '' to
   * drop it. This is the SINGLE gate for the voice feature:
   *   1. WHATSAPP_VOICE_ENABLED must be on (off by default);
   *   2. the sender must be a configured super admin — `isSuperAdmin` is a pure
   *      env check (SUPER_ADMIN_WHATSAPP_NUMBERS), never the DB — enforced
   *      BEFORE any media is downloaded, so a non-super-admin's audio is never
   *      fetched or transcribed;
   *   3. notes longer than WHATSAPP_VOICE_MAX_SECONDS are ignored WITHOUT
   *      downloading, bounding per-note transcription cost.
   * Any download/decode/model failure is logged and swallowed (returns '') so a
   * bad note is dropped rather than crashing the loop or leaking internals. The
   * transcript is returned verbatim; every downstream gate still applies — a
   * mis-heard destructive command cannot fire without the (spoken or typed)
   * CONFIRM the tool layer already demands.
   */
  private async maybeTranscribeVoiceNote(
    msg: WAMessage,
    audio: proto.Message.IAudioMessage,
    senderId: string,
  ): Promise<string> {
    if (!config.whatsapp.voice.enabled) return '';
    if (!isSuperAdmin('whatsapp', senderId)) return '';
    const seconds = Number(audio.seconds ?? 0);
    if (seconds > config.whatsapp.voice.maxSeconds) {
      logger.info(
        { seconds, cap: config.whatsapp.voice.maxSeconds },
        'Voice note over the length cap — ignored without downloading',
      );
      return '';
    }
    try {
      return await this.transcribeAudioMessage(msg, seconds);
    } catch (err) {
      logger.warn({ err }, 'Voice-note transcription failed — dropping the note');
      return '';
    }
  }

  /**
   * Download the voice note's bytes from WhatsApp and transcribe them locally.
   * Split out from the gate above as the single seam that touches the network
   * and the Whisper model — overridden in tests so the gate logic can be
   * exercised without a real media fetch or model download. Never called for a
   * non-super-admin, a disabled feature, or an over-length note (the gate
   * returns first).
   */
  private async transcribeAudioMessage(msg: WAMessage, seconds: number): Promise<string> {
    if (!this.sock) return '';
    const buffer = await downloadMediaMessage(
      msg,
      'buffer',
      {},
      { logger, reuploadRequest: this.sock.updateMediaMessage },
    );
    const transcript = await transcribeVoiceNote(buffer);
    logger.info({ chars: transcript.length, seconds }, 'Transcribed super-admin voice note');
    return transcript;
  }

  /** True for a group JID that's opted into ambient archiving (`WHATSAPP_ARCHIVE_GROUP_JIDS`, issue #103). */
  private inArchiveScope(remoteJid: string, isGroup: boolean): boolean {
    return isGroup && config.whatsapp.archiveGroupJids.includes(remoteJid);
  }

  /**
   * Honours a "delete for everyone" / edit on a message this bot previously
   * saw in an archived group (issue #103, mirrors Discord's #48 handling).
   * Both arrive as a `protocolMessage` over the same `messages.upsert`
   * stream Baileys uses for ordinary messages, keyed to the id of the
   * message being revoked/edited. Returns true if the event was a
   * protocol message (handled or not), so the caller can skip normal
   * text processing either way — a revoke/edit is never itself a chat message.
   */
  private async handleProtocolMessage(msg: WAMessage, remoteJid: string, isGroup: boolean): Promise<boolean> {
    const protocolMessage = msg.message?.protocolMessage;
    const targetId = protocolMessage?.key?.id;
    if (!protocolMessage || !targetId) return false;
    if (!this.inArchiveScope(remoteJid, isGroup)) return true;
    const isRevoke = protocolMessage.type === proto.Message.ProtocolMessage.Type.REVOKE;
    const isEdit =
      protocolMessage.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT &&
      !!protocolMessage.editedMessage;
    if (!isRevoke && !isEdit) return true;

    // AUTHORSHIP CHECK (security): WhatsApp servers don't validate revoke/edit
    // authorship — only clients do — and stanza ids are visible to every group
    // member, so a modified client can broadcast a revoke/edit keyed to
    // ANOTHER user's message. Without this check that would let any participant
    // delete another member's archived message (evidence destruction) or, on
    // edit, re-embed attacker-chosen text attributed to the original author
    // into pgvector (memory poisoning). Honour it only when the revoker
    // actually authored the stored message, or is a group admin (legitimate
    // "delete for everyone" moderation). Fail safe: if we can't confirm
    // authorship, skip — a kept-but-stale copy is a lesser harm than honouring
    // a forged one.
    const storedAuthor = await getInteractionAuthorByMessageId('whatsapp', remoteJid, targetId).catch(
      (err) => {
        logger.warn({ err, messageId: targetId }, 'Failed to look up stored-message author');
        return null;
      },
    );
    if (!storedAuthor) return true; // nothing stored for this id in this chat — no-op

    const revokerId = this.resolveSenderId(msg, isGroup, remoteJid);
    const authored = storedAuthor === revokerId;
    if (!authored && !(await this.isGroupAdmin(remoteJid, revokerId))) {
      logger.warn(
        { messageId: targetId, remoteJid },
        'Ignoring revoke/edit from a non-author, non-admin participant',
      );
      return true;
    }

    if (isRevoke) {
      await deleteInteractionByMessageId('whatsapp', remoteJid, targetId).catch((err) =>
        logger.warn({ err, messageId: targetId }, 'Stored-message delete failed'),
      );
      return true;
    }
    // Edit-tracking is best-effort (Baileys protocol fidelity for edits
    // varies more than revokes); delete-honouring above is the load-bearing
    // privacy promise and always applies.
    const { text } = extractText({ key: msg.key, message: protocolMessage.editedMessage! });
    if (text) {
      await updateInteractionByMessageId('whatsapp', remoteJid, targetId, text).catch((err) =>
        logger.warn({ err, messageId: targetId }, 'Stored-message update failed'),
      );
    }
    return true;
  }

  /** Resolve a message's sender to the same `user_id` form the normal path stores. */
  private resolveSenderId(msg: WAMessage, isGroup: boolean, remoteJid: string): string {
    const senderNumber = senderPhoneNumber(msg, isGroup);
    const rawFallback = jidLocalPart(isGroup ? msg.key.participant : remoteJid);
    return senderNumber || (rawFallback ? lidFallbackId(rawFallback) : 'unknown');
  }

  /**
   * Best-effort check that `userId` is an admin/superadmin of `groupJid` — the
   * one documented exception to the revoke/edit authorship rule (a real group
   * admin legitimately deletes others' messages "for everyone"). Any lookup
   * failure resolves to `false` (fail safe: don't honour a forged revoke on a
   * metadata error). Matches participants the same way `conversationsForUser`
   * does, tolerating phone/LID id forms.
   */
  private async isGroupAdmin(groupJid: string, userId: string): Promise<boolean> {
    if (!this.sock || !groupJid.endsWith('@g.us')) return false;
    try {
      const meta = await this.sock.groupMetadata(groupJid);
      return (meta.participants ?? []).some((p) => {
        if (p.admin !== 'admin' && p.admin !== 'superadmin') return false;
        const pid = jidLocalPart(p.id);
        const pn = jidLocalPart((p as { phoneNumber?: string }).phoneNumber);
        return pid === userId || pn === userId || lidFallbackId(pid) === userId;
      });
    } catch (err) {
      logger.warn({ err, groupJid }, 'Failed to fetch group metadata for admin check');
      return false;
    }
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
   * The welcome text itself is admin-configurable (set_welcome_message,
   * issue #253), falling back to the hardcoded WHATSAPP_GROUP_WELCOME_MESSAGE
   * default when unset. When community guidelines are set (issue #212),
   * they're appended verbatim to it — never run through the model.
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

    const welcomeMessage = (await getWelcomeMessage()) ?? WHATSAPP_GROUP_WELCOME_MESSAGE;
    const guidelines = await getCommunityGuidelines();
    const welcomeText = guidelines
      ? `${welcomeMessage}\n\nCommunity guidelines:\n${guidelines}`
      : welcomeMessage;
    await this.sock.sendMessage(update.id, { text: welcomeText });
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

  /** Post an image (with an optional caption) to a conversation. */
  async sendImage(
    conversationId: string,
    image: { data: Buffer; filename: string; mimeType: string },
    caption?: string,
  ): Promise<void> {
    if (!this.sock) throw new Error('WhatsApp socket not connected');
    await this.sock.sendMessage(conversationId, {
      image: image.data,
      caption: caption ? await this.filtered(caption) : undefined,
    });
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
