import pgvector from 'pgvector/pg';
import type { Platform } from '../../platforms/types.js';
import { logger } from '../../logger.js';
import { pool } from '../db.js';
import { embed } from '../embeddings.js';
import { KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD } from './shared.js';

/**
 * Projects (issue #927): a standing team's shared memory that follows the team
 * across platforms rather than living in one channel.
 *
 * The whole security model of this module is one rule, enforced in SQL in
 * `visibleProjectIds` and never re-derived by callers:
 *
 *   a project's content is readable only when the asker is a MEMBER *and* the
 *   current conversation is a bound SURFACE (or a DM to that member).
 *
 * Membership answers *who*; the surface binding answers *where*. Membership
 * alone is not enough: a member asking in a public channel would otherwise
 * have private project content recited in front of everyone — issue #106's
 * failure mode with a team's notes instead of one conversation's.
 *
 * A project grants DATA SCOPE ONLY. Nothing here is consulted when deriving
 * the per-turn tool surface (`toolsForRole`), exactly as `persons` "never
 * touches role" — adding someone to a project must never change what tools
 * exist for them. See docs/SECURITY.md.
 */

export interface Project {
  id: number;
  slug: string;
  name: string;
  brief: string | null;
  createdAt: Date;
  archivedAt: Date | null;
}

export interface ProjectNoteHit {
  id: number;
  projectId: number;
  projectSlug: string;
  title: string | null;
  content: string;
  referenceUrl: string | null;
  similarity: number;
  updatedAt: Date;
}

function toProject(r: {
  id: string | number;
  slug: string;
  name: string;
  brief: string | null;
  created_at: Date;
  archived_at: Date | null;
}): Project {
  return {
    id: Number(r.id),
    slug: r.slug,
    name: r.name,
    brief: r.brief,
    createdAt: r.created_at,
    archivedAt: r.archived_at,
  };
}

/**
 * The identities that count as "this caller" for membership: their own
 * platform row, plus every identity sharing their `person_id` when
 * `link_member` has linked one. Written as a CTE fragment rather than a
 * separate round trip so membership can never be resolved in application code
 * and then trusted — every read that needs it re-derives it in the same query.
 *
 * Deliberately keyed on the platform identity rather than `person_id`
 * directly: `linkMembers` MERGES person rows (keeps the lower id, drops the
 * other), so a person-keyed membership row would need repointing on every
 * link. Expanding at read time has no such coupling — linking two identities
 * makes both reach the project immediately, and unlinking narrows it again,
 * with no rows to migrate.
 */
const CALLER_IDENTITIES_CTE = `
  caller_person AS (
    SELECT person_id FROM community_users
     WHERE platform = $1 AND platform_user_id = $2
  ),
  caller_identities AS (
    SELECT $1::text AS platform, $2::text AS user_id
    UNION
    SELECT cu.platform, cu.platform_user_id
      FROM community_users cu, caller_person
     WHERE caller_person.person_id IS NOT NULL
       AND cu.person_id = caller_person.person_id
  )`;

export interface ProjectCaller {
  platform: Platform;
  userId: string;
  conversationId: string;
  /** True for a 1:1 DM — always an allowed surface for a member (nothing to bind). */
  isDirect: boolean;
}

/**
 * SECURITY: the single source of truth for "which projects may this caller
 * read, in this conversation". Both checks in one statement:
 *
 *  - membership, expanded through linked identities (CALLER_IDENTITIES_CTE);
 *  - surface, satisfied by a DM or by an explicit `project_surfaces` binding
 *    for THIS platform + conversation.
 *
 * Archived projects are excluded. Returns [] for a caller with no projects,
 * which every caller must treat as "no project content", never as "unfiltered".
 */
