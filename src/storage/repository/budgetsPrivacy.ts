import type { Platform } from '../../platforms/types.js';
import { pool } from '../db.js';
import { invalidateDigestsForInteractions } from './shared.js';
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
    // builder run regenerates the topic without this person's signal. Shared
    // with the delete/edit-honouring path via `invalidateDigestsForInteractions`.
    const candidates = await invalidateDigestsForInteractions(
      deletedInteractions.map((r) => Number(r.id)),
      client,
    );
    // knowledge has no platform column, so this keys on source_user_id alone.
    // Safe because Discord snowflakes (17-20 digits) and WhatsApp E.164 numbers
    // (7-15 digits) can't collide as strings (enforced by normalizeMemberId), so
    // this never touches another platform's user. If that validation loosens, add
    // a platform column to knowledge and filter on it here.
    const { rowCount: knowledge } = await client.query(`DELETE FROM knowledge WHERE source_user_id = $1`, [
      userId,
    ]);
    const { rowCount: reports } = await client.query(
      `DELETE FROM content_reports WHERE platform = $1 AND reporter_user_id = $2`,
      [platform, userId],
    );
    const { rowCount: roster } = await client.query(
      `DELETE FROM server_roster WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    const { rowCount: notes } = await client.query(
      `DELETE FROM member_notes WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    const { rowCount: suggestions } = await client.query(
      `DELETE FROM suggestions WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    // admin_digest_sends (issue #97) is keyed on the same (platform, user id)
    // identity — purge coherence for an offboarded admin.
    const { rowCount: digestSends } = await client.query(
      `DELETE FROM admin_digest_sends WHERE platform = $1 AND platform_user_id = $2`,
      [platform, userId],
    );
    // response_style_prefs (issue #126) is keyed the same way — purge coherence
    // for anyone who opted into the plain-language preference.
    const { rowCount: responseStyle } = await client.query(
      `DELETE FROM response_style_prefs WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    // language_prefs (issue #189) is keyed the same way — purge coherence for
    // anyone who opted into a standing language preference.
    const { rowCount: languagePreference } = await client.query(
      `DELETE FROM language_prefs WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    // member_warnings (auto-moderation strikes) are keyed on raw (platform,
    // user_id) too — a purged user's warning history goes with them.
    const { rowCount: warnings } = await client.query(
      `DELETE FROM member_warnings WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    // blocked_users (issue #572) is DELIBERATELY NOT purged here, unlike
    // member_warnings above: forget_me/purge_user_data must never be a way to
    // route around an admin's block by erasing the row that enforces it,
    // including via a linked identity (SECURITY).
    // answer_feedback (issue #118) rows this identity submitted AS RATER go
    // with them, same as suggestions/reports above. A row where this identity
    // was only the RECIPIENT of the rated answer is not deleted here — its
    // interaction_id is nulled automatically by the interactions delete above
    // via the table's ON DELETE SET NULL foreign key, leaving the rater's own
    // helpful/unhelpful signal intact.
    const { rowCount: answerFeedback } = await client.query(
      `DELETE FROM answer_feedback WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    // knowledge_gaps (issue #208) is keyed the same way — purge coherence for
    // anyone whose below-floor searches were logged.
    const { rowCount: knowledgeGaps } = await client.query(
      `DELETE FROM knowledge_gaps WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    // dev_team_watches (super-admin dev-team dispatches) is keyed on the same
    // (platform, user id) identity — purge coherence for a requester's
    // job-watch rows (which record the repo/mode/job id they dispatched).
    const { rowCount: devTeamWatches } = await client.query(
      `DELETE FROM dev_team_watches WHERE requester_platform = $1 AND requester_user_id = $2`,
      [platform, userId],
    );
    // moderation_appeals (issue #554) is keyed the same way — purge coherence
    // for a member's own filed appeal(s), same treatment as member_warnings.
    const { rowCount: moderationAppeals } = await client.query(
      `DELETE FROM moderation_appeals WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    // member_projects (issue #646) is keyed the same way — purge coherence for
    // anyone who shared a project via share_project.
    const { rowCount: memberProjects } = await client.query(
      `DELETE FROM member_projects WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    // member_interests (issue #634) is keyed the same way — purge coherence
    // for anyone who published interests via set_my_interests.
    const { rowCount: memberInterests } = await client.query(
      `DELETE FROM member_interests WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    // Member-sourced knowledge_candidates rows (issue #633, suggest_knowledge)
    // — matched on source_platform/source_user_id, in EVERY status (pending
    // AND accepted/declined), unlike the digest-invalidation delete above
    // (which only removes a still-pending MACHINE row and leaves an accepted
    // one's accountability trail intact). A member's own attributed
    // submission is their data to erase regardless of review status; rows
    // with source_user_id IS NULL (machine-drafted) never match this
    // predicate, so they're untouched.
    const { rowCount: knowledgeTips } = await client.query(
      `DELETE FROM knowledge_candidates WHERE source_platform = $1 AND source_user_id = $2`,
      [platform, userId],
    );
    // helper_notifications (issue #729, find_helper) is keyed on this
    // identity in EITHER role — as the helper who was notified, or as the
    // requester who triggered the notification — so both halves are deleted
    // here, unlike every other table above which is keyed one way.
    const { rowCount: helperNotifications } = await client.query(
      `DELETE FROM helper_notifications
        WHERE (helper_platform = $1 AND helper_user_id = $2)
           OR (requester_platform = $1 AND requester_user_id = $2)`,
      [platform, userId],
    );
    // project_connection_requests (issue #840, request_project_connection) is
    // keyed on this identity in EITHER role — as the project owner who
    // received a request, or as the requester who sent one — same two-sided
    // shape as helper_notifications above.
    const { rowCount: projectConnectionRequests } = await client.query(
      `DELETE FROM project_connection_requests
        WHERE (owner_platform = $1 AND owner_user_id = $2)
           OR (requester_platform = $1 AND requester_user_id = $2)`,
      [platform, userId],
    );

    // Projects (issue #927) are the ONE place erasure is deliberately partial,
    // and the asymmetry is the point:
    //
    //  - `project_members` HARD-DELETEs. It is pure identity; nothing shared is
    //    lost with it, and the person stops being able to reach the project.
    //  - `project_notes` keeps the row and NULLs the authorship. A departing
    //    member's forget_me must not silently gut a standing team's decisions
    //    — that is an unrelated side effect of a privacy action, and the whole
    //    reason the team's memory exists. Precedent: knowledge_candidates
    //    nulls its link for reviewed rows rather than deleting them.
    //
    // DOCUMENTED RESIDUAL: nulling authorship removes the LINK, not personal
    // information the note's own text may contain ("Chris is hosting"). The
    // erasure is therefore partial by design. docs/SECURITY.md §25 says so;
    // forget_me's own reply does NOT yet — it still promises unqualified
    // deletion, which is issue #930. Until that lands, a member in a project
    // is told more was erased than actually was.
    //
    // This exception is scoped to project content ONLY — the
    // `DELETE FROM knowledge` above is untouched, so ordinary knowledge the
    // member authored still disappears exactly as before.
    const { rowCount: projectMemberships } = await client.query(
      `DELETE FROM project_members WHERE platform = $1 AND user_id = $2`,
      [platform, userId],
    );
    await client.query(
      `UPDATE project_notes SET author_platform = NULL, author_user_id = NULL
        WHERE author_platform = $1 AND author_user_id = $2`,
      [platform, userId],
    );
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
    // WhatsApp LID -> phone mapping (schema.sql, docs/SECURITY.md §6b). This
    // row de-anonymises a privacy id, so it is squarely personal data and must
    // not survive an erasure request. Keyed on the PHONE because that is what
    // `userId` is for a WhatsApp identity, and one person can accumulate more
    // than one LID over time. Deleted, not nulled: unlike a project note there
    // is nothing shared to preserve here, it is pure identity.
    if (platform === 'whatsapp') {
      await client.query(`DELETE FROM whatsapp_lid_map WHERE phone = $1`, [userId]);
    }

    await client.query(`UPDATE projects SET created_by = NULL WHERE created_by = $1`, [userId]);
    await client.query(`UPDATE project_members SET added_by = NULL WHERE added_by = $1`, [userId]);
    await client.query(`UPDATE project_surfaces SET bound_by = NULL WHERE bound_by = $1`, [userId]);

    await client.query('COMMIT');
    return (
      (messages ?? 0) +
      (projectMemberships ?? 0) +
      (knowledge ?? 0) +
      (reports ?? 0) +
      (roster ?? 0) +
      (notes ?? 0) +
      (suggestions ?? 0) +
      (digestSends ?? 0) +
      (responseStyle ?? 0) +
      (languagePreference ?? 0) +
      (warnings ?? 0) +
      candidates +
      (answerFeedback ?? 0) +
      (knowledgeGaps ?? 0) +
      (devTeamWatches ?? 0) +
      (moderationAppeals ?? 0) +
      (memberProjects ?? 0) +
      (memberInterests ?? 0) +
      (knowledgeTips ?? 0) +
      (helperNotifications ?? 0) +
      (projectConnectionRequests ?? 0)
    );
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
 * #633) — across every identity linked to them via
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

    // knowledge has no platform column (see purgeSingleIdentity above), so
    // this keys on source_user_id alone, same as the DELETE it reconciles with.
    const { rows: knowledgeRows } = await pool.query(
      `SELECT count(*) AS n FROM knowledge WHERE source_user_id = $1`,
      [identity.userId],
    );
    knowledgeEntries += Number(knowledgeRows[0]?.n ?? 0);

    const { rows: reportRows } = await pool.query(
      `SELECT count(*) AS n FROM content_reports WHERE platform = $1 AND reporter_user_id = $2`,
      [identity.platform, identity.userId],
    );
    reportsFiled += Number(reportRows[0]?.n ?? 0);

    const { rows: suggestionRows } = await pool.query(
      `SELECT count(*) AS n FROM suggestions WHERE platform = $1 AND user_id = $2`,
      [identity.platform, identity.userId],
    );
    suggestionsFiled += Number(suggestionRows[0]?.n ?? 0);

    const { rows: projectRows } = await pool.query(
      `SELECT count(*) AS n FROM member_projects WHERE platform = $1 AND user_id = $2 AND removed_at IS NULL`,
      [identity.platform, identity.userId],
    );
    projectsShared += Number(projectRows[0]?.n ?? 0);

    const { rows: interestRows } = await pool.query(
      `SELECT count(*) AS n FROM member_interests WHERE platform = $1 AND user_id = $2`,
      [identity.platform, identity.userId],
    );
    interestsPublished += Number(interestRows[0]?.n ?? 0);
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
 */
export async function purgeOldInteractions(days: number): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM interactions WHERE created_at < now() - ($1::text || ' days')::interval`,
    [days],
  );
  return rowCount ?? 0;
}
