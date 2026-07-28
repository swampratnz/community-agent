import type { PoolClient } from 'pg';
import type { Platform } from '../../platforms/types.js';
import { pool } from '../db.js';
import { recordAdminAction } from './adminAudit.js';
import type { Queryable } from './shared.js';

/**
 * Membership and identity: the three-tier RBAC rows in `community_users`, the
 * auto-enrol path, and cross-platform identity linking (a person with both a
 * Discord and a WhatsApp id).
 *
 * These two sections move together deliberately: the private
 * `dissolveGroupIfUnderTwo` helper is defined in the membership half and called
 * from the linking half, so splitting them would force a shared-internals
 * export for a helper that is nobody else's business.
 *
 * Roles here are the source of truth the RBAC layer reads (src/auth/) — they
 * come from this table plus env, never from message content.
 *
 * Extracted verbatim from repository.ts (see its header for why the split
 * exists); `repository.ts` re-exports everything here, so every existing import
 * site is unchanged.
 */

// --- Membership (three-tier RBAC) -------------------------------------------

export type StoredRole = 'admin' | 'member';

export async function getMemberRole(platform: Platform, userId: string): Promise<StoredRole | null> {
  const { rows } = await pool.query(
    `SELECT role FROM community_users WHERE platform = $1 AND platform_user_id = $2`,
    [platform, userId],
  );
  const role = rows[0]?.role;
  return role === 'admin' || role === 'member' ? role : null;
}

/**
 * Best-known human-readable name for a platform user — the membership row's
 * display name first, then the server roster — so tool replies can name the
 * member instead of echoing a raw platform id. Returns null when nothing is
 * stored (the caller decides on a fallback).
 */
export async function resolveDisplayName(platform: Platform, userId: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT display_name FROM (
       SELECT display_name, 0 AS pref FROM community_users
         WHERE platform = $1 AND platform_user_id = $2
       UNION ALL
       SELECT display_name, 1 AS pref FROM server_roster
         WHERE platform = $1 AND user_id = $2
     ) names
     WHERE display_name IS NOT NULL AND display_name <> ''
     ORDER BY pref
     LIMIT 1`,
    [platform, userId],
  );
  return rows[0]?.display_name ?? null;
}

/**
 * Upsert a membership grant. Never downgrades: adding an existing admin as a
 * member keeps them admin (downgrades go through revoke_admin explicitly).
 */
export async function upsertMember(
  input: {
    platform: Platform;
    userId: string;
    role: StoredRole;
    addedBy: string;
    displayName?: string;
  },
  db: Queryable = pool,
): Promise<StoredRole> {
  const { rows } = await db.query(
    `INSERT INTO community_users (platform, platform_user_id, display_name, role, added_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (platform, platform_user_id)
     DO UPDATE SET
       role = CASE
         WHEN community_users.role = 'admin' AND EXCLUDED.role = 'member'
         THEN community_users.role ELSE EXCLUDED.role END,
       display_name = COALESCE(EXCLUDED.display_name, community_users.display_name)
     RETURNING role`,
    [input.platform, input.userId, input.displayName ?? null, input.role, input.addedBy],
  );
  return rows[0].role as StoredRole;
}

/**
 * Sentinel `actor_user_id`/`added_by` for an opt-in auto-enroll write (issue
 * #605), so its `admin_audit` row is distinguishable from a human `add_member`
 * grant. Owned here — the single source of truth shared by the write
 * (`autoEnrollMemberWithAudit`) and the `adminActivitySummary` rollup that
 * excludes it — so the exclusion filter can never drift from the value written.
 */
export const AUTO_ENROLL_ACTOR = 'system:discord_auto_enroll';

/**
 * Auto-enroll a joiner (issue #605, `DISCORD_AUTO_ENROLL_MEMBERS`) and write its
 * `admin_audit` row in ONE transaction, so the "every auto-enrollment is
 * traceable, never silent" invariant is structural rather than best-effort: the
 * member grant and the audit row commit together or not at all. Without the
 * transaction the two writes were independent, so an audit-insert failure after
 * a successful grant left a member with standing access and no audit trail (the
 * PR-review finding on #606). Reuses `upsertMember`'s no-downgrade `ON CONFLICT`
 * `CASE` (a rejoining admin keeps `admin`) and `recordAdminAction`'s insert via
 * the shared transaction client, so there's a single source of truth for both
 * statements. Returns the resulting role.
 */
export async function autoEnrollMemberWithAudit(input: {
  platform: Platform;
  userId: string;
  displayName?: string;
}): Promise<StoredRole> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const role = await upsertMember(
      {
        platform: input.platform,
        userId: input.userId,
        role: 'member',
        addedBy: AUTO_ENROLL_ACTOR,
        displayName: input.displayName,
      },
      client,
    );
    await recordAdminAction(
      {
        platform: input.platform,
        actorUserId: AUTO_ENROLL_ACTOR,
        actorName: 'system',
        actionKind: 'auto_enroll_member',
        targetUserId: input.userId,
        params: { role: 'member', addedBy: AUTO_ENROLL_ACTOR },
        result: `registered as ${role}`,
        success: true,
      },
      client,
    );
    await client.query('COMMIT');
    return role;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Explicit downgrade of an admin to member. Returns false if not an admin. */
export async function demoteAdmin(platform: Platform, userId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE community_users SET role = 'member'
      WHERE platform = $1 AND platform_user_id = $2 AND role = 'admin'`,
    [platform, userId],
  );
  return (rowCount ?? 0) > 0;
}