export async function visibleProjectIds(caller: ProjectCaller): Promise<number[]> {
  const { rows } = await pool.query(
    `WITH ${CALLER_IDENTITIES_CTE}
     SELECT DISTINCT pm.project_id AS id
       FROM project_members pm
       JOIN caller_identities ci
         ON ci.platform = pm.platform AND ci.user_id = pm.user_id
       JOIN projects p
         ON p.id = pm.project_id AND p.archived_at IS NULL
      WHERE $4::boolean
         OR EXISTS (
              SELECT 1 FROM project_surfaces ps
               WHERE ps.project_id = pm.project_id
                 AND ps.platform = $1
                 AND ps.conversation_id = $3
            )`,
    [caller.platform, caller.userId, caller.conversationId, caller.isDirect],
  );
  return rows.map((r) => Number(r.id));
}

/**
 * Semantic search over a caller's visible project notes. Scoping is applied in
 * the SAME statement as the vector search (`project_id = ANY(visible)`), not
 * by filtering results afterwards, so there is no window in which an
 * out-of-scope row exists in memory.
 *
 * Returns [] — never throws — when the caller has no visible project, and when
 * embedding fails, mirroring `searchKnowledge`'s fail-closed shape.
 */
export async function searchProjectNotes(
  query: string,
  caller: ProjectCaller,
  topK = 5,
): Promise<ProjectNoteHit[]> {
  const visible = await visibleProjectIds(caller);
  if (visible.length === 0) return [];

  let queryVec: number[];
  try {
    queryVec = await embed(query);
  } catch (err) {
    logger.warn({ err }, 'Embedding query failed; skipping project note search');
    return [];
  }

  const { rows } = await pool.query(
    `SELECT n.id, n.project_id, p.slug AS project_slug, n.title, n.content, n.reference_url,
            n.updated_at, 1 - (n.embedding <=> $1) AS similarity
       FROM project_notes n
       JOIN projects p ON p.id = n.project_id
      WHERE n.embedding IS NOT NULL
        AND n.project_id = ANY($2::bigint[])
      ORDER BY n.embedding <=> $1
      LIMIT $3`,
    [pgvector.toSql(queryVec), visible, topK],
  );

  return rows
    .map((r) => ({
      id: Number(r.id),
      projectId: Number(r.project_id),
      projectSlug: r.project_slug,
      title: r.title,
      content: r.content,
      referenceUrl: r.reference_url,
      similarity: Number(r.similarity),
      updatedAt: r.updated_at,
    }))
    .filter((h) => h.similarity >= KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD);
}

/**
 * Save a note against a project the caller may currently write to — the same
 * two checks as reading. Returns null when the project is not visible here,
 * which the tool layer renders as an ordinary "no such project" rather than
 * distinguishing "exists but you may not" (issue #205's wording rule).
 */
export async function saveProjectNote(
  caller: ProjectCaller,
  input: { slug: string; content: string; title?: string; referenceUrl?: string },
): Promise<{ id: number } | null> {
  const visible = await visibleProjectIds(caller);
  if (visible.length === 0) return null;

  const { rows: projectRows } = await pool.query(
    `SELECT id FROM projects WHERE slug = $1 AND id = ANY($2::bigint[])`,
    [input.slug, visible],
  );
  if (projectRows.length === 0) return null;
  const projectId = Number(projectRows[0].id);

  let embedding: number[] | null = null;
  try {
    embedding = await embed(input.title ? `${input.title}\n${input.content}` : input.content);
  } catch (err) {
    logger.warn({ err }, 'Embedding failed for project note');
  }

  const { rows } = await pool.query(
    `INSERT INTO project_notes (project_id, title, content, reference_url, author_platform, author_user_id, embedding)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [
      projectId,
      input.title ?? null,
      input.content,
      input.referenceUrl ?? null,
      caller.platform,
      caller.userId,
      embedding ? pgvector.toSql(embedding) : null,
    ],
  );
  return { id: Number(rows[0].id) };
}

/** Bump retrieval_count for notes actually served, mirroring recordKnowledgeRetrieval. */
export async function recordProjectNoteRetrieval(ids: readonly number[]): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    `UPDATE project_notes SET retrieval_count = retrieval_count + 1 WHERE id = ANY($1::bigint[])`,
    [[...ids]],
  );
}

/**
 * The projects a caller may see here, for rendering ("you're in: …") and for
 * the standing `brief`. Same two checks as everything else.
 */
export async function listVisibleProjects(caller: ProjectCaller): Promise<Project[]> {
  const visible = await visibleProjectIds(caller);
  if (visible.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT id, slug, name, brief, created_at, archived_at
       FROM projects WHERE id = ANY($1::bigint[]) ORDER BY name`,
    [visible],
  );
  return rows.map(toProject);
}

