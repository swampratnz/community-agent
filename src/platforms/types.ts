/**
 * Platform-agnostic messaging abstraction.
 *
 * Discord and WhatsApp adapters both normalise their native events into an
 * {@link IncomingMessage} and implement {@link PlatformAdapter}, so the agent
 * core and router never need to know which platform a message came from.
 */

export type Platform = 'discord' | 'whatsapp';

/** Coarse permission level derived from platform-native roles/identity. */
export type Role = 'admin' | 'user';

/** A message received from a platform, normalised to a common shape. */
export interface IncomingMessage {
  platform: Platform;
  /** Stable conversation identifier (Discord channel id / WhatsApp JID). */
  conversationId: string;
  /** Stable per-platform user identifier (Discord user id / WhatsApp number). */
  userId: string;
  /** Human-readable display name, best-effort. */
  userName: string;
  /** Plain-text content of the message. */
  text: string;
  /** True if this is a 1:1 / direct conversation rather than a group/channel. */
  isDirect: boolean;
  /** Resolved permission level for this sender. */
  role: Role;
  /** Whether the bot was explicitly addressed (mention / DM / reply). */
  addressedToBot: boolean;
  /** Epoch milliseconds the platform reported for the message. */
  timestamp: number;
  /** Opaque platform-native payload, for adapters that need extra context. */
  raw?: unknown;
}

/** A reply the agent wants to send back to a conversation. */
export interface OutgoingMessage {
  conversationId: string;
  text: string;
}

export type MessageHandler = (message: IncomingMessage) => Promise<void> | void;

/**
 * A privileged action the agent can request against a platform. Adapters
 * advertise which capabilities they support; unsupported actions throw.
 * RBAC is enforced *before* these are ever invoked (admin-only tools).
 */
export interface AdminAction {
  /** e.g. 'timeout_user', 'delete_message', 'announce', 'kick_user'. */
  kind: string;
  conversationId?: string;
  targetUserId?: string;
  params?: Record<string, unknown>;
}

export interface PlatformAdapter {
  readonly platform: Platform;

  /** Connect and begin receiving messages. Resolves once ready. */
  start(): Promise<void>;

  /** Gracefully disconnect. */
  stop(): Promise<void>;

  /** Register the handler invoked for every incoming message. */
  onMessage(handler: MessageHandler): void;

  /** Send a text reply to a conversation. */
  sendMessage(out: OutgoingMessage): Promise<void>;

  /** Capabilities this adapter supports for {@link performAdminAction}. */
  readonly adminCapabilities: ReadonlySet<string>;

  /** Perform a privileged moderation/management action. */
  performAdminAction(action: AdminAction): Promise<string>;
}