export interface AdminIdentity {
  platform: Platform;
  platformUserId: string;
}

/**
 * All admin-tier identities (`community_users.role = 'admin'`), for the
 * weekly admin digest (issue #97) to enumerate recipients. Super admins are
 * env-sourced (`superAdminIds`) and deliberately excluded here — they keep
 * the on-demand, all-conversation-scoped `question_digest` tool instead of
 * this per-admin scoped push.
 */
export async function listAdmins(): Promise<AdminIdentity[]> {
  const { rows } = await pool.query(
    `SELECT platform, platform_user_id FROM community_users WHERE role = 'admin'`,
  );
  return rows.map((r) => ({
    platform: r.platform as Platform,
    platformUserId: r.platform_user_id as string,
  }));
}

/**
 * Resolved display names of every `role = 'admin'` community_users row for a
 * platform (issue #360) — the same community_users→server_roster
 * name-resolution precedence as `resolveDisplayName`, applied across every
 * admin row instead of one caller. An admin with no resolvable name anywhere
 * (neither table has a non-empty display_name) is omitted entirely, never
 * rendered as a blank/empty name. Deterministically ordered by
 * `community_users.id` so repeat calls (and the gated notice built from
 * them) are stable. Env-sourced super admins are never in `community_users`,
 * so — like `listAdmins()` above — they are excluded here for the same
 * reason: they're operator-level, not a member's first point of contact.
 * Query is parameterised on `platform` alone; nothing here is influenced by
 * caller-supplied message content.
 */
