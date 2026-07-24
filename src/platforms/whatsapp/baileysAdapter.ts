import { Boom } from '@hapi/boom';
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  proto,
  useMultiFileAuthState,
  type BaileysEventMap,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { config } from '../../config.js';
import { logger, hashId } from '../../logger.js';
import { filterOutbound } from '../../agent/outbound.js';
import { runtimeSecrets } from '../../agent/secrets.js';
import { reserveVoiceTranscriptionSlot } from '../../agent/tools.js';
import { getCodeAnswersPolicy, getCommunityGuidelines, getWelcomeMessage } from '../../storage/policies.js';
import {
  blockUser,
  deleteInteractionByMessageId,
  getInteractionAuthorByMessageId,
  markRosterLeave,
  unblockUser,
  updateInteractionByMessageId,
  upsertRosterMember,
} from '../../storage/repository.js';
import { isSuperAdmin, resolveRole } from '../../auth/roles.js';
import { atLeast } from '../../auth/rbac.js';
import { evictReplyMapping, peekReplyMapping } from '../../replyRetraction.js';
import { transcribeVoiceNote } from '../../media/voiceTranscribe.js';
import { getLanguagePreference } from '../../storage/repository.js';
import {
  VOICE_LANGUAGE_CAVEAT_TEXT_MI,
  shouldNotify as shouldNotifyVoiceLanguageCaveat,
} from '../../voiceLanguageCaveatNotice.js';
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

// Bounds for the sent-message retry cache (see `sentMessages`). Retry receipts
// for an undecryptable message arrive within minutes, occasionally hours; keep
// enough to service them without letting the cache grow unbounded on a busy
// number. In-memory only, so a process restart clears it (a retry older than
// that is not recoverable anyway).
const SENT_MESSAGE_CACHE_MAX = 1000;
const SENT_MESSAGE_CACHE_TTL_MS = 6 * 60 * 60_000; // 6h

// Debounce window for the voice-language caveat (issue #655) — "at most once
// per sender per week" per the proposal's cost story.
const VOICE_LANGUAGE_CAVEAT_WINDOW_MS = 7 * 24 * 60 * 60_000;

// Generic and static — no @-mention or echo of the joiner, so a bulk add
// can't be turned into a mass-ping and no participant JID reaches the chat.
export const WHATSAPP_GROUP_WELCOME_MESSAGE =
  "Kia ora! 👋 This bot only replies to registered members. If you're new here, ask an admin in this group to add you as a member.";

