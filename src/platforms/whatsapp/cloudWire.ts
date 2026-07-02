import { createHmac, timingSafeEqual } from 'node:crypto';

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

export interface CloudInboundMessage {
  /** Sender's phone number (E.164 digits, no '+'). */
  from: string;
  id: string;
  timestampMs: number;
  text: string;
  name: string;
}

interface MetaContact {
  profile?: { name?: string };
  wa_id?: string;
}
interface MetaMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
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
 * Normalise a Meta `messages` webhook payload into inbound text messages.
 * Non-text message types (image/audio/status/etc.) and malformed entries are
 * silently skipped — only well-formed text messages are actionable here.
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
        if (msg.type !== 'text' || !msg.from || !msg.id || typeof msg.text?.body !== 'string') continue;
        out.push({
          from: msg.from,
          id: msg.id,
          timestampMs: Number(msg.timestamp ?? 0) * 1000,
          text: msg.text.body,
          name: nameByWaId.get(msg.from) ?? '',
        });
      }
    }
  }
  return out;
}
