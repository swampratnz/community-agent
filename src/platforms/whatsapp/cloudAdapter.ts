import {
  createServer,
  type IncomingMessage as HttpRequest,
  type Server,
  type ServerResponse,
} from 'node:http';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { filterOutbound } from '../../agent/outbound.js';
import { runtimeSecrets } from '../../agent/secrets.js';
import { getCodeAnswersPolicy } from '../../storage/policies.js';
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
 * Consecutive real-message send failures (across all recipients) before
 * `isConnected()` flips `false`. A single recipient-specific failure (bad
 * number, template requirement, a transient Meta 5xx) doesn't trip this,
 * because the very next successful send — to any recipient — resets the
 * counter to 0. Only a systemic, persistent failure (expired/revoked token,
 * broken egress) survives long enough to cross the threshold.
 */
const SEND_FAILURE_THRESHOLD = 3;

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
  readonly adminCapabilities = new Set(['warn_user']);

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

  /** Drop tracked senders whose last inbound message has aged out of the 24h window. */
  private sweepLastInboundAt(): void {
    const cutoff = Date.now() - CUSTOMER_SERVICE_WINDOW_MS;
    for (const [from, lastInbound] of this.lastInboundAt) {
      if (lastInbound < cutoff) this.lastInboundAt.delete(from);
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
    this.lastInboundAt.set(msg.from, Date.now());
    if (!this.handler) return;
    if (!isAllowedSender(msg.from, config.whatsapp.allowedJids)) return;

    const normalised: IncomingMessage = {
      platform: 'whatsapp',
      conversationId: msg.from,
      userId: msg.from,
      userName: msg.name || msg.from,
      text: msg.text,
      isDirect: true,
      addressedToBot: true,
      timestamp: msg.timestampMs,
      raw: msg,
    };
    await this.handler(normalised);
  }

  /**
   * Every outbound path is filtered HERE (secret redaction + code policy) so
   * no caller — router reply, announce, warn, super-admin alert — can forget.
   */
  private async filtered(text: string): Promise<string> {
    return filterOutbound(text, await getCodeAnswersPolicy(), runtimeSecrets(), 'whatsapp');
  }

  async sendMessage(out: OutgoingMessage): Promise<void> {
    await this.sendText(out.conversationId, out.text);
  }

  async sendDirectMessage(userId: string, text: string): Promise<void> {
    await this.sendText(userId, text);
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

  private async sendText(to: string, text: string): Promise<void> {
    const { phoneNumberId, accessToken } = config.whatsapp.cloud;
    if (!phoneNumberId || !accessToken) throw new Error('WhatsApp Cloud adapter not configured');

    const lastInbound = this.lastInboundAt.get(to);
    const withinWindow = lastInbound !== undefined && Date.now() - lastInbound < CUSTOMER_SERVICE_WINDOW_MS;
    if (!withinWindow) {
      throw new Error(
        `Cannot send free-form WhatsApp message to ${to}: outside the 24h customer-service window ` +
          '(no recent inbound message from this user). Only pre-approved message templates can be sent here.',
      );
    }

    // A single window check and a single filter pass govern the whole reply;
    // it's then split at Meta's 4096-char body limit and sent as sequential
    // messages (mirrors Discord's chunking at its own 2000-char limit). If a
    // chunk in the middle fails, earlier chunks have already been delivered
    // and the throw propagates — same partial-failure semantics as Discord.
    for (const chunk of chunkText(await this.filtered(text), WHATSAPP_CLOUD_MAX_LEN)) {
      await this.sendChunk(to, phoneNumberId, accessToken, chunk);
    }
  }

  private async sendChunk(
    to: string,
    phoneNumberId: string,
    accessToken: string,
    body: string,
  ): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
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
      });
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

  /** No groups on the Cloud API — a user's only conversation is their 1:1 with the bot. */
  async conversationsForUser(userId: string): Promise<string[]> {
    return [userId];
  }

  async performAdminAction(action: AdminAction): Promise<string> {
    switch (action.kind) {
      case 'warn_user': {
        await this.sendDirectMessage(
          action.targetUserId ?? '',
          `⚠️ Warning from NZ Claude Community: ${paramString(action.params?.reason)}`,
        );
        return `Warned ${action.targetUserId}.`;
      }
      default:
        throw new Error(
          `Unsupported WhatsApp Cloud action: ${action.kind} (the Cloud API has no group/moderation surface).`,
        );
    }
  }
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
