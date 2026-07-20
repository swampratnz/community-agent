/**
 * Platform-agnostic messaging abstraction.
 *
 * Discord and WhatsApp adapters both normalise their native events into an
 * {@link IncomingMessage} and implement {@link PlatformAdapter}, so the agent
 * core and router never need to know which platform a message came from.
 *
 * Adapters carry IDENTITY only (who/where); permission tiers are resolved by
 * the router from env + database (see auth/roles.ts), never in adapters and
 * never from message content.
 */

export type Platform = 'discord' | 'whatsapp';

/** Permission tier. Defined here to keep types.ts dependency-free. */
export type Tier = 'super_admin' | 'admin' | 'member' | 'guest';

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
  /** Whether the bot was explicitly addressed (mention / DM / reply). */
  addressedToBot: boolean;
  /**
   * True when the platform identifies the author as a bot, webhook, or
   * system account (issue #477's auto-answer loop-prevention). Adapters that
   * already refuse to construct an `IncomingMessage` for such an author
   * (Discord's `onDiscordMessage` returns before this point) never need to
   * set this — it exists as a second, router-level backstop so the
   * self/bot/webhook exclusion is enforced (and testable) in the router
   * itself, not only implicitly by an adapter never calling the handler.
   * Unset/false everywhere else, so this is a no-op for every existing path.
   */
  isBotAuthor?: boolean;
  /**
   * Platform-native message id, when the platform exposes one. Lets stored
   * interactions be deleted/updated when the original message is (ambient
   * archiving, issue #48).
   */
  messageId?: string;
  /** Epoch milliseconds the platform reported for the message. */
  timestamp: number;
  /** Opaque platform-native payload, for adapters that need extra context. */
  raw?: unknown;
}

/** A reply the agent wants to send back to a conversation. */
export interface OutgoingMessage {
  conversationId: string;
  text: string;
  /**
   * Set only on the router's real-agent-turn main reply (issue #339) when the
   * caller has a standing `language_preference` of `'mi'` — picks the `_MI`
   * variant of the outbound code-policy note. Every other send path
   * (`sendDirectMessage`, poll question/answers, thread name/description,
   * announce, warn) never sets this and stays English-only, by construction.
   */
  language?: 'mi';
}

export type MessageHandler = (message: IncomingMessage) => Promise<void> | void;

/**
 * Looks up the live adapter for a platform other than the one the current
 * turn arrived on, backed by Router's adapter registry (issue #157). Lets a
 * per-turn tool handler reach a different platform's already-known identity
 * (e.g. DMing the submitter of a suggestion filed on a platform other than
 * the resolving admin's current turn) without a new adapter instance or any
 * new trust boundary — the target platform must already be registered in
 * this deployment. Returns undefined when it isn't (e.g. WhatsApp not
 * configured); callers must degrade to today's silent skip, never throw or
 * misaddress.
 */
export type AdapterLookup = (platform: Platform) => PlatformAdapter | undefined;

/**
 * A privileged action the agent can request against a platform. Adapters
 * advertise which capabilities they support; unsupported actions throw.
 * RBAC is enforced *before* these are ever invoked (tier-gated tools plus
 * conversation-membership scoping).
 */
export interface AdminAction {
  /** e.g. 'timeout_user', 'delete_message', 'kick_user', 'warn_user'. */
  kind: string;
  conversationId?: string;
  targetUserId?: string;
  params?: Record<string, unknown>;
}

