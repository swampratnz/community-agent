import pgvector from 'pgvector/pg';
import type { Platform } from '../../platforms/types.js';
import { logger } from '../../logger.js';
import { pool } from '../db.js';
import { embed } from '../embeddings.js';

/**
 * Member projects — the self-declared project showcase behind share_project /
 * list_projects (#646), its interests cross-reference (#718), and the
 * connection-request handoff behind request_project_connection (#840).
 *
 * SECURITY: a stored project link is DATA. Nothing in this module may fetch,
 * preview, or resolve it — links are rendered verbatim as text by the tool
 * layer. tests/tools.test.ts scans this whole file for outbound-HTTP calls to
 * enforce that (issue #646 AC#4/#6); before the split it scanned the
 * equivalent region of repository.ts by slicing between section banners.
 *
 * Extracted verbatim from repository.ts (see its header for why the split
 * exists); `repository.ts` re-exports everything here, so every existing import
 * site is unchanged.
 */

// --- Member projects (self-declared project showcase, issue #646) -----------
//
// Second instance of #634's self-declared-member-table pattern: opt-in,
// self-scoped, embedded, purge/roster-leave-cleaned data — but discrete
// named artifacts a member accumulates over time (a per-member cap makes
// sense here) rather than one fuzzy discovery blob per member.

/** Per-member cap on distinct (by name) shared projects — keeps the showcase from being flooded by one member. */
export const MEMBER_PROJECT_CAP = 3;
/** Per-user cap on NEW projects within a rolling 24h window (anti-spam), same shape as SUGGESTION_RATE_LIMIT_PER_DAY. Edits (upsert-by-name) don't count against this. */
export const PROJECT_RATE_LIMIT_PER_DAY = 3;
export const PROJECT_NAME_MAX_CHARS = 80;
export const PROJECT_DESCRIPTION_MAX_CHARS = 400;
/** Verbatim member-supplied URL — stored as text, never fetched (no SSRF/preview surface). Capped generously for a URL. */
export const PROJECT_LINK_MAX_CHARS = 300;

export interface MemberProject {
  id: number;
  platform: Platform;
  userId: string;
  name: string;
  description: string;
  link: string | null;
  seekingCollaborators: boolean;
  createdAt: Date;
}

export type ShareProjectResult =
  { ok: true; id: number; created: boolean } | { ok: false; reason: 'cap' | 'rate_limited' };

/**
 * Self-scoped write: shares (or edits, upsert-by-name) one of the caller's
 * own projects. A brand-new name (not already owned as an ACTIVE project by
 * this identity) is subject to BOTH the per-member cap (MEMBER_PROJECT_CAP
 * distinct ACTIVE projects) and the rolling-24h rate cap
 * (PROJECT_RATE_LIMIT_PER_DAY new shares) — same DB-backed, restart-proof
 * COUNT(*)-inside-the-write pattern as createSuggestion, never an in-memory
 * counter. Editing an EXISTING active project (same platform/user_id/name)
 * only ever updates that one row and is deliberately exempt from both caps —
 * a member correcting a typo in their own already-published project is not
 * new flood risk.
 *
 * Removal is soft (`removed_at`, see removeMemberProject) rather than a hard
 * DELETE specifically so the rate cap's rolling-24h COUNT(*) still sees a
 * since-removed row: a hard delete would let a member cycle
 * share/remove/share to keep "recent shares" permanently under the cap while
 * actually publishing unbounded distinct projects over time — the exact
 * churn-spam gap `content_reports`' own soft `status = 'withdrawn'` (never a
 * DELETE) already avoids for its own rate-capped write.
 */
