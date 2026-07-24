import {
  createServer,
  type IncomingMessage as HttpRequest,
  type Server,
  type ServerResponse,
} from 'node:http';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import type { AlertPriority } from '../../pendingAlertQueue.js';
import { filterOutbound } from '../../agent/outbound.js';
import { runtimeSecrets } from '../../agent/secrets.js';
import { getCodeAnswersPolicy, getCommunityGuidelines, getWelcomeMessage } from '../../storage/policies.js';
import { blockUser, isKnownConversation, unblockUser } from '../../storage/repository.js';
import {
  extractMessages,
  isAllowedSender,
  parseVerificationRequest,
  verifySignature,
  type CloudInboundMessage,
} from './cloudWire.js';
import { chunkText } from '../textChunk.js';
import {
  paramString,
  type AdminAction,
  type IncomingMessage,
  type MessageHandler,
  type OutgoingMessage,
  type PlatformAdapter,
} from '../types.js';

const GRAPH_API_VERSION = 'v21.0';
/** Meta webhook payloads are small JSON; this bounds memory use per request. */
const MAX_BODY_BYTES = 1_000_000;
/** Free-form replies are only allowed within Meta's 24h customer-service window. */
const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60_000;
/** Meta rejects any text message body over 4096 chars; longer replies are chunked. */
const WHATSAPP_CLOUD_MAX_LEN = 4096;
/** How often to prune `lastInboundAt` entries older than the window, so long-running processes don't grow it forever. */
const LAST_INBOUND_SWEEP_MS = 60 * 60_000;
/**
 * How long a Meta message id is remembered for webhook-retry dedup. Short —
 * Meta's documented redelivery window is minutes, not hours — deliberately
 * separate from `CUSTOMER_SERVICE_WINDOW_MS`, which governs something else
 * entirely (whether a free-form reply is still allowed). Pruned on the same
 * `sweepTimer` as `lastInboundAt` (see `sweepLastInboundAt`) rather than a
 * new timer.
 */
const MESSAGE_ID_DEDUP_WINDOW_MS = 5 * 60_000;
/**
 * Consecutive real-message send failures (across all recipients) before
 * `isConnected()` flips `false`. A single recipient-specific failure (bad
 * number, template requirement, a transient Meta 5xx) doesn't trip this,
 * because the very next successful send — to any recipient — resets the
 * counter to 0. Only a systemic, persistent failure (expired/revoked token,
 * broken egress) survives long enough to cross the threshold.
 */
const SEND_FAILURE_THRESHOLD = 3;
/**
 * Fallback backoff for a single 429 retry (see `retryAfterDelayMs`) when
 * Meta's `Retry-After` header is absent or unparseable.
 */
const SEND_RETRY_DEFAULT_BACKOFF_MS = 1_000;
/**
 * Cap on messages held per-recipient in `windowReopenQueue` (issue #602),
 * evicted on overflow per the same priority rule `pendingAlertQueue.ts` uses
 * (#545): `notifySuperAdmins` (tools.ts) is reachable from member-tier tools
 * (`report_content`, `appeal_moderation`), so this is what bounds
 * member-triggered per-recipient state — and a member-reachable `'low'` alert
 * must never evict a `'system'` one (admin-action audit / escalation).
 */
const WINDOW_REOPEN_QUEUE_CAP = 3;
/**
 * Hard clamp on any 429 retry delay, including a `Retry-After` value derived
 * from the header — so an extreme or malformed header can't block the
 * webhook handler for an extended period.
 */
const SEND_RETRY_MAX_BACKOFF_MS = 5_000;

// Fixed wrapper prefix for a manual warn_user DM (the admin's `reason` is
// appended verbatim, untranslated). Byte-for-byte the pre-#618 inline
// template's wording (no "moderators" — this platform's existing wording
// already differs from Discord's, kept as-is rather than unified).
const WARN_USER_DM_PREFIX = '⚠️ Warning from NZ Claude Community:';

// Fixed, human-authored te reo Māori variant of WARN_USER_DM_PREFIX (issue
// #618), served when the target has a standing 'mi' language_prefs row
// (getLanguagePreference, issue #189) — same `_MI` pattern moderator.ts's
// warnDmTextMi (#333) already established.
const WARN_USER_DM_PREFIX_MI = '⚠️ He whakatūpato nā NZ Claude Community:';