/** Safely read a string out of {@link AdminAction.params}, falling back rather than stringifying non-strings. */
export function paramString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * A single upcoming/active event, as returned by {@link PlatformAdapter.listUpcomingEvents}
 * (issue #388, the read counterpart to `create_event`/#230). Deliberately
 * excludes any creator/organizer id or other member identifier — nothing
 * about *who* created the event is needed to answer "what's coming up?".
 * `id` IS included (issue #424) — it's the event's own identity, not a
 * member identifier, and `cancel_event` has no other conversational path to
 * discover a valid id to act on.
 */
export interface UpcomingEvent {
  id: string;
  name: string;
  /** ISO 8601 instant. */
  scheduledStartAt: string;
  /** ISO 8601 instant, when the event has one. */
  scheduledEndAt?: string;
  location: string;
  description?: string;
}

/**
 * A single scheduled event looked up by id, as returned by
 * {@link PlatformAdapter.getScheduledEvent} (issue #424, `cancel_event`'s
 * pre-CONFIRM target validation). Deliberately minimal — just enough for the
 * tool to refuse cleanly and quote the artifact in its CONFIRM prompt.
 */
export interface ScheduledEventLookup {
  name: string;
  status: 'scheduled' | 'active' | 'completed' | 'canceled';
  /** ISO 8601 instant. */
  scheduledStartAt: string;
}

export interface PlatformAdapter {
  readonly platform: Platform;

  /** Connect and begin receiving messages. Resolves once ready. */
  start(): Promise<void>;

  /** Gracefully disconnect. */
  stop(): Promise<void>;

  /**
   * True if the platform connection is currently live. Backs the /healthz
   * endpoint and sustained-disconnect alerting — steady-state signal, not a
   * one-shot startup check. Webhook-driven adapters (no persistent
   * connection to track) may always return true; document why in the
   * implementation.
   */
  isConnected(): boolean;

  /** Register the handler invoked for every incoming message. */
  onMessage(handler: MessageHandler): void;

  /**
   * Send a text reply to a conversation. Returns the platform-native message
   * id(s) of the sent reply when the platform can report them (issue #575,
   * the auto-retraction feature) — `undefined` when it genuinely can't (e.g.
   * WhatsApp Cloud). Adapters that chunk a long reply into multiple platform
   * messages return EVERY chunk's id, in send order, so a retraction can
   * delete all of them rather than just the last one.
   */
  sendMessage(out: OutgoingMessage): Promise<string[] | undefined>;

  /**
   * Best-effort "processing…" signal while an agent turn is in flight. Never
   * throws — the router treats this as fire-and-forget and swallows any
   * failure, since a slow or failed indicator must never delay or break the
   * actual reply. Optional: adapters with no native presence primitive simply
   * omit it.
   */
  sendTypingIndicator?(message: IncomingMessage): Promise<void>;

  /** Send a 1:1 message to a user (used for warnings and super-admin alerts). */
  sendDirectMessage(userId: string, text: string): Promise<void>;

  /**
   * Queue `message` for delivery to `userId` once a platform-specific
   * delivery window reopens (issue #602) — the WhatsApp Cloud adapter's
   * recovery path for a `sendDirectMessage` rejected because that recipient's
   * 24h customer-service window is closed (a `WindowClosedError`, distinct
   * from a genuine send failure). Optional: only `WhatsAppCloudAdapter`
   * implements it, since Discord and Baileys have no such window and simply
   * omit the method — callers must feature-check before use, same convention
   * as `sendImage?`/`reactToMessage?`/`canPostTo?`.
   *
   * `priority` is the trust level of the alert's PRODUCER, structurally the
   * same `'system' | 'low'` union as `pendingAlertQueue.ts`'s `AlertPriority`
   * (kept inline here so types.ts stays dependency-free — see the note above
   * `Role`). It drives per-recipient eviction exactly as the shared
   * pending-alert queue does (#545): a member-reachable `'low'` alert
   * (`report_content`/`appeal_moderation`) can never evict a `'system'` one
   * (admin-action audit / escalation).
   */
  queueForWindowReopen?(userId: string, message: string, priority: 'system' | 'low'): void;

  /**
   * Create a thread anchored to `messageId` in `conversationId` and return
   * the new thread's id, so the router's auto-answer mode (issue #477) can
   * contain its reply in a thread on the originating post rather than
   * answering bare in the channel. `name` is bot-composed from member text
   * (a truncated echo of the question) and MUST be run through the same
   * outbound filter (secret redaction) as any other bot-authored text before
   * it reaches the platform. Optional — only Discord implements it (this
   * feature is Discord-only); other adapters simply omit it, mirroring
   * `sendImage?`/`reactToMessage?`/`canPostTo?`'s convention.
   */
  startAutoAnswerThread?(conversationId: string, messageId: string, name: string): Promise<string>;

  /**
   * Post an image attachment to a conversation. Optional — adapters with no
   * media send path (e.g. webhook-only) omit it, and callers must feature-check
   * before use.
   */
  sendImage?(
    conversationId: string,
    image: { data: Buffer; filename: string; mimeType: string },
    caption?: string,
  ): Promise<void>;

  /**
   * React to an existing message with an emoji (issue #231; WhatsApp/Baileys
   * support added in #494). Optional — adapters with no reaction primitive
   * (`WhatsAppCloudAdapter`, pending its own 24h-window/template scoping pass)
   * omit it, and callers must feature-check before use. `emoji` is always one
   * of a small closed allowlist enforced by the caller (`react_to_message`),
   * never a model-supplied free-form string reaching the adapter.
   */
  reactToMessage?(conversationId: string, messageId: string, emoji: string): Promise<void>;

  /**
   * True if the platform adapter can actually post into this conversation
   * right now, independent of whether the bot has recorded any prior chatter
   * there (issue #270). Optional — a fallback used only when the caller's
   * primary "has the bot seen this" check (`isKnownConversation`) already
   * said no, so an admin isn't wrongly refused on a real, reachable channel
   * (e.g. brand-new or quiet). Implement this ONLY where "reachable" can be
   * verified independently of recorded chatter and where doing so can't
   * widen reachability beyond the platform's natural boundary — Discord can
   * reach only channels in its configured guild, so a per-channel fetch plus
   * guild check is safe; WhatsApp has no such boundary (any phone number is
   * dialable), so neither WhatsApp adapter implements this and
   * `isKnownConversation` alone continues to gate it there.
   */
  canPostTo?(conversationId: string): Promise<boolean>;

  /**
   * Conversation ids the given user actually participates in right now
   * (Discord: channels their permissions let them view; WhatsApp: groups
   * they are a member of plus their own DM). Backs admin data scoping.
   * Implementations cache briefly (~60s) to avoid hammering platform APIs.
   */
  conversationsForUser(userId: string): Promise<string[]>;

  /**
   * Upcoming/active events (created via `create_event`/#230), earliest-first,
   * capped at `limit`. Optional — adapters with no scheduled-events primitive
   * (both WhatsApp adapters) simply omit it, and callers must feature-check
   * before use, same convention as `sendImage?`/`reactToMessage?`/
   * `canPostTo?`. Implementations cache briefly (~60s) to avoid hammering
   * platform APIs, same convention as `conversationsForUser`.
   */
  listUpcomingEvents?(limit: number): Promise<UpcomingEvent[]>;

  /**
   * Look up a single scheduled event live by id, for `cancel_event`'s
   * pre-CONFIRM target validation (issue #424) — scheduled events aren't
   * tracked in `interactions`, so unlike `isKnownConversation`/
   * `isKnownMessage` this is sourced live from the platform API rather than
   * the DB. Returns `null` for an unknown id or one belonging to a different
   * guild (never throws for "not found"), so a hallucinated/foreign
   * `eventId` is refused before any pending action is registered. Optional —
   * adapters with no scheduled-events primitive (both WhatsApp adapters)
   * simply omit it, same convention as `listUpcomingEvents?`.
   */
  getScheduledEvent?(eventId: string): Promise<ScheduledEventLookup | null>;

  /** Capabilities this adapter supports for {@link performAdminAction}. */
  readonly adminCapabilities: ReadonlySet<string>;

  /** Perform a privileged moderation/management action. */
  performAdminAction(action: AdminAction): Promise<string>;

  /**
   * Retract (delete/revoke) a message this bot itself sent — the mechanism
   * behind auto-retracting a reply when the member deletes the message it
   * answered (issue #575). Distinct from `performAdminAction('delete_message')`:
   * that's a privileged, CONFIRM-adjacent tool a human/model invokes against
   * ANY message; this is server-side plumbing reacting to a native platform
   * delete/revoke event, always targeting the bot's OWN prior send, never
   * reachable from a chat command or the model. Optional — WhatsApp Cloud has
   * no message-deletion/unsend endpoint at all (mirrors its existing
   * `delete_message` capability gap), so it omits this and the router treats
   * the absence as a no-op, same convention as `reactToMessage?`/`sendImage?`.
   */
  deleteOwnMessage?(conversationId: string, messageId: string): Promise<void>;
}
