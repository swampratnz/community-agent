import type { WAMessage, proto } from '@whiskeysockets/baileys';

/**
 * Pure helpers for WhatsApp wire formats (JIDs, message unwrapping).
 * Kept free of config/socket imports so they are unit-testable.
 */

/** Strip the device suffix and domain from a JID: '6421...:12@s.whatsapp.net' -> '6421...'. */
export function jidLocalPart(jid: string | undefined | null): string {
  if (!jid) return '';
  return jid.split('@')[0].split(':')[0];
}

export function isLidJid(jid: string | undefined | null): boolean {
  return !!jid && jid.endsWith('@lid');
}

/**
 * True if a stored user id is a plain phone number that may safely be turned
 * into a `<id>@s.whatsapp.net` JID. LID-fallback ids (see `lidFallbackId`)
 * and anything else must never be routed as a phone number — LID digits sent
 * as a phone JID could deliver to an unrelated real number.
 */
export function isPhoneUserId(id: string): boolean {
  return /^\d{5,16}$/.test(id);
}

/** Mark an unresolvable-LID sender id so it can never be mistaken for a phone. */
export function lidFallbackId(lidLocalPart: string): string {
  return `lid:${lidLocalPart}`;
}

/**
 * Resolve the sender's real PHONE NUMBER for a message, handling WhatsApp's
 * LID (privacy) JIDs. When the routing JID is a LID, Baileys exposes the
 * phone number on key.senderPn / key.participantPn. Returns '' if no phone
 * number can be determined (LID-only sender on an old server payload).
 */
export function senderPhoneNumber(msg: WAMessage, isGroup: boolean): string {
  const key = msg.key;
  if (isGroup) {
    const participant = key.participant ?? '';
    if (isLidJid(participant)) return jidLocalPart(key.participantPn);
    return jidLocalPart(participant);
  }
  const remote = key.remoteJid ?? '';
  if (isLidJid(remote)) return jidLocalPart(key.senderPn);
  return jidLocalPart(remote);
}

/**
 * Unwrap protocol containers (disappearing messages, view-once, document
 * captions) to reach the real content message.
 */
export function unwrapMessage(m: proto.IMessage | null | undefined): proto.IMessage | null {
  if (!m) return null;
  if (m.ephemeralMessage?.message) return unwrapMessage(m.ephemeralMessage.message);
  if (m.viewOnceMessage?.message) return unwrapMessage(m.viewOnceMessage.message);
  if (m.viewOnceMessageV2?.message) return unwrapMessage(m.viewOnceMessageV2.message);
  if (m.documentWithCaptionMessage?.message) return unwrapMessage(m.documentWithCaptionMessage.message);
  return m;
}

export function extractText(msg: WAMessage): { text: string; contextInfo: proto.IContextInfo | null } {
  const m = unwrapMessage(msg.message);
  if (!m) return { text: '', contextInfo: null };
  const text =
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    '';
  const contextInfo = m.extendedTextMessage?.contextInfo ?? null;
  return { text, contextInfo };
}