// Generic and static — no @-mention or echo of the sender, so nothing
// user-supplied (msg.name/msg.from) ever reaches the text. Mirrors
// WHATSAPP_GROUP_WELCOME_MESSAGE's shape, adapted for a 1:1 first contact.
export const WHATSAPP_CLOUD_WELCOME_MESSAGE =
  'Kia ora! 👋 Thanks for messaging the NZ Claude Community bot. I can help answer Claude/Anthropic ' +
  "questions here in our 1:1 chat. If you're new, an admin may need to register you as a member first.";

/**
 * Thrown by `assertWithinCustomerServiceWindow` (issue #602) instead of a
 * bare `Error`, so a caller can tell "this recipient's 24h window is closed,
 * a recoverable/expected condition" apart from a genuine send failure (a
 * Graph API 5xx, missing config, etc). `agent/tools.ts`'s `notifyAdmins`/
 * `notifySuperAdmins` use this to decide whether to queue the message via
 * `queueForWindowReopen` instead of only logging and dropping it.
 */
export class WindowClosedError extends Error {
  readonly recipientId: string;

  constructor(recipientId: string) {
    super(
      `Cannot send free-form WhatsApp message to ${recipientId}: outside the 24h customer-service window ` +
        '(no recent inbound message from this user). Only pre-approved message templates can be sent here.',
    );
    this.name = 'WindowClosedError';
    this.recipientId = recipientId;
  }
}

// Selected instead of WHATSAPP_CLOUD_WELCOME_MESSAGE when
// config.rbac.accessMode.whatsapp is 'open' (issue #351) — same
// generic/static, no-sender-data shape, adapted to state that no admin
// approval is needed in that mode.
export const WHATSAPP_CLOUD_WELCOME_MESSAGE_OPEN =
  'Kia ora! 👋 Thanks for messaging the NZ Claude Community bot. I can help answer Claude/Anthropic ' +
  'questions here in our 1:1 chat any time, no admin approval needed. Ask me "what can you do?" any ' +
  'time for a quick rundown.';

/**
 * WhatsApp via the official Meta Business Cloud API. ToS-compliant
 * alternative to {@link BaileysAdapter}: no linked-device session to ban,
 * webhook-driven, 1:1 messaging only (no group/moderation surface).
 *
 * Requires WHATSAPP_CLOUD_PHONE_NUMBER_ID, _ACCESS_TOKEN, _VERIFY_TOKEN, and
 * _APP_SECRET (see config.ts). Set WHATSAPP_PROVIDER=cloud to select it.
 */
export class WhatsAppCloudAdapter implements PlatformAdapter {
  readonly platform = 'whatsapp' as const;
  readonly adminCapabilities = new Set(['warn_user', 'block_user', 'unblock_user']);

  private handler: MessageHandler | null = null;
  private server: Server | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Last time each user sent an inbound message, tracked in-process to
   * enforce Meta's 24h free-form messaging window. Resets on restart — a
   * known limitation of not persisting this; see docs/DEPLOYMENT.md. Swept
   * periodically (see `sweepTimer`) so a busy, long-running deployment
   * doesn't grow this map forever.
   */
  private readonly lastInboundAt = new Map<string, number>();

  /**
   * Meta `wamid`s already processed (or currently mid-processing), keyed to
   * first-seen timestamp — closes the race where a slow agent turn overlaps
   * a Meta webhook retry for the same message (see `onCloudMessage`). Holds
   * only the opaque id + a timestamp, same data class as `lastInboundAt`,
   * never message content, never persisted. Swept alongside `lastInboundAt`.
   */
  private readonly seenMessageIds = new Map<string, number>();

  /**
   * Senders already welcomed this process (issue #255), keyed to first-seen
   * timestamp — checked and populated synchronously BEFORE the
   * `isKnownConversation` await, mirroring `seenMessageIds`' check-and-insert
   * pattern, so two messages from the same brand-new sender arriving
   * milliseconds apart (both seeing `isKnownConversation` return `false`)
   * still only trigger one welcome send. In-memory only, never persisted —
   * the DB-backed `isKnownConversation` check is the durable backstop that
   * stops a restart from re-welcoming an already-known contact. Swept
   * alongside `lastInboundAt`/`seenMessageIds` so a long-running process
   * doesn't grow it forever (a sender aged out here is, by then, a known
   * conversation in the DB, so the backstop still prevents a re-welcome).
   */
  private readonly welcomedThisRun = new Map<string, number>();