export async function shareProject(input: {
  platform: Platform;
  userId: string;
  name: string;
  description: string;
  link?: string | null;
  seekingCollaborators?: boolean;
}): Promise<ShareProjectResult> {
  const name = input.name.slice(0, PROJECT_NAME_MAX_CHARS);
  const description = input.description.slice(0, PROJECT_DESCRIPTION_MAX_CHARS);
  const link = input.link ? input.link.slice(0, PROJECT_LINK_MAX_CHARS) : null;
  const seekingCollaborators = input.seekingCollaborators ?? false;
  let embedding: number[] | null = null;
  try {
    embedding = await embed(`${name}\n${description}`);
  } catch (err) {
    logger.warn({ err }, 'Embedding failed for shared project');
  }

  const { rows: existingRows } = await pool.query(
    `SELECT id FROM member_projects
      WHERE platform = $1 AND user_id = $2 AND name = $3 AND removed_at IS NULL`,
    [input.platform, input.userId, name],
  );
  const existing = existingRows[0];

  if (existing) {
    await pool.query(
      `UPDATE member_projects SET description = $2, link = $3, embedding = $4, seeking_collaborators = $5 WHERE id = $1`,
      [
        Number(existing.id),
        description,
        link,
        embedding ? pgvector.toSql(embedding) : null,
        seekingCollaborators,
      ],
    );
    return { ok: true, id: Number(existing.id), created: false };
  }

  const { rows } = await pool.query(
    `WITH recent AS (
       -- ALL rows in the window, active or soft-removed — a removed row still
       -- represents a share that happened, so it must still count here.
       SELECT count(*) AS n FROM member_projects
        WHERE platform = $1 AND user_id = $2
          AND created_at > now() - interval '24 hours'
     ),
     active_total AS (
       SELECT count(*) AS n FROM member_projects
        WHERE platform = $1 AND user_id = $2 AND removed_at IS NULL
     )
     INSERT INTO member_projects (platform, user_id, name, description, link, embedding, seeking_collaborators)
     SELECT $1, $2, $3, $4, $5, $6, $9
      WHERE (SELECT n FROM recent) < $7 AND (SELECT n FROM active_total) < $8
     RETURNING id`,
    [
      input.platform,
      input.userId,
      name,
      description,
      link,
      embedding ? pgvector.toSql(embedding) : null,
      PROJECT_RATE_LIMIT_PER_DAY,
      MEMBER_PROJECT_CAP,
      seekingCollaborators,
    ],
  );
  if (rows[0]) return { ok: true, id: Number(rows[0].id), created: true };

  // Distinguish which cap was hit for a precise refusal message.
  const { rows: countRows } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE removed_at IS NULL) AS active_total,
       count(*) FILTER (WHERE created_at > now() - interval '24 hours') AS recent
     FROM member_projects WHERE platform = $1 AND user_id = $2`,
    [input.platform, input.userId],
  );
  const activeTotal = Number(countRows[0]?.active_total ?? 0);
  return { ok: false, reason: activeTotal >= MEMBER_PROJECT_CAP ? 'cap' : 'rate_limited' };
}

/**
 * Self-scoped removal by name — soft (removed_at, not a DELETE) so the
 * rate-limit window above still sees it; purgeSingleIdentity/markRosterLeave
 * are the only hard-DELETE paths (full erasure for privacy/offboarding).
 * Returns false if the caller has no ACTIVE project by that name.
 */
export async function removeMemberProject(
  platform: Platform,
  userId: string,
  name: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE member_projects SET removed_at = now()
      WHERE platform = $1 AND user_id = $2 AND name = $3 AND removed_at IS NULL`,
    [platform, userId, name.slice(0, PROJECT_NAME_MAX_CHARS)],
  );
  return (rowCount ?? 0) > 0;
}

/** Most-recently-shared ACTIVE projects across every member — the no-query default for list_projects. */
export async function listRecentProjects(
  limit = 8,
  opts: { seekingCollaboratorsOnly?: boolean } = {},
): Promise<MemberProject[]> {
  const clampedLimit = Math.min(Math.max(Math.trunc(limit) || 8, 1), 50);
  const { rows } = await pool.query(
    `SELECT id, platform, user_id, name, description, link, seeking_collaborators, created_at
       FROM member_projects
      WHERE removed_at IS NULL
        ${opts.seekingCollaboratorsOnly ? 'AND seeking_collaborators' : ''}
      ORDER BY created_at DESC
      LIMIT $1`,
    [clampedLimit],
  );
  return rows.map(mapMemberProjectRow);
}

