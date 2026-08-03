import type { Platform, Tier } from '../platforms/types.js';

/**
 * Confirm-before-destructive flow.
 *
 * Destructive tools (kick, timeout, delete, purge, grant_admin, forget_me) do
 * not execute directly. They register a pending action and tell the requester
 * to reply CONFIRM. The router intercepts that reply and runs the stored
 * executor DETERMINISTICALLY — the confirmation never passes through the
 * model, so a prompt injection can request an action but can never complete
 * it: the CONFIRM must arrive as a fresh platform message from the same
 * person in the same conversation, and their tier is re-resolved at confirm
 * time (a role revoked inside the TTL invalidates the pending action).
 */

export interface PendingAction {
  description: string;
  /** Minimum tier the actor must STILL hold when confirming. */
  minTier: Tier;
  expiresAt: number;
  execute: () => Promise<string>;
}

export const CONFIRM_TTL_MS = 60_000;

const pending = new Map<string, PendingAction>();

function key(platform: Platform, conversationId: string, actorUserId: string): string {
  return `${platform}:${conversationId}:${actorUserId}`;
}

/** Register (replacing any previous pending action for this actor+conversation). */
export function registerPendingAction(
  platform: Platform,
  conversationId: string,
  actorUserId: string,
  action: Omit<PendingAction, 'expiresAt'>,
): void {
  pending.set(key(platform, conversationId, actorUserId), {
    ...action,
    expiresAt: Date.now() + CONFIRM_TTL_MS,
  });
}

/** Take (and remove) the actor's pending action if one exists and is fresh. */
export function takePendingAction(
  platform: Platform,
  conversationId: string,
  actorUserId: string,
): PendingAction | null {
  const k = key(platform, conversationId, actorUserId);
  const entry = pending.get(k);
  if (!entry) return null;
  pending.delete(k);
  if (entry.expiresAt < Date.now()) return null;
  return entry;
}

export function cancelPendingAction(
  platform: Platform,
  conversationId: string,
  actorUserId: string,
): boolean {
  return pending.delete(key(platform, conversationId, actorUserId));
}

export function hasPendingAction(platform: Platform, conversationId: string, actorUserId: string): boolean {
  const entry = pending.get(key(platform, conversationId, actorUserId));
  return !!entry && entry.expiresAt >= Date.now();
}

/**
 * Read (without removing) the actor's current fresh pending action, or null.
 * Lets the router deterministically surface the REAL pending description to
 * the human after a turn — the tool result that requireConfirm returns is
 * composed into the final reply by the model, so an injected turn could
 * register `grant_admin` as pending and then tell the user "reply CONFIRM to
 * refresh my cache," hiding the warning. The router uses this to emit the
 * authoritative `⚠️ Pending: <description>` itself.
 */
export function peekPendingAction(
  platform: Platform,
  conversationId: string,
  actorUserId: string,
): PendingAction | null {
  const entry = pending.get(key(platform, conversationId, actorUserId));
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry;
}

/** Drop expired entries so abandoned pendings don't accumulate. */
export function sweepExpiredPendingActions(): void {
  const now = Date.now();
  for (const [k, entry] of pending) {
    if (entry.expiresAt < now) pending.delete(k);
  }
}

/**
 * Message-text classifier for the router intercept. Tolerates leading
 * @-mention tokens ("@6421… CONFIRM" in WhatsApp groups, stray mentions on
 * Discord) so confirmations work in group chats where addressing the bot is
 * required to type at it.
 */
export function classifyConfirmReply(text: string): 'confirm' | 'cancel' | null {
  const t = text
    .trim()
    .replace(/^(@\S+\s+)+/, '')
    .trim()
    .toLowerCase();
  if (t === 'confirm' || t === 'yes confirm') return 'confirm';
  if (t === 'cancel') return 'cancel';
  return null;
}