  /**
   * Messages queued per-recipient (issue #602) after a live admin-alert send
   * rejected with `WindowClosedError` — the recipient's own 24h
   * customer-service window was closed, not a genuine failure. Bounded at
   * `WINDOW_REOPEN_QUEUE_CAP` per recipient; on overflow it evicts by the same
   * priority rule as the shared `pendingAlertQueue` (#545), so a member-reachable
   * `'low'` alert can never displace a `'system'` one (see `queueForWindowReopen`).
   * Flushed the instant that exact recipient's own next inbound message
   * updates `lastInboundAt` (see `onCloudMessage`) — never on a timer or
   * reconnect, so nothing is ever sent outside Meta's window. In-memory
   * only; clears on restart, same tradeoff as every other queue here.
   */
  private readonly windowReopenQueue = new Map<string, { message: string; priority: AlertPriority }[]>();

  /**
   * Consecutive `sendChunk` (real message send) failures, process-wide. Only
   * `sendChunk` drives this — `sendTypingIndicator`'s best-effort Graph API
   * calls deliberately do NOT, so a typing-indicator hiccup can never flip
   * the connectivity signal.
   */
  private consecutiveSendFailures = 0;

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    const { phoneNumberId, accessToken, verifyToken, appSecret, webhookPort } = config.whatsapp.cloud;
    if (!phoneNumberId || !accessToken || !verifyToken || !appSecret) {
      throw new Error(
        'WhatsAppCloudAdapter requires WHATSAPP_CLOUD_PHONE_NUMBER_ID, _ACCESS_TOKEN, _VERIFY_TOKEN, and _APP_SECRET',
      );
    }

