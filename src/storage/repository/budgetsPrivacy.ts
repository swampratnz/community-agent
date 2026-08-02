import type { Platform } from '../../platforms/types.js';
import { pool } from '../db.js';
import { runInteractionsInvalidated, runPurgeContributors, runPurgeSummaries } from '../lifecycle.js';
import { resolveLinkedIdentities } from './members.js';
import { getResponseStyle, type ResponseStyle } from './preferences.js';

/**
 * Reply budgets, retention purges and the member-facing privacy surface
 * (my_data, forget_me, purge_user_data). Owns the deletion-coherence rules that
 * make a purge actually erase a member's footprint, digests included.
 *
 * Extracted verbatim from repository.ts (see its header for why the split
 * exists); `repository.ts` re-exports everything here, so every existing import
 * site is unchanged.
 */

// --- Budgets / privacy --------------------------------------------------------

/**
 * Agent replies sent to this user in the last `sinceHours` hours, aggregated
 * across every identity linked to them via `link_member` (so the daily reply
 * budget can't be double-dipped by messaging from a linked Discord account
 * and WhatsApp number instead of one).
 */
export async function countRepliesToUser(
  platform: Platform,
  userId: string,
  sinceHours = 24,
): Promise<number> {
  const identities = await resolveLinkedIdentities(platform, userId);
  const params: unknown[] = [String(sinceHours)];
  const conditions = identities.map((id) => {
    params.push(id.platform, id.userId);
    return `(platform = $${params.length - 1} AND meta->>'replyToUserId' = $${params.length})`;
  });
  const { rows } = await pool.query(
    `SELECT count(*) AS n FROM interactions
      WHERE direction = 'outbound'
        AND created_at > now() - ($1 || ' hours')::interval
        AND (${conditions.join(' OR ')})`,
    params,
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Delete one identity's stored data — the single-identity core of
 * `purgeUserData`. Runs every delete inside ONE transaction (issue: a crash
 * partway used to leave, e.g., digests alive over already-deleted interactions
 * that a retry could never re-find), mirroring the sibling `linkMembers`/
 * `unlinkMember` pattern.
 */
async function purgeSingleIdentity(platform: Platform, userId: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Clear session continuity FIRST, while the user's interactions still
    // exist for the subquery to find the conversations they were active in.
    // Without this the `sessions` row keeps mapping the conversation to a live
    // Claude transcript that still contains the purged messages, so another
    // member could ask the bot to recall them for up to
    // SESSION_MAX_TURNS/AGE_HOURS. Same primitive as `clearUserSessions`, run
    // in-transaction and before the interactions delete below.
    await client.query(
      `UPDATE sessions
          SET claude_session_id = NULL, updated_at = now()
        WHERE platform = $1
          AND claude_session_id IS NOT NULL
          AND conversation_id IN (
            SELECT DISTINCT conversation_id FROM interactions
             WHERE platform = $1 AND user_id = $2
          )`,
      [platform, userId],
    );

    const { rows: deletedInteractions } = await client.query(
      `DELETE FROM interactions
        WHERE platform = $1
          AND (user_id = $2 OR (direction = 'outbound' AND meta->>'replyToUserId' = $2))
        RETURNING id`,
      [platform, userId],
    );
    const messages = deletedInteractions.length;
    // Deletion coherence (issues #51/#102): a context digest whose summary was
    // built over any purged interaction is invalidated outright — the next
    // builder run regenerates the topic without this person's signal. Runs via
    // the interactions-invalidated hooks (storage/lifecycle.ts) — the base
    // digest sweep `invalidateDigestsForInteractions` is registered first —
    // awaited and PROPAGATING inside this transaction, so a failed
    // invalidation still aborts the purge. Shared with the delete/edit-
    // honouring path, which runs the same hooks .catch(warn)-isolated.
    const candidates = await runInteractionsInvalidated(
      deletedInteractions.map((r) => Number(r.id)),
      client,
    );
    // Every remaining per-table statement of this transaction lives with its
    // owning domain module as a registered PurgeContributor
    // (storage/lifecycle.ts), run here inside the SAME client/transaction.
    // ORDER IS PINNED: each contributor carries an explicit `order` chosen so
    // the statement sequence is exactly the sequence the old inline code ran —
    // knowledge → content_reports → server_roster → member_notes →
    // suggestions → admin_digest_sends → response_style_prefs →
    // language_prefs → member_warnings → answer_feedback → knowledge_gaps →
    // dev_team_watches → moderation_appeals → member_projects →
    // member_interests → knowledge_candidates → helper_notifications →
    // project_connection_requests → projects → whatsapp_lid_map →
    // access_requests — pinned by tests/storageLifecycle.test.ts. Each
    // contributor returns its counted deletions; the sum feeds the same
    // user-facing total as before.
    //
    // blocked_users (issue #572) deliberately has NO contributor, unlike
    // member_warnings: forget_me/purge_user_data must never be a way to route
    // around an admin's block by erasing the row that enforces it, including
    // via a linked identity (SECURITY — tests/storageLifecycle.test.ts pins
    // the registry's negative space too).
    const contributed = await runPurgeContributors({ platform, userId }, client);

    // Same rule for the project's own creator breadcrumb: the project outlives
    // its creator's erasure, unowned rather than deleted.
    //
    // These three match on the bare user id with NO platform qualifier, unlike
    // the membership/authorship deletes above, because the columns store a bare
    // `caller.userId` with no companion platform column — the repo-wide
    // convention for breadcrumb-only columns (`knowledge.created_by`,
    // `member_notes.created_by`, …). So a Discord and a WhatsApp id that happen
    // to be byte-identical would null each other's breadcrumb (PR #929 review).
    // Tolerable ONLY because these are audit breadcrumbs that grant nothing:
    // access is `project_members`, which IS platform-qualified above. Fixing it
    // properly needs a platform column on all three, which is a repo-wide
    // change, not a project-local one.
    await client.query(`UPDATE projects SET created_by = NULL WHERE created_by = $1`, [userId]);
    await client.query(`UPDATE project_members SET added_by = NULL WHERE added_by = $1`, [userId]);
    await client.query(`UPDATE project_surfaces SET bound_by = NULL WHERE bound_by = $1`, [userId]);

    await client.query('COMMIT');
    return messages + candidates + contributed;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Delete a user's stored data: their inbound messages, the bot's replies to
 * them, knowledge entries sourced from them, content reports *they
 * submitted* as reporter, their server_roster row, admin notes kept *about*
 * them (member_notes), suggestions they filed, their response-style and
 * language preferences, answer ratings *they submitted* (issue #118), any context
 * digest built over their purged interactions, any still-pending
 * knowledge_candidates drafted from an invalidated digest (issue #102), any
 * moderation appeal(s) *they filed* (issue #554), and any knowledge_candidates
 * row *they themselves suggested* via suggest_knowledge in ANY status (issue
 * #633), and any still-pending access request in their name (issue #939) —
 * across every identity linked to them via
 * `link_member` (SECURITY: this is a deliberate blast-radius expansion —
 * linking two identities means forget_me/purge from *either* now erases
 * *both*, which is why `link_member` is CONFIRM-gated, audited, and
 * super-admin-alerted; see docs/SECURITY.md). Backs both the member-facing
 * `forget_me` and the super-admin `purge_user_data`. Membership, audit rows,
 * and reports where the user is only the *target* (not the reporter) are
 * intentionally kept (accountability data — documented in SECURITY.md).
 */
export async function purgeUserData(platform: Platform, userId: string): Promise<number> {
  const identities = await resolveLinkedIdentities(platform, userId);
  let total = 0;
  for (const identity of identities) {
    total += await purgeSingleIdentity(identity.platform, identity.userId);
  }
  return total;
}

export interface MyDataSummary {
  ownMessages: number;
  repliesToThem: number;
  knowledgeEntries: number;
  reportsFiled: number;
  suggestionsFiled: number;
  projectsShared: number;
  interestsPublished: number;
  responseStyle: ResponseStyle;
}

/**
 * Read-only counterpart to `purgeSingleIdentity` — counts, rather than
 * deletes, exactly the per-table rows `forget_me`/`purge_user_data` would
 * erase for this identity (issue #188, the IPP6 access-right counterpart to
 * that deletion path), aggregated across every identity linked via
 * `link_member` the same way `purgeSingleIdentity`/`resolveLinkedIdentities`
 * already aggregate for `forget_me`. Interactions are split into the
 * caller's own messages (`user_id = $2`) and the bot's replies to them
 * (`direction = 'outbound' AND meta->>'replyToUserId' = $2`) — the same two
 * halves of `purgeSingleIdentity`'s WHERE clause, reported separately rather
 * than as one confusing lump.
 *
 * Deliberately excludes `member_notes` (issue #45: members have no
 * self-access to notes about themselves, even though `forget_me` deletes
 * them), `server_roster`, `admin_digest_sends`, `member_warnings` (already
 * self-serve via `my_warnings`), and `answer_feedback` — those stay
 * purge-only. Never add a count for any of them here to "reconcile" the
 * total with `purgeSingleIdentity`; the asymmetry is intentional.
 */
export async function getMyDataSummary(platform: Platform, userId: string): Promise<MyDataSummary> {
  const identities = await resolveLinkedIdentities(platform, userId);
  let ownMessages = 0;
  let repliesToThem = 0;
  let knowledgeEntries = 0;
  let reportsFiled = 0;
  let suggestionsFiled = 0;
  let projectsShared = 0;
  let interestsPublished = 0;
  for (const identity of identities) {
    const { rows: interactionRows } = await pool.query(
      `SELECT
         count(*) FILTER (WHERE user_id = $2) AS own_messages,
         count(*) FILTER (WHERE direction = 'outbound' AND meta->>'replyToUserId' = $2) AS replies_to_them
       FROM interactions WHERE platform = $1`,
      [identity.platform, identity.userId],
    );
    ownMessages += Number(interactionRows[0]?.own_messages ?? 0);
    repliesToThem += Number(interactionRows[0]?.replies_to_them ?? 0);

    // The per-table counts come from the SAME contributors the purge runs
    // (storage/lifecycle.ts): `summarize()` exists on exactly the tables this
    // summary has always reported — knowledge, content_reports, suggestions,
    // member_projects, member_interests — and the deliberate omissions above
    // simply register no summarize (tests/storageLifecycle.test.ts pins the
    // set), so the two surfaces can never drift apart per-table again.
    const counts = await runPurgeSummaries(identity, pool);
    knowledgeEntries += counts.knowledgeEntries ?? 0;
    reportsFiled += counts.reportsFiled ?? 0;
    suggestionsFiled += counts.suggestionsFiled ?? 0;
    projectsShared += counts.projectsShared ?? 0;
    interestsPublished += counts.interestsPublished ?? 0;
  }

  return {
    ownMessages,
    repliesToThem,
    knowledgeEntries,
    reportsFiled,
    suggestionsFiled,
    projectsShared,
    interestsPublished,
    // The standing style preference isn't purge-scope data — it's a single
    // per-identity row, so this reports the caller's own invoking identity
    // only (same scoping set_response_style itself uses), not aggregated.
    responseStyle: await getResponseStyle(platform, userId),
  };
}

/**
 * Age-based retention: delete raw `interactions` older than `days`. Never
 * touches `knowledge` (curated facts are meant to be durable), `sessions`
 * (governed separately by SESSION_MAX_TURNS/_AGE_HOURS), or `admin_audit`
 * (accountability trail, retained deliberately — see SECURITY.md). Returns
 * the number of rows deleted, for operator-visible logging.
 *
 * Deliberately does NOT run the interactions-invalidated hooks
 * (storage/lifecycle.ts) — matching its pre-registry behaviour: age-based
 * retention is not an erasure request, and context digests are the distilled
 * layer that is MEANT to outlive the raw rows it was built from. Only the
 * delete/edit honouring paths and the privacy purge demand digest coherence.
 */
export async function purgeOldInteractions(days: number): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM interactions WHERE created_at < now() - ($1::text || ' days')::interval`,
    [days],
  );
  return rowCount ?? 0;
}
