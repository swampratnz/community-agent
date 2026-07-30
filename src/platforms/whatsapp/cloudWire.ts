import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Pure helpers for the WhatsApp Business Cloud API webhook wire format
 * (signature verification, verification handshake, inbound payload
 * normalisation). Kept free of config/HTTP imports so they are unit-testable.
 */

/**
 * Verify Meta's `X-Hub-Signature-256` header against the raw request body.
 * MUST be checked before the body is parsed or acted on in any way — this is
 * the Cloud API's substitute for Baileys' transport trust.
 */
export function verifySignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader || !appSecret) return false;
  const prefix = 'sha256=';
  if (!signatureHeader.startsWith(prefix)) return false;
  const expectedHex = signatureHeader.slice(prefix.length);
  if (!/^[0-9a-f]+$/i.test(expectedHex)) return false;

  const computed = createHmac('sha256', appSecret).update(rawBody).digest();
  const expected = Buffer.from(expectedHex, 'hex');
  if (expected.length !== computed.length) return false;
  return timingSafeEqual(expected, computed);
}

/**
 * Constant-time string equality for comparing a caller-supplied value against
 * a configured secret — the `hub.verify_token` handshake below being the one
 * such comparison on this adapter that a `===` would otherwise decide with an
 * early-exit, input-dependent number of byte comparisons.
 *
 * Both sides are SHA-256'd first so the compared buffers are always the same
 * fixed width: `timingSafeEqual` throws outright on a length mismatch, and
 * length-checking before it would leak the configured token's length. Hashing
 * is what makes this safe for arbitrary, attacker-chosen input lengths.
 *
 * An empty/absent value on either side never matches, so an unconfigured
 * secret can't be satisfied by an empty request parameter.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  if (!a || !b) return false;
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

export interface WebhookVerification {
  mode: string;
  token: string;
  challenge: string;
}

/** Parse the `hub.mode`/`hub.verify_token`/`hub.challenge` GET handshake. */
export function parseVerificationRequest(url: URL): WebhookVerification | null {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  if (!mode || !token || !challenge) return null;
  return { mode, token, challenge };
}

/**
 * Check a bare phone-number digit string (a Cloud API sender id) against
 * `WHATSAPP_ALLOWED_JIDS`. That list is shared with BaileysAdapter, whose
 * entries are full JIDs ('64211234567@s.whatsapp.net', '...@g.us') rather
 * than bare digits — normalise by stripping everything from '@' onward so
 * either format works, instead of silently never matching.
 */
export function isAllowedSender(from: string, allowedJids: readonly string[]): boolean {
  if (allowedJids.length === 0) return true;
  return allowedJids.some((entry) => entry.split('@')[0] === from);
}

export interface CloudInboundMessage {
  /** Sender's phone number (E.164 digits, no '+'). */
  from: string;
  id: string;
  timestampMs: number;
  text: string;
  name: string;
  /**
   * Present only for an inbound `image` message (issue #891, the WhatsApp
   * Cloud API counterpart to Discord's #783 / Baileys' #879 image-attachment
   * input). Carries exactly Meta's own webhook metadata — media id, declared
   * MIME type, and an optional caption — extracted regardless of
   * `WHATSAPP_CLOUD_IMAGE_INPUT_ENABLED`, since this is a pure wire helper
   * with no config access (see the file doc comment); the CALLER
   * (`onCloudMessage`) is the single gate that decides whether to fetch the
   * bytes. `text` above stays `''` for an image message — Meta delivers a
   * caption as `image.caption`, never as a separate text message — so the
   * caption is promoted to the turn's `text` only once the image is actually
   * accepted, mirroring the total silence a below-flag/below-tier/refused
   * image already produces today.
   */
  image?: { mediaId: string; mimeType: string; caption?: string };
}

interface MetaContact {
  profile?: { name?: string };
  wa_id?: string;
}
interface MetaImage {
  id?: string;
  mime_type?: string;
  caption?: string;
}
interface MetaMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: MetaImage;
}
interface MetaValue {
  contacts?: MetaContact[];
  messages?: MetaMessage[];
}
interface MetaChange {
  value?: MetaValue;
}
interface MetaEntry {
  changes?: MetaChange[];
}
interface MetaPayload {
  object?: string;
  entry?: MetaEntry[];
}

/**
 * Normalise a Meta `messages` webhook payload into inbound messages. Text and
 * (issue #891) well-formed image messages are extracted; every other type
 * (audio/document/sticker/video/status/etc.) and malformed entries are
 * silently skipped, unchanged from before #891 — an image entry missing its
 * own `image.id` (Meta's media id) is treated as malformed too, since there
 * is nothing to ever fetch.
 */
export function extractMessages(payload: unknown): CloudInboundMessage[] {
  const out: CloudInboundMessage[] = [];
  const body = payload as MetaPayload;
  if (body?.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) return out;

  for (const entry of body.entry) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value || !Array.isArray(value.messages)) continue;

      const nameByWaId = new Map<string, string>();
      for (const contact of value.contacts ?? []) {
        if (contact.wa_id) nameByWaId.set(contact.wa_id, contact.profile?.name ?? '');
      }

      for (const msg of value.messages) {
        if (!msg.from || !msg.id) continue;
        const name = nameByWaId.get(msg.from) ?? '';
        const timestampMs = Number(msg.timestamp ?? 0) * 1000;

        if (msg.type === 'text') {
          if (typeof msg.text?.body !== 'string') continue;
          out.push({ from: msg.from, id: msg.id, timestampMs, text: msg.text.body, name });
          continue;
        }

        if (msg.type === 'image') {
          const mediaId = msg.image?.id;
          if (!mediaId) continue;
          out.push({
            from: msg.from,
            id: msg.id,
            timestampMs,
            text: '',
            name,
            image: { mediaId, mimeType: msg.image?.mime_type ?? '', caption: msg.image?.caption },
          });
        }
      }
    }
  }
  return out;
}