    await new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          logger.error({ err }, 'WhatsApp Cloud webhook handler failed');
          if (!res.headersSent) res.writeHead(500).end();
        });
      });
      server.once('error', reject);
      server.listen(webhookPort, () => {
        server.off('error', reject);
        resolve();
      });
      this.server = server;
    });
    this.sweepTimer = setInterval(() => this.sweepLastInboundAt(), LAST_INBOUND_SWEEP_MS);
    this.sweepTimer.unref?.();
    logger.info({ port: webhookPort }, 'WhatsApp Cloud webhook listening');
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /**
   * This is a stateless webhook receiver, not a persistent socket — there's
   * no "connection" to drop the way Baileys/Discord have — so this reflects
   * the local HTTP listener being up AND the last `SEND_FAILURE_THRESHOLD`
   * real message sends not having all failed (a proxy for Meta actually
   * being reachable with a valid token).
   *
   * Recovery is sticky: once flipped `false`, this only returns to `true` on
   * the next successful send. On an idle deployment (no outbound attempts
   * after the outage clears) `isConnected()` — and therefore `/healthz` and
   * the sustained-disconnect alert — stays `false` until traffic resumes.
   * That's a bounded false-"down", the safer failure mode versus the
   * permanent false-"up" this replaces.
   */
  isConnected(): boolean {
    return this.server !== null && this.consecutiveSendFailures < SEND_FAILURE_THRESHOLD;
  }

  /**
   * Drop tracked senders whose last inbound message has aged out of the 24h
   * window, and Meta message ids that have aged out of the (much shorter)
   * webhook-retry dedup window. Same timer (`sweepTimer`), two independent
   * cutoffs — an evicted message id is treated as new if Meta ever redelivers
   * it after the dedup window closes, an accepted trade-off (see #249).
   */
  private sweepLastInboundAt(): void {
    const now = Date.now();
    const inboundCutoff = now - CUSTOMER_SERVICE_WINDOW_MS;
    for (const [from, lastInbound] of this.lastInboundAt) {
      if (lastInbound < inboundCutoff) this.lastInboundAt.delete(from);
    }
    const dedupCutoff = now - MESSAGE_ID_DEDUP_WINDOW_MS;
    for (const [id, firstSeen] of this.seenMessageIds) {
      if (firstSeen < dedupCutoff) this.seenMessageIds.delete(id);
    }
    // Same cutoff as lastInboundAt: a sender welcomed longer ago than the
    // customer-service window is, by now, a known conversation in the DB, so
    // the `isKnownConversation` backstop prevents a re-welcome even after the
    // in-memory guard is evicted.
    for (const [from, welcomedAt] of this.welcomedThisRun) {
      if (welcomedAt < inboundCutoff) this.welcomedThisRun.delete(from);
    }
  }

  private async handleRequest(req: HttpRequest, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET') {
      this.handleVerification(url, res);
      return;
    }
    if (req.method === 'POST') {
      await this.handleWebhook(req, res);
      return;
    }
    res.writeHead(405).end();
  }

  private handleVerification(url: URL, res: ServerResponse): void {
    const verification = parseVerificationRequest(url);
    const { verifyToken } = config.whatsapp.cloud;
    if (verification && verification.mode === 'subscribe' && verification.token === verifyToken) {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end(verification.challenge);
      return;
    }
    logger.warn('Rejected WhatsApp Cloud webhook verification request');
    res.writeHead(403).end();
  }

  private async handleWebhook(req: HttpRequest, res: ServerResponse): Promise<void> {
    let rawBody: Buffer;
    try {
      rawBody = await readBody(req);
    } catch (err) {
      logger.warn({ err }, 'WhatsApp Cloud webhook: failed to read body');
      res.writeHead(413).end();
      return;
    }

    const { appSecret } = config.whatsapp.cloud;
    const signature = req.headers['x-hub-signature-256'];
    if (!verifySignature(rawBody, typeof signature === 'string' ? signature : undefined, appSecret ?? '')) {
      logger.warn('Rejected WhatsApp Cloud webhook: signature verification failed');
      res.writeHead(401).end();
      return;
    }

    // Ack immediately — Meta requires a <5s response or it retries/disables
    // the subscription; message handling continues asynchronously below.
    res.writeHead(200).end();

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch (err) {
      logger.warn({ err }, 'WhatsApp Cloud webhook: invalid JSON body');
      return;
    }

    for (const msg of extractMessages(payload)) {
      await this.onCloudMessage(msg).catch((err) =>
        logger.error({ err }, 'WhatsApp Cloud message handling failed'),
      );
    }
  }

  private async onCloudMessage(msg: CloudInboundMessage): Promise<void> {
    // Check-and-insert BEFORE any await: this is what makes it race-safe
    // against a Meta webhook retry landing while the first delivery's turn
    // is still mid-flight, not just against two deliveries that never
    // overlap. Whichever call reaches this line first wins atomically —
    // Node never interleaves synchronous code between two calls.
    if (this.seenMessageIds.has(msg.id)) {
      logger.debug({ id: msg.id, from: msg.from }, 'WhatsApp Cloud: duplicate webhook delivery, skipping');
      return;
    }
    this.seenMessageIds.set(msg.id, Date.now());

    this.lastInboundAt.set(msg.from, Date.now());
    await this.flushWindowReopenQueue(msg.from);
    if (!this.handler) return;
    if (!isAllowedSender(msg.from, config.whatsapp.allowedJids)) return;

    await this.maybeSendFirstContactWelcome(msg.from);

    const normalised: IncomingMessage = {
      platform: 'whatsapp',
      conversationId: msg.from,
      userId: msg.from,
      userName: msg.name || msg.from,
      text: msg.text,
      isDirect: true,
      addressedToBot: true,
      timestamp: msg.timestampMs,
      messageId: msg.id,
      raw: msg,
    };
    await this.handler(normalised);
  }

  /**
   * First-contact welcome for the Cloud API (issue #255) — the equivalent of
   * Discord's `onGuildMemberAdd` / Baileys' `group-participants.update`
   * welcome, but the Cloud API has no join/membership event to hook, so a
   * sender's own first-ever inbound message is treated as the "join" moment
   * instead. Off unless `WHATSAPP_CLOUD_WELCOME_ENABLED=true`. Runs after the
   * `isAllowedSender` gate and before `this.handler` — the handler is what
   * records this message as an interaction, so the check must run first or
   * every sender would look "known" by the time it ran. Falls back to
   * `WHATSAPP_CLOUD_WELCOME_MESSAGE_OPEN` instead of
   * `WHATSAPP_CLOUD_WELCOME_MESSAGE` when `config.rbac.accessMode.whatsapp`
   * is `'open'` (issue #351).
   */
  private async maybeSendFirstContactWelcome(from: string): Promise<void> {
    if (!config.whatsapp.cloud.welcomeEnabled) return;
    // Check-and-insert BEFORE any await — see welcomedThisRun's doc comment.
    if (this.welcomedThisRun.has(from)) return;
    this.welcomedThisRun.set(from, Date.now());

    // Best-effort, and it MUST NOT throw out of here. This runs inline
    // (awaited) in onCloudMessage BEFORE this.handler, so any error escaping
    // this method propagates up and drops the sender's real message before it
    // reaches the agent. `isKnownConversation` is a bare pool.query with no
    // internal fallback (unlike the policy reads, which swallow DB errors), so
    // a transient pool blip here would otherwise swallow the message. Wrap the
    // whole DB+send body: a DB or Graph hiccup degrades to "skip the welcome,"
    // never "drop the user's message."
    try {
      if (await isKnownConversation('whatsapp', from)) return;
      const defaultWelcomeMessage =
        config.rbac.accessMode.whatsapp === 'open'
          ? WHATSAPP_CLOUD_WELCOME_MESSAGE_OPEN
          : WHATSAPP_CLOUD_WELCOME_MESSAGE;
      const welcomeMessage = (await getWelcomeMessage()) ?? defaultWelcomeMessage;
      const guidelines = await getCommunityGuidelines();
      const welcomeText = guidelines
        ? `${welcomeMessage}\n\nCommunity guidelines:\n${guidelines}`
        : welcomeMessage;
      await this.sendText(from, welcomeText);
    } catch (err) {
      logger.warn({ err, from }, 'WhatsApp Cloud: first-contact welcome skipped (non-fatal)');
    }
  }

  /**
   * Every outbound path is filtered HERE (secret redaction + code policy) so
   * no caller — router reply, announce, warn, super-admin alert — can forget.
   * `language` and `style` are optional (issues #339, #657): only
   * `sendMessage`'s main-reply path passes them through; every other call
   * site (via `sendText`'s default) omits both, so their output stays
   * English-only by construction (never `_MI`/`_PLAIN`).
   */
  private async filtered(text: string, language?: 'mi', style?: 'plain'): Promise<string> {
    return filterOutbound(text, await getCodeAnswersPolicy(), runtimeSecrets(), 'whatsapp', language, style);
  }

  // No `deleteOwnMessage` on this adapter: the Cloud Business API has no
  // message-deletion/unsend endpoint at all (mirrors the existing
  // `delete_message` capability gap, cloudAdapter.ts's `adminCapabilities`
  // below). `sendMessage` therefore always returns undefined — issue #575's
  // reply-retraction mapping is harmless to populate with no id to act on,
  // but there is genuinely no id to report here since `sendText` doesn't
  // surface Meta's response wamid.
  async sendMessage(out: OutgoingMessage): Promise<string[] | undefined> {
    await this.sendText(out.conversationId, out.text, out.language, out.style);
    return undefined;
  }

  async sendDirectMessage(userId: string, text: string): Promise<void> {
    await this.sendText(userId, text);
  }

  /**
   * Queue `message` for delivery to `userId` once their 24h customer-service
   * window reopens (issue #602) — called by `agent/tools.ts`'s
   * `notifyAdmins`/`notifySuperAdmins` when a live `sendDirectMessage`
   * rejected with `WindowClosedError`. Bounded per-recipient at
   * `WINDOW_REOPEN_QUEUE_CAP`. Optional on `PlatformAdapter` — only this
   * adapter has a window to reopen.
   *
   * Overflow eviction mirrors `pendingAlertQueue.ts`'s #545 priority rule
   * (here keyed per-recipient rather than shared): under the cap, append.
   * When full, evict the OLDEST `'low'` (member-reachable) entry to make room,
   * so a `'system'` alert never displaces another `'system'` alert while a
   * `'low'` one can be dropped instead — and, crucially, a `'low'` alert never
   * displaces a `'system'` one. When the recipient's queue is entirely
   * `'system'`, a new `'system'` alert still bounds it FIFO (drops the oldest),
   * but a new `'low'` alert is REJECTED rather than evicting a system alert.
   * Without this a member filing `report_content`/`appeal_moderation` alerts
   * (rate-capped above the cap of 3) could silently evict a queued escalation
   * or admin-action audit for a super-admin whose window is closed —
   * reintroducing exactly the inversion #545 fixed in the shared queue.
   */
  queueForWindowReopen(userId: string, message: string, priority: AlertPriority): void {
    const queued = this.windowReopenQueue.get(userId) ?? [];
    if (queued.length < WINDOW_REOPEN_QUEUE_CAP) {
      queued.push({ message, priority });
      this.windowReopenQueue.set(userId, queued);
      return;
    }
    const oldestLow = queued.findIndex((e) => e.priority === 'low');
    if (oldestLow !== -1) {
      queued.splice(oldestLow, 1);
      queued.push({ message, priority });
      this.windowReopenQueue.set(userId, queued);
      return;
    }
    // Entirely 'system' entries. A new 'system' alert still bounds the backlog
    // FIFO; a new 'low' alert is dropped rather than displacing a system one.
    if (priority === 'system') {
      queued.shift();
      queued.push({ message, priority });
      this.windowReopenQueue.set(userId, queued);
    }
  }

  /**
   * Flushes every message queued for `userId` (see `queueForWindowReopen`)
   * via `sendText`, then clears their entry — called from `onCloudMessage`
   * immediately after `lastInboundAt` records a fresh inbound message from
   * that exact sender, which is what reopens their window. The entry is
   * removed BEFORE sending, so a flush send that throws is logged and
   * dropped rather than re-queued (no unbounded retry loop). Keyed strictly
   * per-recipient: this can only ever touch the queue for `userId`, never
   * any other recipient's entry.
   */
  private async flushWindowReopenQueue(userId: string): Promise<void> {
    const queued = this.windowReopenQueue.get(userId);
    if (!queued || queued.length === 0) return;
    this.windowReopenQueue.delete(userId);
    for (const { message } of queued) {
      try {
        await this.sendText(userId, message);
      } catch (err) {
        logger.warn(
          { err, userId },
          'WhatsApp Cloud: window-reopen flush send failed, dropped (not re-queued)',
        );
      }
    }
  }

  /**
   * Meta exposes typing indicators via the mark-as-read call: marking the
   * inbound message read with `typing_indicator` set shows "typing…" for up
   * to ~25s. Bound to a single inbound wamid — unlike Discord's `sendTyping`,
   * this cannot be meaningfully re-fired for the same message, so the
   * router's periodic re-fire will just no-op (best-effort) on the 2nd+ call.
   */
  async sendTypingIndicator(message: IncomingMessage): Promise<void> {
    const { phoneNumberId, accessToken } = config.whatsapp.cloud;
    if (!phoneNumberId || !accessToken) return;
    const wamid = (message.raw as CloudInboundMessage | undefined)?.id;
    if (!wamid) return;

    const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: wamid,
        typing_indicator: { type: 'text' },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`WhatsApp Cloud typing indicator failed: ${res.status} ${detail}`);
    }
  }

  /**
   * Meta only allows free-form messages — text or media — within 24h of the
   * user's last inbound message; outside that window only pre-approved
   * templates work, which this adapter doesn't send. Shared by `sendText`
   * and `sendImage` so both fail identically, before any Graph API call.
   */
  private assertWithinCustomerServiceWindow(to: string): void {
    const lastInbound = this.lastInboundAt.get(to);
    const withinWindow = lastInbound !== undefined && Date.now() - lastInbound < CUSTOMER_SERVICE_WINDOW_MS;
    if (!withinWindow) {
      throw new WindowClosedError(to);
    }
  }

  private async sendText(to: string, text: string, language?: 'mi', style?: 'plain'): Promise<void> {
    const { phoneNumberId, accessToken } = config.whatsapp.cloud;
    if (!phoneNumberId || !accessToken) throw new Error('WhatsApp Cloud adapter not configured');
    this.assertWithinCustomerServiceWindow(to);

    // A single window check and a single filter pass govern the whole reply;
    // it's then split at Meta's 4096-char body limit and sent as sequential
    // messages (mirrors Discord's chunking at its own 2000-char limit). If a
    // chunk in the middle fails, earlier chunks have already been delivered
    // and the throw propagates — same partial-failure semantics as Discord.
    for (const chunk of chunkText(await this.filtered(text, language, style), WHATSAPP_CLOUD_MAX_LEN)) {
      await this.sendChunk(to, phoneNumberId, accessToken, chunk);
    }
  }

  /**
   * Isolated so tests can mock it and assert the computed delay without
   * waiting on a real timer.
   */
  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Issues `fetch(url, init)`, retrying exactly once — honoring
   * `Retry-After` via `retryAfterDelayMs` — if (and only if) the first
   * response is a `429`. Reuses the exact same `init` (including its
   * already-built, already-filtered `body`) for the retry, so nothing is
   * re-derived or re-filtered. A non-429 non-OK response, or a 429 whose
   * retry also fails, is returned as-is for the caller's existing `!res.ok`
   * handling, unchanged from today. A rejected fetch (network error) on
   * either attempt propagates to the caller's own try/catch, same as an
   * unretried failure today.
   */
  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    const res = await fetch(url, init);
    if (res.status !== 429) return res;
    await this.sleep(retryAfterDelayMs(res));
    return fetch(url, init);
  }

  private async sendChunk(
    to: string,
    phoneNumberId: string,
    accessToken: string,
    body: string,
  ): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchWithRetry(
        `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to,
            type: 'text',
            text: { body },
          }),
        },
      );
    } catch (err) {
      // A rejected fetch (DNS/TCP/TLS failure, timeout, offline) is just as
      // much a send failure as a non-OK response — and it's the shape a real
      // Graph API outage takes. Count it too, or isConnected() would never
      // trip and the disconnect alert would never fire (issue #218).
      this.recordSendFailure();
      throw err instanceof Error ? err : new Error(`WhatsApp Cloud send failed: ${String(err)}`);
    }
    if (!res.ok) {
      this.recordSendFailure();
      const detail = await res.text().catch(() => '');
      throw new Error(`WhatsApp Cloud send failed: ${res.status} ${detail}`);
    }
    this.consecutiveSendFailures = 0;
  }

  /**
   * Post a generated image (with an optional caption) to a conversation
   * (issue #356) — Cloud parity with Baileys'/Discord's `sendImage`. Unlike
   * `sendText`'s single-call shape, Meta's Cloud API requires two Graph
   * calls: upload the bytes to get a media id, then send a message
   * referencing that id. The window is checked, and the caption filtered,
   * before either call — so an out-of-window send or an unredacted secret
   * never reaches Meta at all, not even via the upload.
   */
  async sendImage(
    conversationId: string,
    image: { data: Buffer; filename: string; mimeType: string },
    caption?: string,
  ): Promise<void> {
    const { phoneNumberId, accessToken } = config.whatsapp.cloud;
    if (!phoneNumberId || !accessToken) throw new Error('WhatsApp Cloud adapter not configured');
    this.assertWithinCustomerServiceWindow(conversationId);

    const filteredCaption = caption !== undefined ? await this.filtered(caption) : undefined;
    const mediaId = await this.uploadMedia(phoneNumberId, accessToken, image);
    await this.sendImageMessage(phoneNumberId, accessToken, conversationId, mediaId, filteredCaption);
  }

  /** Step 1 of `sendImage`: upload the raw bytes, returning the Graph-assigned media id. */
  private async uploadMedia(
    phoneNumberId: string,
    accessToken: string,
    image: { data: Buffer; filename: string; mimeType: string },
  ): Promise<string> {
    const form = new FormData();
    form.set('messaging_product', 'whatsapp');
    form.set('type', image.mimeType);
    form.set('file', new Blob([new Uint8Array(image.data)], { type: image.mimeType }), image.filename);

    let res: Response;
    try {
      res = await this.fetchWithRetry(
        `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/media`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}` },
          body: form,
        },
      );
    } catch (err) {
      // Same rationale as sendChunk: a rejected fetch is as much a send
      // failure as a non-OK response, and must count toward isConnected().
      this.recordSendFailure();
      throw err instanceof Error ? err : new Error(`WhatsApp Cloud media upload failed: ${String(err)}`);
    }
    if (!res.ok) {
      this.recordSendFailure();
      const detail = await res.text().catch(() => '');
      throw new Error(`WhatsApp Cloud media upload failed: ${res.status} ${detail}`);
    }
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    if (!body.id) {
      this.recordSendFailure();
      throw new Error('WhatsApp Cloud media upload failed: no media id in response');
    }
    return body.id;
  }

  /** Step 2 of `sendImage`: send the message referencing the uploaded media id. */
  private async sendImageMessage(
    phoneNumberId: string,
    accessToken: string,
    to: string,
    mediaId: string,
    caption?: string,
  ): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchWithRetry(
        `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to,
            type: 'image',
            image: caption !== undefined ? { id: mediaId, caption } : { id: mediaId },
          }),
        },
      );
    } catch (err) {
      this.recordSendFailure();
      throw err instanceof Error ? err : new Error(`WhatsApp Cloud send failed: ${String(err)}`);
    }
    if (!res.ok) {
      this.recordSendFailure();
      const detail = await res.text().catch(() => '');
      throw new Error(`WhatsApp Cloud send failed: ${res.status} ${detail}`);
    }
    this.consecutiveSendFailures = 0;
  }

  /**
   * Record one failed real-message send and, on crossing the threshold, log
   * it once. Called for BOTH a non-OK response and a rejected fetch so
   * isConnected() reflects a sustained outage regardless of its shape.
   */
  private recordSendFailure(): void {
    this.consecutiveSendFailures++;
    if (this.consecutiveSendFailures === SEND_FAILURE_THRESHOLD) {
      logger.warn(
        { consecutiveSendFailures: this.consecutiveSendFailures },
        'WhatsApp Cloud: consecutive send failures crossed threshold, reporting disconnected',
      );
    }
  }

  /**
   * React to a message with an emoji (issue #528) — Cloud parity with
   * Discord's/Baileys' `reactToMessage`. A reaction is a native free-form
   * Cloud API message type (no template requirement of its own), so it's
   * gated by the same 24h customer-service window as `sendText`/`sendImage`
   * and posted to the same `/messages` endpoint with `type: 'reaction'`.
   */
  async reactToMessage(conversationId: string, messageId: string, emoji: string): Promise<void> {
    const { phoneNumberId, accessToken } = config.whatsapp.cloud;
    if (!phoneNumberId || !accessToken) throw new Error('WhatsApp Cloud adapter not configured');
    this.assertWithinCustomerServiceWindow(conversationId);

    let res: Response;
    try {
      res = await this.fetchWithRetry(
        `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: conversationId,
            type: 'reaction',
            reaction: { message_id: messageId, emoji },
          }),
        },
      );
    } catch (err) {
      // Same rationale as sendChunk/sendImageMessage: a rejected fetch is as
      // much a send failure as a non-OK response, and must count toward
      // isConnected().
      this.recordSendFailure();
      throw err instanceof Error ? err : new Error(`WhatsApp Cloud reaction failed: ${String(err)}`);
    }
    if (!res.ok) {
      this.recordSendFailure();
      const detail = await res.text().catch(() => '');
      throw new Error(`WhatsApp Cloud reaction failed: ${res.status} ${detail}`);
    }
    this.consecutiveSendFailures = 0;
  }

  /** No groups on the Cloud API — a user's only conversation is their 1:1 with the bot. */
  async conversationsForUser(userId: string): Promise<string[]> {
    return [userId];
  }

  async performAdminAction(action: AdminAction): Promise<string> {
    switch (action.kind) {
      case 'warn_user': {
        const prefix = action.params?.language === 'mi' ? WARN_USER_DM_PREFIX_MI : WARN_USER_DM_PREFIX;
        await this.sendDirectMessage(
          action.targetUserId ?? '',
          `${prefix} ${paramString(action.params?.reason)}`,
        );
        return `Warned ${action.targetUserId}.`;
      }
      // block_user/unblock_user (issue #572) are a pure DB write, no Cloud
      // API call — the only lever this adapter has against a persistent
      // abuser, since the Cloud API otherwise has no moderation surface.
      case 'block_user': {
        const targetUserId = action.targetUserId ?? '';
        await blockUser(
          'whatsapp',
          targetUserId,
          paramString(action.params?.blockedBy),
          paramString(action.params?.reason) || null,
        );
        return `Blocked ${targetUserId}.`;
      }
      case 'unblock_user': {
        const targetUserId = action.targetUserId ?? '';
        const removed = await unblockUser('whatsapp', targetUserId);
        return removed ? `Unblocked ${targetUserId}.` : `${targetUserId} was not blocked.`;
      }
      default:
        throw new Error(
          `Unsupported WhatsApp Cloud action: ${action.kind} (the Cloud API has no group/moderation surface).`,
        );
    }
  }
}

/**
 * Reads Meta's `Retry-After` header off a 429 response — an integer count of
 * seconds, per Meta's documented Graph API behaviour, not an HTTP-date — and
 * converts it to a clamped delay in ms. Falls back to
 * `SEND_RETRY_DEFAULT_BACKOFF_MS` when the header is absent, unparseable, or
 * non-positive; always clamps to `SEND_RETRY_MAX_BACKOFF_MS` regardless of
 * the header value, so an extreme or malformed header can't stall a retry
 * for an extended period.
 */
function retryAfterDelayMs(res: Response): number {
  const header = res.headers.get('retry-after');
  const seconds = header === null ? NaN : Number(header);
  const delayMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : SEND_RETRY_DEFAULT_BACKOFF_MS;
  return Math.min(delayMs, SEND_RETRY_MAX_BACKOFF_MS);
}

function readBody(req: HttpRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('WhatsApp Cloud webhook body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
