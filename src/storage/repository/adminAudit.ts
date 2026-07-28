import type { Platform } from '../../platforms/types.js';
import { pool } from '../db.js';
import type { Queryable } from './shared.js';

/**
 * The `admin_audit` trail: every privileged action the bot performs is recorded
 * here, including the auto-enrol sentinel actor. Accepts an optional Queryable
 * so a caller inside a transaction records its audit row atomically with the
 * change it describes.
 *
 * Extracted verbatim from repository.ts (see its header for why the split
 * exists); `repository.ts` re-exports everything here, so every existing import
 * site is unchanged.
 */

// --- Admin audit -----------------------------------------------------------

export async function recordAdminAction(
  input: {
    platform: Platform;
    actorUserId: string;
    actorName?: string;
    actionKind: string;
    targetUserId?: string;
    conversationId?: string;
    params?: Record<string, unknown>;
    result?: string;
    success: boolean;
  },
  db: Queryable = pool,
): Promise<void> {
  await db.query(
    `INSERT INTO admin_audit
       (platform, actor_user_id, actor_name, action_kind, target_user_id,
        conversation_id, params, result, success)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      input.platform,
      input.actorUserId,
      input.actorName ?? null,
      input.actionKind,
      input.targetUserId ?? null,
      input.conversationId ?? null,
      JSON.stringify(input.params ?? {}),
      input.result ?? null,
      input.success,
    ],
  );
}