/**
 * Self-scoped listing: the caller's own ACTIVE (`removed_at IS NULL`) shared
 * projects, ORDER BY created_at DESC — the recall path `share_project`'s
 * edit/remove-by-name contract needs (issue #867) but list_projects never
 * exposed. Scoped by equality on BOTH platform and user_id, taken from the
 * caller's own identity only (never a tool-argument-supplied identifier), the
 * same self-scoping pattern as getActiveProjectNamesForOwners above. No limit
 * param — naturally bounded by MEMBER_PROJECT_CAP.
 */
export async function listOwnProjects(platform: Platform, userId: string): Promise<MemberProject[]> {
  const { rows } = await pool.query(
    `SELECT id, platform, user_id, name, description, link, seeking_collaborators, created_at
       FROM member_projects
      WHERE platform = $1 AND user_id = $2 AND removed_at IS NULL
      ORDER BY created_at DESC`,
    [platform, userId],
  );
  return rows.map(mapMemberProjectRow);
}

export interface MemberProjectSearchHit extends MemberProject {
  similarity: number;
}

/** Embedding-similarity search over ACTIVE projects' name+description, for the query-supplied path of list_projects. */
export async function searchProjects(
  query: string,
  limit = 8,
  opts: { seekingCollaboratorsOnly?: boolean } = {},
): Promise<MemberProjectSearchHit[]> {
  const clampedLimit = Math.min(Math.max(Math.trunc(limit) || 8, 1), 50);
  let queryVec: number[];
  try {
    queryVec = await embed(query);
  } catch (err) {
    logger.warn({ err }, 'Embedding query failed; skipping project search');
    return [];
  }
  const { rows } = await pool.query(
    `SELECT id, platform, user_id, name, description, link, seeking_collaborators, created_at,
            1 - (embedding <=> $1) AS similarity
       FROM member_projects
      WHERE embedding IS NOT NULL AND removed_at IS NULL
        ${opts.seekingCollaboratorsOnly ? 'AND seeking_collaborators' : ''}
      ORDER BY embedding <=> $1
      LIMIT $2`,
    [pgvector.toSql(queryVec), clampedLimit],
  );
  return rows.map((r) => ({ ...mapMemberProjectRow(r), similarity: Number(r.similarity) }));
}

/**
 * Batched lookup of ACTIVE (`removed_at IS NULL`) shared-project names for a
 * set of owners, keyed by `"platform:userId"` — used by who_is_into's
 * cross-reference (issue #718) to show a matched member's shipped projects
 * without an N+1 query per rendered row. Same `unnest($1, $2)` composite-key
 * batching as `getPublishedInterestsForOwners` above — SECURITY: issue #718
 * AC #7, only ever returns rows for owners in the input set. An owner with
 * zero active projects (none ever shared, or all soft-removed) simply has no
 * entry in the returned Map.
 */
export async function getActiveProjectNamesForOwners(
  owners: ReadonlyArray<{ platform: Platform; userId: string }>,
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (owners.length === 0) return result;
  const { rows } = await pool.query(
    `SELECT platform, user_id, name
       FROM member_projects
      WHERE removed_at IS NULL
        AND (platform, user_id) IN (SELECT * FROM unnest($1::text[], $2::text[]))
      ORDER BY platform, user_id, created_at DESC`,
    [owners.map((o) => o.platform), owners.map((o) => o.userId)],
  );
  for (const r of rows) {
    const key = `${r.platform}:${r.user_id}`;
    const names = result.get(key) ?? [];
    names.push(r.name as string);
    result.set(key, names);
  }
  return result;
}

/**
 * Count of ACTIVE projects shared since `since` — issue #714's member-digest
 * awareness nudge. `removed_at IS NULL` mirrors `listRecentProjects`/
 * `searchProjects` so the number a member sees always matches what
 * `list_projects` would actually show them right now; a soft-removed row
 * must never inflate the count.
 */