// --- Admin-side management -------------------------------------------------

export async function createProject(input: {
  slug: string;
  name: string;
  brief?: string;
  createdBy: string;
}): Promise<Project> {
  const { rows } = await pool.query(
    `INSERT INTO projects (slug, name, brief, created_by) VALUES ($1,$2,$3,$4)
     RETURNING id, slug, name, brief, created_at, archived_at`,
    [input.slug, input.name, input.brief ?? null, input.createdBy],
  );
  return toProject(rows[0]);
}

export async function getProjectBySlug(slug: string): Promise<Project | null> {
  const { rows } = await pool.query(
    `SELECT id, slug, name, brief, created_at, archived_at FROM projects WHERE slug = $1`,
    [slug],
  );
  return rows.length > 0 ? toProject(rows[0]) : null;
}

export async function archiveProject(slug: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE projects SET archived_at = now() WHERE slug = $1 AND archived_at IS NULL`,
    [slug],
  );
  return (rowCount ?? 0) > 0;
}

/** Every project, for the admin browse view. Not caller-scoped — admin tools gate the call. */
export async function listAllProjects(includeArchived = false): Promise<Project[]> {
  const { rows } = await pool.query(
    `SELECT id, slug, name, brief, created_at, archived_at FROM projects
      ${includeArchived ? '' : 'WHERE archived_at IS NULL'}
      ORDER BY name`,
  );
  return rows.map(toProject);
}

export async function addProjectMember(
  projectId: number,
  platform: Platform,
  userId: string,
  addedBy: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO project_members (project_id, platform, user_id, added_by)
     VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [projectId, platform, userId, addedBy],
  );
  return (rowCount ?? 0) > 0;
}

export async function removeProjectMember(
  projectId: number,
  platform: Platform,
  userId: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM project_members WHERE project_id = $1 AND platform = $2 AND user_id = $3`,
    [projectId, platform, userId],
  );
  return (rowCount ?? 0) > 0;
}

export async function listProjectMembers(
  projectId: number,
): Promise<{ platform: Platform; userId: string; addedAt: Date }[]> {
  const { rows } = await pool.query(
    `SELECT platform, user_id, added_at FROM project_members WHERE project_id = $1 ORDER BY added_at`,
    [projectId],
  );
  return rows.map((r) => ({ platform: r.platform as Platform, userId: r.user_id, addedAt: r.added_at }));
}

export async function bindProjectSurface(
  projectId: number,
  platform: Platform,
  conversationId: string,
  boundBy: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO project_surfaces (project_id, platform, conversation_id, bound_by)
     VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [projectId, platform, conversationId, boundBy],
  );
  return (rowCount ?? 0) > 0;
}

export async function unbindProjectSurface(
  projectId: number,
  platform: Platform,
  conversationId: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM project_surfaces WHERE project_id = $1 AND platform = $2 AND conversation_id = $3`,
    [projectId, platform, conversationId],
  );
  return (rowCount ?? 0) > 0;
}

export async function listProjectSurfaces(
  projectId: number,
): Promise<{ platform: Platform; conversationId: string }[]> {
  const { rows } = await pool.query(
    `SELECT platform, conversation_id FROM project_surfaces WHERE project_id = $1 ORDER BY bound_at`,
    [projectId],
  );
  return rows.map((r) => ({ platform: r.platform as Platform, conversationId: r.conversation_id }));
}
