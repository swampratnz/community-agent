import type {
  AdminAction,
  MessageHandler,
  OutgoingMessage,
  PlatformAdapter,
} from '../types.js';

/**
 * Stub for the official WhatsApp Business Cloud API (Meta).
 *
 * This is intentionally unimplemented: it documents the seam so the project
 * can move off Baileys to the official, ToS-compliant API without touching the
 * agent core or router. To implement:
 *  1. Stand up an HTTPS webhook endpoint (verify with WHATSAPP_CLOUD_VERIFY_TOKEN).
 *  2. On inbound `messages` webhooks, normalise to IncomingMessage and call the handler.
 *  3. sendMessage -> POST https://graph.facebook.com/v21.0/{PHONE_NUMBER_ID}/messages.
 *  4. Map admin actions (the Cloud API has no group moderation; most will be unsupported).
 *
 * See docs/ARCHITECTURE.md "Switching WhatsApp providers".
 */
export class WhatsAppCloudAdapter implements PlatformAdapter {
  readonly platform = 'whatsapp' as const;
  readonly adminCapabilities = new Set<string>([]);

  onMessage(_handler: MessageHandler): void {
    throw new Error('WhatsAppCloudAdapter is not implemented yet. Set WHATSAPP_PROVIDER=baileys.');
  }

  async start(): Promise<void> {
    throw new Error('WhatsAppCloudAdapter is not implemented yet. Set WHATSAPP_PROVIDER=baileys.');
  }

  async stop(): Promise<void> {
    /* nothing to do */
  }

  async sendMessage(_out: OutgoingMessage): Promise<void> {
    throw new Error('WhatsAppCloudAdapter.sendMessage not implemented.');
  }

  async performAdminAction(_action: AdminAction): Promise<string> {
    throw new Error('WhatsAppCloudAdapter.performAdminAction not implemented.');
  }
}
