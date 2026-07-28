import pgvector from 'pgvector/pg';
import type { Platform } from '../../platforms/types.js';
import { logger } from '../../logger.js';
import { pool } from '../db.js';
import { embed } from '../embeddings.js';

/**
 * Member projects — the self-declared project showcase behind share_project /
 * list_projects (#646) and its interests cross-reference (#718).
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
export async function listRecentProjects(limit = 8): Promise<MemberProject[]> {
  const clampedLimit = Math.min(Math.max(Math.trunc(limit) || 8, 1), 50);
  const { rows } = await pool.query(
    `SELECT id, platform, user_id, name, description, link, seeking_collaborators, created_at
       FROM member_projects
      WHERE removed_at IS NULL
      ORDER BY created_at DESC
      LIMIT $1`,
    [clampedLimit],
  );
  return rows.map(mapMemberProjectRow);
}

export interface MemberProjectSearchHit extends MemberProject {
  similarity: number;
}

/** Embedding-similarity search over ACTIVE projects' name+description, for the query-supplied path of list_projects. */
export async function searchProjects(query: string, limit = 8): Promise<MemberProjectSearchHit[]> {
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
