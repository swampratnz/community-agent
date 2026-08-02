import type { AdapterLookup, Platform, PlatformAdapter } from '../../platforms/types.js';
import { assertAtLeast } from '../../auth/tiers.js';
import type { CallerContext } from '../../auth/rbac.js';
import { normalizeMemberId, resolveWhatsappLid } from '../../auth/memberId.js';
import { logger, hashId } from '../../logger.js';
import { getLanguagePreference, phoneForLid, recordAdminAction } from '../../storage/repository.js';
import { registerPendingAction } from '../pendingActions.js';
import { text } from './helpers.js';
import { notifySuperAdmins } from './notify.js';
import type { ToolContext } from './types.js';
import type { ToolServerTurnState } from '../tools.js';

/**
 * Build the per-turn `ToolContext` kernel (docs/TOOL-REGISTRY-DESIGN.md §2):
 * the five helper closures `buildToolServer` used to define inline, moved
 * here verbatim and still capturing `caller`/`adapter` — now as parameters.
 * `buildToolServer` destructures these back into its own scope so the
 * remaining unconverted closure tools compile unchanged, and registry tool
 * handlers receive the whole context as their second parameter.
 */
export function makeToolContext(
  caller: CallerContext,
  adapter: PlatformAdapter,
  getAdapter?: AdapterLookup,
  turnState?: ToolServerTurnState,
  getLangPref: typeof getLanguagePreference = getLanguagePreference,
): ToolContext {
  /**
   * Resolves the adapter to notify through for a row stored under
   * `rowPlatform`: the current turn's own adapter when it matches, otherwise
   * a lookup through `getAdapter` (issue #157) — undefined if that platform
   * isn't registered in this deployment, which callers treat as today's
   * silent skip.
   */
  function adapterFor(rowPlatform: Platform): PlatformAdapter | undefined {
    return rowPlatform === caller.platform ? adapter : getAdapter?.(rowPlatform);
  }

  /**
   * Conversations the caller may reach with privileged/data tools.
   * null = unrestricted (super admin). For admins this is their real,
   * platform-verified membership plus the current conversation.
   */
  async function callerScope(): Promise<string[] | null> {
    if (caller.role === 'super_admin') return null;
    const ids = await adapter.conversationsForUser(caller.userId);
    return [...new Set([...ids, caller.conversationId])];
  }

  async function audited(input: {
    actionKind: string;
    targetUserId?: string;
    conversationId?: string;
    params?: Record<string, unknown>;
    run: () => Promise<string>;
  }): Promise<{ success: boolean; result: string }> {
    let success = false;
    let result: string;
    try {
      result = await input.run();
      success = true;
    } catch (err) {
      result = err instanceof Error ? err.message : String(err);
    }
    await recordAdminAction({
      platform: caller.platform,
      actorUserId: caller.userId,
      actorName: caller.userName,
      actionKind: input.actionKind,
      targetUserId: input.targetUserId,
      conversationId: input.conversationId,
      params: input.params ?? {},
      result,
      success,
    }).catch((err) => logger.error({ err }, 'Audit write failed'));
    if (success) {
      void notifySuperAdmins(
        adapterFor,
        `${caller.userName} (${caller.role}) ran ${input.actionKind}${input.targetUserId ? ` on ${input.targetUserId}` : ''}: ${result}`,
        caller.userId,
        // 'system': a privileged-action audit is bot-originated, never
        // member-reachable — it must never be evicted by a member's queued
        // report/appeal for the same window-closed super-admin (#545).
        'system',
      );
    }
    logger.info({ action: input.actionKind, success, actor: hashId(caller.userId) }, 'Privileged action');
    return { success, result };
  }

  /**
   * Queue a destructive action behind an out-of-band CONFIRM reply.
   * minTier is re-checked at confirm time (auth/roles re-resolved by the
   * router), so a role revoked inside the TTL invalidates the action.
   */
  function requireConfirm(
    description: string,
    minTier: 'guest' | 'member' | 'admin' | 'super_admin',
    run: () => Promise<string>,
  ) {
    // The router deterministically re-emits this description as the
    // authoritative `⚠️ Pending:` notice (router.ts, PENDING_NOTICE)
    // *because* the model composes it and the model is untrusted. Individual
    // callers already sanitize resolved display names (resolveSanitizedLabel,
    // #227/M3), but several tools interpolate raw model-supplied free text
    // (moderate's `reason`, create_event's `name`/`location`, suggest_issue's
    // `title`, forget_me's caller name) straight into `description`. A planted
    // newline there forges a second line in that trusted single-line notice —
    // the exact quarantine-escape class delete_message strips inline. Strip it
    // ONCE here so every current and future call site is covered; angle
    // brackets go too so nothing can fake a tag. Quotes are left intact:
    // legitimate labels use them (create event "Movie Night") and they cannot
    // break out of a single line.
    const safeDescription = description.replace(/[<>\r\n\u2028\u2029\u0085]/g, ' ');
    registerPendingAction(caller.platform, caller.conversationId, caller.userId, {
      description: safeDescription,
      minTier,
      execute: run,
    });
    return text(
      `⚠️ Pending: ${safeDescription}\nReply CONFIRM within 60 seconds to proceed, or CANCEL to abort. ` +
        `(Confirmation is handled outside the AI and must come from you in this conversation.)`,
    );
  }

  /**
   * Resolve + validate the target of a membership tool. The platform defaults
   * to the caller's; managing a user on a *different* platform is broader
   * authority, so it requires super_admin. The id is shape-checked per platform
   * so a WhatsApp number can't be silently filed as a Discord user (issue #78).
   */
  async function resolveMemberTarget(
    rawUserId: string,
    platformArg?: Platform,
  ): Promise<{ platform: Platform; userId: string }> {
    const platform = platformArg ?? caller.platform;
    if (platform !== caller.platform) {
      assertAtLeast(caller.role, 'super_admin', `managing a ${platform} user from ${caller.platform}`);
    }

    // A WhatsApp LID is the one id that LOOKS valid and is silently useless:
    // it is digits, so it reads as a phone number, but nothing ever matches it
    // because inbound messages always resolve LID -> phone (docs/SECURITY.md
    // §6b — four phantom members were created this way). LIDs are the only ids
    // group metadata and `list_roster` expose, so an admin or the model
    // genuinely cannot tell them apart by eye.
    //
    // If we have LEARNED this LID's phone number from a real message envelope,
    // resolve it rather than refusing: the mapping came from `senderPn`, so it
    // is authoritative, and refusing something we can answer is just friction.
    // No mapping (the person has never posted where the bot could see) falls
    // through to normalizeMemberId's error, which explains the LID problem and
    // asks for the number.
    if (platform === 'whatsapp') {
      const resolved = await resolveWhatsappLid(rawUserId, phoneForLid);
      if (resolved) {
        logger.info(
          { lid: hashId(rawUserId.trim()), phone: hashId(resolved) },
          'Resolved a WhatsApp LID to its learned phone number for a membership action',
        );
        return { platform, userId: resolved };
      }
    }

    return { platform, userId: normalizeMemberId(platform, rawUserId) };
  }

  return {
    caller,
    adapter,
    getAdapter,
    turnState,
    getLangPref,
    adapterFor,
    callerScope,
    audited,
    requireConfirm,
    resolveMemberTarget,
  };
}