export async function countProjectsSharedSince(since: Date): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM member_projects WHERE created_at > $1 AND removed_at IS NULL`,
    [since],
  );
  return Number(rows[0].n);
}

/**
 * Count of candidates accepted since `since` — issue #797's admin-digest
 * flywheel-throughput signal, the positive counterpart to
 * `countPendingKnowledgeCandidates`'s backlog nag. Mirrors
 * `countProjectsSharedSince`'s exact shape: `reviewed_at` (set by
 * `acceptKnowledgeCandidate` alongside the `status = 'accepted'` flip) is the
 * acceptance-event timestamp, so a candidate created long ago but accepted
 * this week still counts, and a pending/declined row never does.
 */
export async function countAcceptedKnowledgeCandidatesSince(since: Date): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM knowledge_candidates WHERE status = 'accepted' AND reviewed_at > $1`,
    [since],
  );
  return Number(rows[0].n);
}

// --- Connection-request handoff (request_project_connection, issue #840) ----
//
// The active-side consumer of member_projects.seeking_collaborators (#834):
// request_project_connection embeds no query and calls no model — matching is
// by explicit id, not similarity — and DMs the project's owner, modelled
// directly on find_helper's DM-handoff shape (memberDiscovery.ts). The log
// table is an append-only mirror of helper_notifications, backing two
// independent DB-backed rolling-window caps (never in-memory counters).

/** Per-requester cap on request_project_connection calls in a rolling 24h — mirrors FIND_HELPER_REQUESTER_DAILY_LIMIT. */
export const PROJECT_CONNECTION_REQUESTER_DAILY_LIMIT = 3;
/** Per-owner cap on connection requests received in a rolling 7 days — mirrors FIND_HELPER_WEEKLY_LIMIT_PER_HELPER. */
export const PROJECT_CONNECTION_OWNER_WEEKLY_LIMIT = 3;

/** Single ACTIVE (`removed_at IS NULL`) project lookup by id, for request_project_connection's ownership/eligibility checks. Null if not found or removed. */
export async function getActiveProjectById(id: number): Promise<MemberProject | null> {
  const { rows } = await pool.query(
    `SELECT id, platform, user_id, name, description, link, seeking_collaborators, created_at
       FROM member_projects
      WHERE id = $1 AND removed_at IS NULL`,
    [id],
  );
  return rows[0] ? mapMemberProjectRow(rows[0]) : null;
}

/**
 * True if `platform`/`userId` has hit PROJECT_CONNECTION_REQUESTER_DAILY_LIMIT
 * connection requests (rows where they're the requester) in the trailing
 * 24h — checked BEFORE the owner-cap write, same order-of-operations as
 * isFindHelperRequesterAtDailyCap.
 */
export async function isProjectConnectionRequesterAtDailyCap(
  platform: Platform,
  userId: string,
): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT count(*) AS n FROM project_connection_requests
      WHERE requester_platform = $1 AND requester_user_id = $2
        AND created_at > now() - interval '24 hours'`,
    [platform, userId],
  );
  return Number(rows[0]?.n ?? 0) >= PROJECT_CONNECTION_REQUESTER_DAILY_LIMIT;
}

/**
 * Atomically claims one connection-request slot for a project owner if
 * they're under PROJECT_CONNECTION_OWNER_WEEKLY_LIMIT in the trailing 7
 * days — same restart-proof `WITH recent AS (...)` pattern as
 * recordHelperNotificationIfUnderCap. Returns false (no row inserted, no DM
 * should be sent) when the owner is already at cap; true means this row IS
 * the claimed request and the caller should now DM the owner.
 */
export async function recordProjectConnectionIfUnderCap(
  ownerPlatform: Platform,
  ownerUserId: string,
  requesterPlatform: Platform,
  requesterUserId: string,
  projectId: number,
): Promise<boolean> {
  const { rows } = await pool.query(
    `WITH recent AS (
       SELECT count(*) AS n FROM project_connection_requests
        WHERE owner_platform = $1 AND owner_user_id = $2
          AND created_at > now() - interval '7 days'
     )
     INSERT INTO project_connection_requests
       (owner_platform, owner_user_id, requester_platform, requester_user_id, project_id)
     SELECT $1, $2, $3, $4, $5
      WHERE (SELECT n FROM recent) < $6
     RETURNING id`,
    [
      ownerPlatform,
      ownerUserId,
      requesterPlatform,
      requesterUserId,
      projectId,
      PROJECT_CONNECTION_OWNER_WEEKLY_LIMIT,
    ],
  );
  return rows.length > 0;
}

/**
 * Count of connection requests since `since` — issue #870's admin-digest
 * flywheel-throughput signal, the fourth dimension and the second action in
 * #820's "actively connects two members" category alongside
 * `countHelperMatchesSince`. Mirrors that function's exact shape: one row per
 * successful request_project_connection call (the atomic claim in
 * recordProjectConnectionIfUnderCap), so a capped/refused attempt never
 * inflates the count.
 */
export async function countProjectConnectionsSince(since: Date): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM project_connection_requests WHERE created_at > $1`,
    [since],
  );
  return Number(rows[0].n);
}