export async function listAdminDisplayNames(platform: Platform): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT COALESCE(NULLIF(cu.display_name, ''), NULLIF(sr.display_name, '')) AS display_name
       FROM community_users cu
       LEFT JOIN server_roster sr ON sr.platform = cu.platform AND sr.user_id = cu.platform_user_id
      WHERE cu.platform = $1 AND cu.role = 'admin'
      ORDER BY cu.id ASC`,
    [platform],
  );
  return rows
    .map((r) => r.display_name as string | null)
    .filter((name): name is string => name != null && name.trim() !== '');
}

export interface AdminRosterEntry {
  platform: Platform;
  platformUserId: string;
  displayName: string | null;
  leftServer: boolean;
}

/**
 * Every `role = 'admin'` community_users row across both platforms, for the
 * `list_admins` super-admin tool (issue #428) to answer "who currently holds
 * bot-admin privilege?" as a direct query instead of a mental replay of
 * `audit_view`'s grant/revoke log. Reuses the exact community_users→
 * server_roster display-name precedence `listAdminDisplayNames` already
 * uses. `leftServer` is `true` only when a matching `server_roster` row has
 * `left_at IS NOT NULL`; a missing roster row (never seen leaving) or one
 * with `left_at IS NULL` both read as "not known to have left" — this is
 * the signal that surfaces a departed-but-still-admin account
 * (`onGuildMemberRemove` clears roster/membership state but never touches
 * `community_users.role`). Deterministically ordered by `community_users.id`
 * like `listAdminDisplayNames`. Env-sourced super admins are never rows in
 * `community_users`, so — like `listAdmins`/`listAdminDisplayNames` — they
 * are excluded here too.
 */
export async function listAdminRoster(): Promise<AdminRosterEntry[]> {
  const { rows } = await pool.query(
    `SELECT cu.platform, cu.platform_user_id,
            COALESCE(NULLIF(cu.display_name, ''), NULLIF(sr.display_name, '')) AS display_name,
            sr.left_at IS NOT NULL AS left_server
       FROM community_users cu
       LEFT JOIN server_roster sr ON sr.platform = cu.platform AND sr.user_id = cu.platform_user_id
      WHERE cu.role = 'admin'
      ORDER BY cu.id ASC`,
  );
  return rows.map((r) => ({
    platform: r.platform as Platform,
    platformUserId: r.platform_user_id as string,
    displayName: r.display_name as string | null,
    leftServer: r.left_server as boolean,
  }));
}

/** Remove a member row entirely. Refuses to remove admins (revoke first). */
/**
 * If a person group is left with fewer than two members, dissolve it: clear
 * any straggler's person_id and delete the persons row. Keeps the "no
 * singleton groups, no orphaned persons rows" invariant. Must run inside the
 * caller's open transaction.
 */
async function dissolveGroupIfUnderTwo(client: PoolClient, personId: number): Promise<void> {
  const { rows } = await client.query(`SELECT count(*) AS n FROM community_users WHERE person_id = $1`, [
    personId,
  ]);
  if (Number(rows[0].n) <= 1) {
    await client.query(`UPDATE community_users SET person_id = NULL WHERE person_id = $1`, [personId]);
    await client.query(`DELETE FROM persons WHERE id = $1`, [personId]);
  }
}

/**
 * Remove a member row. If the member was linked, dissolve a person group this
 * would leave with a single member — the same invariant `unlinkMember`
 * protects, so hard-removing a linked member never orphans a persons row or
 * leaves a co-member "still linked" to a now-empty group.
 */
export async function removeMember(platform: Platform, userId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT person_id FROM community_users
        WHERE platform = $1 AND platform_user_id = $2 AND role = 'member' FOR UPDATE`,
      [platform, userId],
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      `DELETE FROM community_users WHERE platform = $1 AND platform_user_id = $2 AND role = 'member'`,
      [platform, userId],
    );
    if (rows[0].person_id) await dissolveGroupIfUnderTwo(client, Number(rows[0].person_id));
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// --- Cross-platform identity linking ----------------------------------------

export interface PersonIdentity {
  platform: Platform;
  userId: string;
}

/**
 * All platform identities that are the same person as (platform, userId),
 * including itself. Unlinked users (person_id NULL, or no community_users
 * row at all) resolve to just themselves — callers never need to special-case
 * "not linked". This is the one place forget_me/purge and the reply budget
 * consult to decide whether to aggregate across identities.
 */
export async function resolveLinkedIdentities(platform: Platform, userId: string): Promise<PersonIdentity[]> {
  const { rows } = await pool.query(
    `SELECT platform, platform_user_id FROM community_users
      WHERE person_id = (
        SELECT person_id FROM community_users WHERE platform = $1 AND platform_user_id = $2
      )`,
    [platform, userId],
  );
  if (rows.length === 0) return [{ platform, userId }];
  return rows.map((r) => ({ platform: r.platform as Platform, userId: r.platform_user_id as string }));
}