// Selected instead of WHATSAPP_GROUP_WELCOME_MESSAGE when
// config.rbac.accessMode.whatsapp is 'open' (issue #351) — same
// generic/static, no-@-mention shape, adapted to state that no admin
// approval is needed in that mode.
export const WHATSAPP_GROUP_WELCOME_MESSAGE_OPEN =
  'Kia ora! 👋 This bot answers Claude/Anthropic questions and remembers context — go ahead and message ' +
  'me any time, no admin approval needed. Ask me "what can you do?" any time for a quick rundown.';

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
  readonly adminCapabilities = new Set([
    'warn_user',
    'kick_user',
    'delete_message',
    'block_user',
    'unblock_user',
  ]);

  private sock: WASocket | null = null;
  private handler: MessageHandler | null = null;
  private botNumber = '';
  private botLid = '';
  private stopped = false;
  private connected = false;
  private reconnectAttempts = 0;
  // Handle for the pending reconnect timer, so a successful open (or a fresh
  // schedule) can cancel a still-queued one and avoid two overlapping
  // reconnects both calling connect() (audit M5).
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly membershipCache = new Map<string, { expires: number; ids: string[] }>();
  /**
   * Opportunistic LID-local-part -> phone-number mapping, learned for free in
   * `resolveSenderId` from data every group message already carries. Consumed
   * (and deleted) by `invalidateMembershipCacheFor` so a bare-`@lid` removal
   * can also reach the same person's phone-keyed `membershipCache` entry —
   * see docs/SECURITY.md "Membership-scope staleness".
   */
  private readonly lidToPhone = new Map<string, string>();
  /** WA Web version is fetched once and reused across reconnects. */
  private cachedVersion: [number, number, number] | null = null;
  private welcomeCooldown: WelcomeCooldownState = initialWelcomeCooldownState();
  /**
   * Bounded cache of the messages we've SENT (id -> content), so `getMessage`
   * (wired into makeWASocket in connect()) can answer a recipient's retry
   * receipt and RE-SEND a message their device failed to decrypt. Without it an
   * undecryptable message is never recovered and the recipient sees WhatsApp's
   * "Waiting for this message. This may take a while." indefinitely — the
   * failure mode that dogged proactive/background-job DMs, which (unlike a reply
   * to a fresh inbound) have no recent message to refresh the Signal session.
   */
  private readonly sentMessages = new Map<string, { message: proto.IMessage; at: number }>();
  /**
   * Debounce state for the voice-language caveat (issue #655):
   * senderId -> last-notified epoch ms, checked via `shouldNotifyVoiceLanguageCaveat`
   * mirroring router.ts's `rateLimitNotified` pattern. In-memory only, so a
   * process restart re-arms it — acceptable for a once-per-week notice.
   */
  private readonly voiceLanguageCaveatNotified = new Map<string, number>();

  /**
   * Cache a just-sent message so `getMessage` can resend it on a retry receipt.
   * Bounds by age and size — the Map iterates in insertion order, so the oldest
   * entries evict first. No-op for a send with no id/content (e.g. a revoke).
   */
  private remember(sent: WAMessage | undefined): void {
    const id = sent?.key?.id;
    const message = sent?.message;
    if (!id || !message) return;
    this.sentMessages.set(id, { message, at: Date.now() });
    const cutoff = Date.now() - SENT_MESSAGE_CACHE_TTL_MS;
    for (const [key, entry] of this.sentMessages) {
      if (entry.at >= cutoff && this.sentMessages.size <= SENT_MESSAGE_CACHE_MAX) break;
      this.sentMessages.delete(key);
    }
  }

  /**
   * Look up a previously sent message so Baileys can re-encrypt and resend it in
   * response to a retry receipt. Wired into `makeWASocket`'s `getMessage`; a
   * private method (rather than an inline closure) so it can be tested without a
   * live socket. Returns undefined for an unknown/evicted key — Baileys then
   * simply can't auto-resend, the same as before this cache existed.
   */
  private recallSentMessage(key: WAMessageKey): proto.IMessage | undefined {
    return this.sentMessages.get(key.id ?? '')?.message ?? undefined;
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    // Collapse a duplicate schedule onto one pending timer — two overlapping
    // reconnects would each build a socket and end() the other's (audit M5).
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectAttempts += 1;
    const delay = Math.min(3_000 * 2 ** (this.reconnectAttempts - 1), MAX_RECONNECT_DELAY_MS);
    logger.warn({ attempt: this.reconnectAttempts, delayMs: delay }, 'Scheduling WhatsApp reconnect');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
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
      // Service a recipient's retry receipt: when their device can't decrypt a
      // message we sent, Baileys calls this to fetch the original and re-send
      // it. Without it the message is never recovered and the recipient is
      // stuck on "Waiting for this message…". Backed by the bounded
      // `sentMessages` cache we populate on every content send (see remember()).
      getMessage: async (key) => this.recallSentMessage(key),
    });
    this.sock = sock;

    sock.ev.on('creds.update', () => {
      saveCreds().catch((err: unknown) => logger.error({ err }, 'Failed to save Baileys credentials'));
    });

    sock.ev.on('connection.update', (update) => {
      // Ignore events from a socket we've already replaced (audit M5): a late
      // `close` from a torn-down socket must not flip `connected`/schedule a
      // reconnect that would end() the healthy current socket.
      if (this.sock !== sock) return;
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        logger.info('Scan this QR with WhatsApp > Linked Devices to link the bot number:');
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'open') {
        this.connected = true;
        this.reconnectAttempts = 0;
        // A queued reconnect from an earlier `close` would end() this healthy
        // socket — cancel it now that we're open (audit M5).
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.botNumber = jidLocalPart(sock.user?.id);
        this.botLid = jidLocalPart((sock.user as { lid?: string } | undefined)?.lid);
        logger.info({ number: this.botNumber }, 'WhatsApp connected');
        // One-shot idempotent roster backfill so "everyone already here" is
        // covered, not just future joiners/leavers — mirrors Discord's
        // day-one backfillRoster(). Fire-and-forget: a backfill failure must
        // never block message handling.
        void this.backfillRoster();
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
      if (this.sock !== sock) return; // stale socket — see connection.update (audit M5)
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

    // Voice notes (min-tier configurable via WHATSAPP_VOICE_MIN_ROLE, default
    // super_admin, issue #507): a message with no text but a voice note is
    // transcribed locally and the transcript becomes the message text — the
    // rest of the pipeline (RBAC, tools, CONFIRM) is untouched. The tier +
    // feature-flag + rate-cap gate lives inside maybeTranscribeVoiceNote and
    // runs BEFORE any media download, so a below-tier or rate-capped voice
    // note is dropped exactly like an unhandled type.
    if (!text && audio) {
      text = await this.maybeTranscribeVoiceNote(msg, audio, senderId);
      if (text) {
        await this.maybeSendVoiceLanguageCaveat(senderId);
      }
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
   * Transcribe a WhatsApp voice note to text, or return '' to drop it. This
   * is the SINGLE gate for the voice feature:
   *   1. WHATSAPP_VOICE_ENABLED must be on (off by default);
   *   2. the sender's resolved tier must meet WHATSAPP_VOICE_MIN_ROLE
   *      (default 'super_admin'). At the default, this stays the original
   *      pure `isSuperAdmin` env check (SUPER_ADMIN_WHATSAPP_NUMBERS) — never
   *      the DB — so the default configuration makes no new DB call. Only
   *      when an operator has lowered `minRole` does this call the same
   *      `resolveRole`/`atLeast` primitives every other tier-gated surface
   *      uses. Either way this is enforced BEFORE any media is downloaded, so
   *      a below-tier sender's audio is never fetched or transcribed;
   *   3. notes longer than WHATSAPP_VOICE_MAX_SECONDS are ignored WITHOUT
   *      downloading, bounding per-note transcription cost;
   *   4. once WHATSAPP_VOICE_RATE_LIMIT_PER_HOUR is set (non-zero), a sender
   *      who already hit the cap within the rolling hour is refused WITHOUT
   *      downloading — bounds the resource-exhaustion surface a widened,
   *      less-trusted population could otherwise hit. Skipped entirely at
   *      the default (0 = unlimited), so it adds no bookkeeping unless an
   *      operator opts in.
   * Any download/decode/model failure is logged and swallowed (returns '') so a
   * bad note is dropped rather than crashing the loop or leaking internals. The
   * transcript is returned verbatim; every downstream gate still applies — a
   * mis-heard destructive command cannot fire without the (spoken or typed)
   * CONFIRM the tool layer already demands, and the transcript is granted
   * exactly the caller's own tier's tool set, never more.
   */
  private async maybeTranscribeVoiceNote(
    msg: WAMessage,
    audio: proto.Message.IAudioMessage,
    senderId: string,
  ): Promise<string> {
    if (!config.whatsapp.voice.enabled) return '';
    const minRole = config.whatsapp.voice.minRole;
    if (minRole === 'super_admin') {
      if (!isSuperAdmin('whatsapp', senderId)) return '';
    } else {
      const role = await resolveRole('whatsapp', senderId);
      if (!atLeast(role, minRole)) return '';
    }
    const seconds = Number(audio.seconds ?? 0);
    if (seconds > config.whatsapp.voice.maxSeconds) {
      logger.info(
        { seconds, cap: config.whatsapp.voice.maxSeconds },
        'Voice note over the length cap — ignored without downloading',
      );
      return '';
    }
    const rateLimit = config.whatsapp.voice.rateLimitPerHour;
    if (rateLimit > 0 && !reserveVoiceTranscriptionSlot(senderId, rateLimit)) {
      logger.info(
        { sender: hashId(senderId), limit: rateLimit },
        'Voice note refused — sender hit the hourly transcription cap',
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
   * below-tier sender, a disabled feature, a rate-capped sender, or an
   * over-length note (the gate returns first).
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
    logger.info({ chars: transcript.length, seconds }, 'Transcribed voice note');
    return transcript;
  }

  /**
   * After a successful voice-note transcription, DM the sender a fixed
   * caveat if their stored language preference is 'mi' (issue #655):
   * `WHATSAPP_VOICE_MODEL` is English-only, so their transcript may be
   * garbled with no other signal that anything went wrong. Purely a side
   * notice — never touches `text` or the downstream pipeline. Debounced to
   * at most once per sender per `VOICE_LANGUAGE_CAVEAT_WINDOW_MS`. A
   * `lid:`-fallback sender (no resolvable phone number) is skipped, since
   * `sendDirectMessage` can only target a phone-number id.
   */
  private async maybeSendVoiceLanguageCaveat(senderId: string): Promise<void> {
    if (!isPhoneUserId(senderId)) return;
    const language = await getLanguagePreference('whatsapp', senderId);
    if (language !== 'mi') return;
    if (
      !shouldNotifyVoiceLanguageCaveat(
        this.voiceLanguageCaveatNotified.get(senderId),
        Date.now(),
        VOICE_LANGUAGE_CAVEAT_WINDOW_MS,
      )
    ) {
      return;
    }
    this.voiceLanguageCaveatNotified.set(senderId, Date.now());
    try {
      await this.sendDirectMessage(senderId, VOICE_LANGUAGE_CAVEAT_TEXT_MI);
    } catch (err) {
      logger.warn({ err }, 'Failed to send voice-language caveat notice');
    }
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
    const isRevoke = protocolMessage.type === proto.Message.ProtocolMessage.Type.REVOKE;

    // Auto-retract our own reply (issue #575) — deliberately INDEPENDENT of
    // `inArchiveScope` below: this is the bot revoking its own prior send in
    // reaction to the member's native revoke, not honouring a stored row, so
    // it works even with ambient archiving off. Gated on its own flag, not on
    // whether this chat is in archive scope.
    if (isRevoke && config.behaviour.autoRetractReplyEnabled) {
      await this.retractOwnReplyIfMapped(msg, remoteJid, targetId, isGroup).catch((err) =>
        logger.warn({ err, messageId: targetId }, 'Reply retraction failed'),
      );
    }

    if (!this.inArchiveScope(remoteJid, isGroup)) return true;
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

  /**
   * Resolve a message's sender to the same `user_id` form the normal path
   * stores. Side effect: for a group message routed by a LID JID where the
   * phone number resolves, opportunistically remembers the LID->phone pairing
   * in `lidToPhone` — the mapping `invalidateMembershipCacheFor` needs to
   * reach a phone-keyed cache entry from a bare-`@lid` removal event later.
   */
  private resolveSenderId(msg: WAMessage, isGroup: boolean, remoteJid: string): string {
    const senderNumber = senderPhoneNumber(msg, isGroup);
    const rawFallback = jidLocalPart(isGroup ? msg.key.participant : remoteJid);
    if (isGroup && isLidJid(msg.key.participant) && senderNumber) {
      this.lidToPhone.set(rawFallback, senderNumber);
    }
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
   * Retract the bot's own reply in response to the member revoking the
   * message it answered (issue #575). `SECURITY:` WhatsApp servers don't
   * validate revoke authorship any more than they do for the archived-row
   * case above — a modified client can broadcast a revoke stanza keyed to
   * ANOTHER participant's message id. Reuses the exact same discipline:
   * honour it only when the revoker is the mapped message's own sender, or a
   * group admin (legitimate "delete for everyone" moderation); otherwise
   * fail safe and leave the reply in place. Unlike the archived-row check,
   * this never depends on `getInteractionAuthorByMessageId` / an archived row
   * existing — the reply-mapping entry itself already carries the original
   * sender, captured for free when the router recorded it.
   *
   * Uses `peekReplyMapping`/`evictReplyMapping` rather than the unconditional
   * `takeReplyMapping`: a FAILED authorship check must never consume the
   * entry, or a single forged/non-author revoke could permanently deny a
   * later legitimate retraction of the same reply (a griefing vector) — the
   * entry is only evicted once a retraction is actually authorised.
   */
  private async retractOwnReplyIfMapped(
    msg: WAMessage,
    remoteJid: string,
    targetId: string,
    isGroup: boolean,
  ): Promise<void> {
    const mapping = peekReplyMapping('whatsapp', remoteJid, targetId);
    if (!mapping) return;
    const revokerId = this.resolveSenderId(msg, isGroup, remoteJid);
    const authored = revokerId === mapping.senderId;
    if (!authored && !(await this.isGroupAdmin(remoteJid, revokerId))) {
      logger.warn(
        { messageId: targetId, remoteJid },
        'Ignoring reply-retraction revoke from a non-author, non-admin participant',
      );
      return;
    }
    evictReplyMapping('whatsapp', remoteJid, targetId);
    await Promise.all(
      mapping.botReplyMessageIds.map((id) =>
        this.deleteOwnMessage(mapping.replyConversationId, id).catch((err) =>
          logger.warn({ err, messageId: id }, 'Failed to retract own reply'),
        ),
      ),
    );
  }

  /**
   * Delete (revoke) a message this bot itself sent (issue #575's
   * `deleteOwnMessage` capability) — a standard first-party "delete for
   * everyone" on the bot's OWN send, distinct from `performAdminAction`'s
   * `delete_message` (which revokes another user's message and requires
   * `participant`). `fromMe: true` is sufficient for Baileys to address the
   * bot's own message with no `participant` needed, in a group or a DM.
   */
  async deleteOwnMessage(conversationId: string, messageId: string): Promise<void> {
    if (!this.sock) throw new Error('WhatsApp socket not connected');
    await this.sock.sendMessage(conversationId, {
      delete: { remoteJid: conversationId, id: messageId, fromMe: true },
    });
  }

  /**
   * WhatsApp's analogue of Discord's onGuildMemberAdd/onGuildMemberRemove:
   * `group-participants.update` fires whenever someone joins/is added to or
   * leaves/is removed from a group the linked number is in. Roster recording
   * (issue #407, see above) always runs first, for both directions. Below
   * that, the welcome message: off unless WHATSAPP_WELCOME_ENABLED=true.
   * Posts ONE static, non-agent message (no LLM call) to the group itself —
   * deliberately never a 1:1 DM to the new participant, since an unsolicited
   * DM to a stranger's number is exactly the Baileys ban-risk pattern this
   * avoids. Baileys batches simultaneous joins into one event already; the
   * cooldown additionally collapses sequential joins across time into a
   * single message per window. The welcome text itself is admin-configurable
   * (set_welcome_message, issue #253), falling back to the hardcoded
   * WHATSAPP_GROUP_WELCOME_MESSAGE default when unset —
   * WHATSAPP_GROUP_WELCOME_MESSAGE_OPEN instead when
   * config.rbac.accessMode.whatsapp is 'open' (issue #351). When community
   * guidelines are set (issue #212), they're appended verbatim to it — never
   * run through the model.
   */
  private async onGroupParticipantsUpdate(
    update: BaileysEventMap['group-participants.update'],
  ): Promise<void> {
    // Roster recording (issue #407), independent of WHATSAPP_WELCOME_ENABLED
    // below — mirroring Discord's roster recording, which has never depended
    // on DISCORD_WELCOME_ENABLED (onGuildMemberAdd/onGuildMemberRemove).
    // Scoped by the same WHATSAPP_ALLOWED_JIDS gate as message intake and the
    // welcome message, so roster tracking never expands to a group the
    // operator hasn't scoped the bot into.
    const inScope =
      config.whatsapp.allowedJids.length === 0 || config.whatsapp.allowedJids.includes(update.id);
    if (inScope && (update.action === 'add' || update.action === 'remove')) {
      // Issue #501: a `remove` from one allowed group must not mark
      // `server_roster` "left" for someone who remains in another allowed
      // group — a single `(platform, user_id)` row can't represent per-group
      // presence, so check live membership elsewhere before writing. Fetched
      // ONCE per event (not once per participant), reusing the same
      // `groupFetchAllParticipating()` call `conversationsForUser` and
      // `backfillRoster` already make for the same "which allowed groups is
      // this person in" question. A thrown fetch degrades to today's
      // unconditional mark-left (logged as a warning), matching those sibling
      // sites' failure posture — never a silent skip that could lose a
      // genuine departure.
      let otherGroups: Awaited<ReturnType<WASocket['groupFetchAllParticipating']>> | undefined;
      if (update.action === 'remove' && this.sock) {
        try {
          otherGroups = await this.sock.groupFetchAllParticipating();
        } catch (err) {
          logger.warn(
            { err, groupId: update.id },
            'Failed to fetch WhatsApp groups for multi-group roster leave check; defaulting to mark left',
          );
        }
      }
      // The group the `remove` fired for is excluded from the "other groups"
      // check — Baileys' own event ordering may or may not have already
      // dropped the participant from THAT group's live metadata by the time
      // this runs, so checking it would risk a same-tick false "still here"
      // read. Matches membership the same phone/LID-tolerant way
      // `conversationsForUser`/`isGroupAdmin` do, so a still-present member
      // listed under a different id form in the other group is recognised.
      const stillInAnotherAllowedGroup = (userId: string): boolean => {
        if (!otherGroups) return false;
        for (const [jid, meta] of Object.entries(otherGroups)) {
          if (jid === update.id) continue;
          if (config.whatsapp.allowedJids.length > 0 && !config.whatsapp.allowedJids.includes(jid)) continue;
          const inGroup = meta.participants?.some((p) => {
            const pid = jidLocalPart(p.id);
            const pn = jidLocalPart((p as { phoneNumber?: string }).phoneNumber);
            return pid === userId || pn === userId || lidFallbackId(pid) === userId;
          });
          if (inGroup) return true;
        }
        return false;
      };
      for (const jid of update.participants) {
        const local = jidLocalPart(jid);
        // Never roster-track the bot's own number/LID.
        if (!local || local === this.botNumber || (this.botLid !== '' && local === this.botLid)) continue;
        if (update.action === 'add') {
          await upsertRosterMember({ platform: 'whatsapp', userId: local }).catch((err) =>
            logger.warn({ err, jid }, 'WhatsApp roster join record failed'),
          );
        } else if (!stillInAnotherAllowedGroup(local)) {
          await markRosterLeave('whatsapp', local).catch((err) =>
            logger.warn({ err, jid }, 'WhatsApp roster leave record failed'),
          );
        }
      }
    }

    // Cache invalidation must run regardless of the welcome-message feature
    // flag below — it's a security-relevant scope narrowing, not part of the
    // welcome feature. A participant leaving one group may remain in others,
    // so this is a targeted per-key delete (recompute-on-next-call), never a
    // blanket flush — see docs/SECURITY.md "Membership-scope staleness".
    if (update.action === 'remove') {
      this.invalidateMembershipCacheFor(update.participants);
    }

    if (!config.whatsapp.welcome.enabled) return;
    if (update.action !== 'add') return;
    if (config.whatsapp.allowedJids.length > 0 && !config.whatsapp.allowedJids.includes(update.id)) return;
    if (!this.sock) return;

    const cooldownMs = config.whatsapp.welcome.cooldownMinutes * 60_000;
    const step = stepWelcomeCooldown(this.welcomeCooldown, update.id, Date.now(), cooldownMs);
    this.welcomeCooldown = step.state;
    if (!step.shouldSend) return;

    const defaultWelcomeMessage =
      config.rbac.accessMode.whatsapp === 'open'
        ? WHATSAPP_GROUP_WELCOME_MESSAGE_OPEN
        : WHATSAPP_GROUP_WELCOME_MESSAGE;
    const welcomeMessage = (await getWelcomeMessage()) ?? defaultWelcomeMessage;
    const guidelines = await getCommunityGuidelines();
    const welcomeText = guidelines
      ? `${welcomeMessage}\n\nCommunity guidelines:\n${guidelines}`
      : welcomeMessage;
    this.remember(await this.sock.sendMessage(update.id, { text: welcomeText }));
  }

  /**
   * Delete any `membershipCache` entry for a removed participant. `raw`
   * entries are bare JIDs (a `string[]`, not the participant-object shape
   * `isGroupAdmin`/`conversationsForUser` match against), so normalize each
   * one via `jidLocalPart` and check both the phone-number and LID-fallback
   * forms a cache key may have been stored under — an exact match on each
   * form only, so a similarly-shaped but different id is never deleted.
   *
   * A removal carrying only an `@lid` JID also clears that same person's
   * *phone-number*-keyed entry, via `lidToPhone` — the opportunistic mapping
   * `resolveSenderId` learns from a prior group message. The entry is
   * consumed (deleted) here: once the person has left, it has no further use,
   * so it isn't left to accumulate for departed participants. `lidToPhone` is
   * only ever consulted to delete, never to add, so a missing/stale mapping
   * degrades to exactly today's gap and can never over-invalidate.
   *
   * Residual gap (documented in SECURITY.md "Membership-scope staleness"):
   * a participant the bot never saw post in the group has no learned
   * mapping, so a bare-`@lid` removal for them still can't reach a
   * phone-keyed entry — the event has no phone number to resolve it by, and
   * the group's own metadata has already dropped the participant by the time
   * this fires, so there's no live lookup to recover the mapping either.
   */
  private invalidateMembershipCacheFor(raw: string[]): void {
    for (const jid of raw) {
      const local = jidLocalPart(jid);
      if (!local) continue;
      this.membershipCache.delete(local);
      this.membershipCache.delete(lidFallbackId(local));
      const phone = this.lidToPhone.get(local);
      if (phone) {
        this.membershipCache.delete(phone);
        this.lidToPhone.delete(local);
      }
    }
  }

  /**
   * Every outbound path is filtered HERE (secret redaction + code policy) so
   * no caller — router reply, announce, warn, super-admin alert — can forget.
   * `language` and `style` are optional (issues #339, #657): only
   * `sendMessage`'s main-reply path passes them through; every other call
   * site below omits both, so their output stays English-only by
   * construction (never `_MI`/`_PLAIN`).
   */
  private async filtered(text: string, language?: 'mi', style?: 'plain'): Promise<string> {
    return filterOutbound(text, await getCodeAnswersPolicy(), runtimeSecrets(), 'whatsapp', language, style);
  }

  async sendMessage(out: OutgoingMessage): Promise<string[] | undefined> {
    if (!this.sock) throw new Error('WhatsApp socket not connected');
    const sent = await this.sock.sendMessage(out.conversationId, {
      text: await this.filtered(out.text, out.language, out.style),
    });
    this.remember(sent);
    // Clear the "composing" indicator now that the reply has actually sent.
    // Best-effort: a presence update failing here must not affect the send
    // that already succeeded above.
    this.sock
      .sendPresenceUpdate('paused', out.conversationId)
      .catch((err) => logger.debug({ err }, 'Failed to clear WhatsApp presence'));
    return sent?.key?.id ? [sent.key.id] : undefined;
  }

  /** Post an image (with an optional caption) to a conversation. */
  async sendImage(
    conversationId: string,
    image: { data: Buffer; filename: string; mimeType: string },
    caption?: string,
  ): Promise<void> {
    if (!this.sock) throw new Error('WhatsApp socket not connected');
    this.remember(
      await this.sock.sendMessage(conversationId, {
        image: image.data,
        caption: caption ? await this.filtered(caption) : undefined,
      }),
    );
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
    this.remember(
      await this.sock.sendMessage(`${userId}@s.whatsapp.net`, { text: await this.filtered(text) }),
    );
  }

  /**
   * WhatsApp groups this user (phone number) is currently a participant of,
   * plus their own 1:1 with the bot. Backs admin conversation scoping;
   * cached ~60s, but a group removal event invalidates the affected entry
   * immediately via `onGroupParticipantsUpdate` — including a bare-`@lid`
   * removal reaching this same person's phone-keyed entry, when a prior
   * group message taught the LID->phone mapping (see `lidToPhone`). The TTL
   * only bounds staleness from membership changes this adapter doesn't
   * directly observe, or from a never-messaged participant's bare-`@lid`
   * removal — see SECURITY.md for the residual window.
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
   * Idempotent upsert of every current participant across every in-scope
   * (WHATSAPP_ALLOWED_JIDS, or all currently-participating groups when
   * unset) group, so the roster covers members who joined before this
   * feature existed — mirrors Discord's day-one `backfillRoster()`
   * (`guild.members.fetch()`). Reuses the same `groupFetchAllParticipating()`
   * call `conversationsForUser` already makes on every cache miss, and takes
   * the same failure posture: a thrown fetch degrades to a warning log, not
   * a startup crash. Runs once per connection (from `connection.update`'s
   * 'open' branch); `upsertRosterMember` itself is idempotent, so re-running
   * this (e.g. across a reconnect) changes no rows for an already-present
   * participant.
   */
  private async backfillRoster(): Promise<void> {
    if (!this.sock) return;
    try {
      const groups = await this.sock.groupFetchAllParticipating();
      let count = 0;
      for (const [jid, meta] of Object.entries(groups)) {
        if (config.whatsapp.allowedJids.length > 0 && !config.whatsapp.allowedJids.includes(jid)) continue;
        for (const p of meta.participants ?? []) {
          const local = jidLocalPart(p.id);
          if (!local || local === this.botNumber || (this.botLid !== '' && local === this.botLid)) continue;
          await upsertRosterMember({ platform: 'whatsapp', userId: local });
          count += 1;
        }
      }
      logger.info({ count }, 'WhatsApp roster backfill complete');
    } catch (err) {
      logger.warn({ err }, 'WhatsApp roster backfill failed');
    }
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
    // block_user/unblock_user are a pure DB write with no Baileys API call
    // (issue #572) — handled before the socket-connected guard below since,
    // unlike every other action here, they need no live connection at all.
    if (action.kind === 'block_user') {
      const targetUserId = action.targetUserId ?? '';
      await blockUser(
        'whatsapp',
        targetUserId,
        paramString(action.params?.blockedBy),
        paramString(action.params?.reason) || null,
      );
      return `Blocked ${targetUserId}.`;
    }
    if (action.kind === 'unblock_user') {
      const targetUserId = action.targetUserId ?? '';
      const removed = await unblockUser('whatsapp', targetUserId);
      return removed ? `Unblocked ${targetUserId}.` : `${targetUserId} was not blocked.`;
    }
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

  /**
   * React to an existing message with an emoji (issue #494, extending #231's
   * Discord-only `react_to_message` to WhatsApp). `emoji` is already validated
   * against a closed allowlist by the caller (`react_to_message`) — this
   * method trusts it and just forwards to Baileys' native `react` send type,
   * same division of responsibility as `performAdminAction`'s `delete_message`
   * case, whose key-construction pattern this mirrors.
   *
   * A group reaction's key requires the target message's author as
   * `participant` (Baileys/WhatsApp addresses a group message by
   * `remoteJid` + author, not `remoteJid` + id alone); a DM has no
   * `participant`. The author comes from `getInteractionAuthorByMessageId`,
   * the same stored-authorship lookup the revoke/edit authorship check uses.
   * If a group message's author can't be resolved to a real phone-number id,
   * this silently no-ops rather than sending a react keyed to a
   * fabricated/guessed participant — the same fail-safe posture as the
   * revoke/edit authorship check's "can't confirm, so skip" rule.
   */
  async reactToMessage(conversationId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.sock) throw new Error('WhatsApp socket not connected');
    let participant: string | undefined;
    if (conversationId.endsWith('@g.us')) {
      const authorId = await getInteractionAuthorByMessageId('whatsapp', conversationId, messageId);
      if (!authorId || !isPhoneUserId(authorId)) {
        logger.warn(
          { conversationId, messageId },
          'Cannot resolve group message author for reaction — skipping',
        );
        return;
      }
      participant = this.targetJid(authorId);
    }
    await this.sock.sendMessage(conversationId, {
      react: {
        text: emoji,
        key: {
          remoteJid: conversationId,
          id: messageId,
          fromMe: false,
          participant,
        },
      },
    });
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