/** A caller's own recorded connection request — a receipt (what was asked, when), never a status: the table has no status column (issue #908). */
export interface ProjectConnectionRequestReceipt {
  id: number;
  projectId: number;
  /** The requested project's name, or null if that project is gone: soft-removed (`removed_at`, e.g. via `remove_project`) or the `member_projects` row itself is hard-deleted (owner purged/left). */
  projectName: string | null;
  createdAt: Date;
}

/**
 * Self-scoped read of a member's OWN sent connection requests (issue #908) —
 * the `my_submissions` receipt for `request_project_connection`, matching
 * `listOwnKnowledgeCandidates`'s exact shape/clamp. Scoped to
 * `requester_platform`/`requester_user_id` ONLY — `project_connection_requests`
 * is two-sided-keyed (the same identity can appear as `owner_*` on a
 * different row, for a request THEY received), and this must never surface
 * those; a request the caller merely owns is not one they filed.
 *
 * LEFT JOINs `member_projects` for the project name rather than requiring the
 * row still exist, so the receipt still renders for a since-gone project
 * instead of throwing or being silently dropped. The join additionally
 * requires `mp.removed_at IS NULL`, matching `list_projects`/`listOwnProjects`/
 * `getActiveProjectById`'s treatment of soft-removal: removal in this
 * codebase is soft (`removeMemberProject`, wired to the member-facing
 * `remove_project` tool), so without this filter `mp.id` still matches a
 * removed project and its stale name would keep showing forever. A row whose
 * `member_projects` id no longer exists at all (hard-deleted via purge/leave)
 * also reads back null via the LEFT JOIN itself.
 */
export async function listOwnProjectConnectionRequests(
  platform: Platform,
  userId: string,
  limit = 10,
): Promise<ProjectConnectionRequestReceipt[]> {
  const clampedLimit = Math.min(Math.max(Math.trunc(limit) || 10, 1), 50);
  const { rows } = await pool.query(
    `SELECT pcr.id, pcr.project_id, mp.name AS project_name, pcr.created_at
       FROM project_connection_requests pcr
       LEFT JOIN member_projects mp ON mp.id = pcr.project_id AND mp.removed_at IS NULL
      WHERE pcr.requester_platform = $1 AND pcr.requester_user_id = $2
      ORDER BY pcr.created_at DESC
      LIMIT $3`,
    [platform, userId, clampedLimit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    projectId: Number(r.project_id),
    projectName: (r.project_name as string | null) ?? null,
    createdAt: r.created_at as Date,
  }));
}

function mapMemberProjectRow(r: {
  id: number | string;
  platform: string;
  user_id: string;
  name: string;
  description: string;
  link: string | null;
  seeking_collaborators: boolean;
  created_at: Date;
}): MemberProject {
  return {
    id: Number(r.id),
    platform: r.platform as Platform,
    userId: r.user_id,
    name: r.name,
    description: r.description,
    link: r.link,
    seekingCollaborators: r.seeking_collaborators,
    createdAt: r.created_at,
  };
}