/**
 * Link two platform identities as the same human. Both must already be known
 * community members (a community_users row exists) — this is a data-hygiene
 * link over verified members, not a way to grant membership. NEVER touches
 * `role`: tier stays per-platform-row by design, so linking a member to an
 * admin can never make the member resolve as admin (see docs/SECURITY.md).
 *
 * Idempotent: linking two identities already in the same group is a no-op
 * success. Linking across two existing (different) groups merges them. The
 * two named rows are locked FOR UPDATE; a concurrent link/unlink touching an
 * *unlocked* co-member of a merging group may deadlock, in which case Postgres
 * aborts one side and this rolls back cleanly (no partial merge) — safe, but
 * the loser sees a DB error rather than a serialized success. These are
 * admin-tier, CONFIRM-gated actions, so real contention is negligible.
 */
export async function linkMembers(
  platformA: Platform,
  userA: string,
  platformB: Platform,
  userB: string,
): Promise<{ personId: number }> {
  if (platformA === platformB && userA === userB) {
    throw new Error('Cannot link an identity to itself.');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT platform, platform_user_id, person_id FROM community_users
        WHERE (platform = $1 AND platform_user_id = $2) OR (platform = $3 AND platform_user_id = $4)
        FOR UPDATE`,
      [platformA, userA, platformB, userB],
    );
    const rowA = rows.find((r) => r.platform === platformA && r.platform_user_id === userA);
    const rowB = rows.find((r) => r.platform === platformB && r.platform_user_id === userB);
    if (!rowA || !rowB) {
      throw new Error('Both identities must already be known community members.');
    }

    let personId: number;
    if (rowA.person_id && rowB.person_id) {
      const keep = Math.min(Number(rowA.person_id), Number(rowB.person_id));
      const drop = Math.max(Number(rowA.person_id), Number(rowB.person_id));
      if (keep !== drop) {
        await client.query(`UPDATE community_users SET person_id = $1 WHERE person_id = $2`, [keep, drop]);
        await client.query(`DELETE FROM persons WHERE id = $1`, [drop]);
      }
      personId = keep;
    } else if (rowA.person_id || rowB.person_id) {
      personId = Number(rowA.person_id ?? rowB.person_id);
      const unlinkedIsA = !rowA.person_id;
      await client.query(
        `UPDATE community_users SET person_id = $1 WHERE platform = $2 AND platform_user_id = $3`,
        [personId, unlinkedIsA ? platformA : platformB, unlinkedIsA ? userA : userB],
      );
    } else {
      const created = await client.query(`INSERT INTO persons DEFAULT VALUES RETURNING id`);
      personId = Number(created.rows[0].id);
      await client.query(
        `UPDATE community_users SET person_id = $1
          WHERE (platform = $2 AND platform_user_id = $3) OR (platform = $4 AND platform_user_id = $5)`,
        [personId, platformA, userA, platformB, userB],
      );
    }
    await client.query('COMMIT');
    return { personId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Remove one identity from its person group. If the group would be left with
 * fewer than two members, it's dissolved entirely (every remaining member's
 * person_id cleared, the persons row deleted) rather than left as a
 * one-member group — so no identity can be silently "still linked" to a
 * now-empty group and no persons row dangles for a future link to reattach
 * to unexpectedly. Returns false if the identity wasn't linked to anyone.
 */
export async function unlinkMember(platform: Platform, userId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT person_id FROM community_users WHERE platform = $1 AND platform_user_id = $2 FOR UPDATE`,
      [platform, userId],
    );
    const personId = rows[0]?.person_id;
    if (!personId) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      `UPDATE community_users SET person_id = NULL WHERE platform = $1 AND platform_user_id = $2`,
      [platform, userId],
    );
    await dissolveGroupIfUnderTwo(client, Number(personId));
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
