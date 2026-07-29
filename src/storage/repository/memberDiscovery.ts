import pgvector from 'pgvector/pg';
import type { Platform } from '../../platforms/types.js';
import { logger } from '../../logger.js';
import { pool } from '../db.js';
import { KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD } from './shared.js';
import { embed } from '../embeddings.js';

/**
 * Member-to-member discovery: published member interests (issue #634) and the
 * helper handoff behind set_helper_availability / find_helper (issue #729).
 * Kept together because find_helper's match query is deliberately modelled on
 * searchMemberInterests' shape and the comments here cross-reference it.
 *
 * Extracted verbatim from repository.ts (see its header for why the split
 * exists); `repository.ts` re-exports everything here, so every existing import
 * site is unchanged.
 */

// --- Member interests (member-to-member discovery, issue #634) --------------
//
// Self-declared-member-table pattern member_projects below reuses: opt-in,
// self-scoped, embedded, purge/roster-leave-cleaned data. One fuzzy free-text
// blob per identity rather than discrete named artifacts, hence the plain
// (platform, user_id) primary key and upsert-only-in-place semantics — no
// per-member cap or rate limit is needed since a member can only ever have
// the single row their own writes replace.

/** Hard cap on published interest text length (self-declared free text), enforced server-side. */
export const MEMBER_INTERESTS_MAX_CHARS = 300;
/** who_is_into's result cap. */
export const WHO_IS_INTO_LIMIT = 5;

export interface MemberInterestSearchHit {
  platform: Platform;
  userId: string;
  interests: string;
  similarity: number;
}

/**
 * Self-scoped upsert/clear of the caller's OWN published interests row.
 * Passing the literal string 'clear' (case-insensitive, whitespace-trimmed)
 * deletes the row instead of writing one — the exact `text | 'clear'`
 * interface the tool description exposes. Never CONFIRM-gated: instantly
 * reversible, same shape as set_response_style/set_language_preference.
 */
export async function setMemberInterests(
  platform: Platform,
  userId: string,
  interests: string,
): Promise<{ cleared: boolean }> {
  if (interests.trim().toLowerCase() === 'clear') {
    await pool.query(`DELETE FROM member_interests WHERE platform = $1 AND user_id = $2`, [platform, userId]);
    return { cleared: true };
  }
  const text = interests.slice(0, MEMBER_INTERESTS_MAX_CHARS);
  let embedding: number[] | null = null;
  try {
    embedding = await embed(text);
  } catch (err) {
    logger.warn({ err }, 'Embedding failed for member interests');
  }
  await pool.query(
    `INSERT INTO member_interests (platform, user_id, interests, embedding, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (platform, user_id) DO UPDATE SET
       interests = EXCLUDED.interests, embedding = EXCLUDED.embedding, updated_at = now()`,
    [platform, userId, text, embedding ? pgvector.toSql(embedding) : null],
  );
  return { cleared: false };
}

/**
 * Embedding-similarity search over published interests ONLY (never
 * `interactions` — SECURITY: issue #634 AC #4, interests are never inferred
 * from chat content). A caller with no row of their own can still search;
 * absent/cleared rows never appear since they simply don't exist in the table.
 */
export async function searchMemberInterests(
  query: string,
  limit = WHO_IS_INTO_LIMIT,
): Promise<MemberInterestSearchHit[]> {
  const clampedLimit = Math.min(Math.max(Math.trunc(limit) || WHO_IS_INTO_LIMIT, 1), 50);
  let queryVec: number[];
  try {
    queryVec = await embed(query);
  } catch (err) {
    logger.warn({ err }, 'Embedding query failed; skipping member interest search');
    return [];
  }
  const { rows } = await pool.query(
    `SELECT platform, user_id, interests, 1 - (embedding <=> $1) AS similarity
       FROM member_interests
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> $1
      LIMIT $2`,
    [pgvector.toSql(queryVec), clampedLimit],
  );
  return rows.map((r) => ({
    platform: r.platform as Platform,
    userId: r.user_id,
    interests: r.interests as string,
    similarity: Number(r.similarity),
  }));
}

export type SelfInterestMatchResult =
  | { hasProfile: false }
  | { hasProfile: true; hits: MemberInterestSearchHit[] };

/**
 * `who_is_into`'s no-`query` path (issue #882): match the caller's OWN
 * published `member_interests` row against every other published row,
 * excluding the caller's own — the implicit query is the caller's already-
 * stored `embedding`, never re-embedded and never sourced from `interactions`
 * (SECURITY: same #634 AC #4 invariant `searchMemberInterests` preserves).
 * The self-join keeps the vector inside SQL end to end rather than pulling it
 * into JS and back (the technique `listDuplicateKnowledge` already uses for
 * knowledge's near-duplicate self-join, `repository/knowledge.ts`).
 *
 * `hasProfile: false` covers both "no row" and "row exists but has no
 * embedding yet" (an earlier `set_my_interests` embed failure) — either way
 * there is no implicit query to run, and the caller sees the same guidance
 * `who_is_into` returns for a first-time caller.
 */
export async function searchMemberInterestsForSelf(
  platform: Platform,
  userId: string,
  limit = WHO_IS_INTO_LIMIT,
): Promise<SelfInterestMatchResult> {
  const clampedLimit = Math.min(Math.max(Math.trunc(limit) || WHO_IS_INTO_LIMIT, 1), 50);
  const { rows } = await pool.query(
    `WITH me AS (
       SELECT embedding FROM member_interests
        WHERE platform = $1 AND user_id = $2 AND embedding IS NOT NULL
     )
     SELECT mi.platform, mi.user_id, mi.interests,
            1 - (mi.embedding <=> me.embedding) AS similarity
       FROM member_interests mi, me
      WHERE mi.embedding IS NOT NULL
        AND NOT (mi.platform = $1 AND mi.user_id = $2)
      ORDER BY mi.embedding <=> me.embedding
      LIMIT $3`,
    [platform, userId, clampedLimit],
  );
  if (rows.length > 0) {
    return {
      hasProfile: true,
      hits: rows.map((r) => ({
        platform: r.platform as Platform,
        userId: r.user_id,
        interests: r.interests as string,
        similarity: Number(r.similarity),
      })),
    };
  }
  // Empty result is ambiguous by itself (no profile vs. a profile with no
  // matches) — disambiguate with a cheap existence check only in this
  // branch, so the common case (a match exists) never pays for it.
  const { rows: meRows } = await pool.query(
    `SELECT 1 FROM member_interests WHERE platform = $1 AND user_id = $2 AND embedding IS NOT NULL`,
    [platform, userId],
  );
  return meRows.length > 0 ? { hasProfile: true, hits: [] } : { hasProfile: false };
}

/**
 * Batched lookup of published `member_interests` text for a set of owners,
 * keyed by `"platform:userId"` — used by list_projects' cross-reference
 * (issue #718) to show a project owner's published interests without an
 * N+1 query per rendered row. One round trip for the whole result set via
 * `unnest($1, $2)` zipping the parallel platform/userId arrays into rows,
 * matched against the composite `(platform, user_id)` key — SECURITY:
 * issue #718 AC #7, this can only ever return rows for owners in the input
 * set, never a full-table read. An owner with no published interests (or
 * who cleared them) simply has no entry in the returned Map.
 */
export async function getPublishedInterestsForOwners(
  owners: ReadonlyArray<{ platform: Platform; userId: string }>,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (owners.length === 0) return result;
  const { rows } = await pool.query(
    `SELECT platform, user_id, interests
       FROM member_interests
      WHERE (platform, user_id) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
    [owners.map((o) => o.platform), owners.map((o) => o.userId)],
  );
  for (const r of rows) {
    result.set(`${r.platform}:${r.user_id}`, r.interests as string);
  }
  return result;
}

/**
 * Count of `member_interests` rows published or updated since `since` —
 * issue #815's member-digest awareness nudge, the direct sibling of
 * `countProjectsSharedSince` (issue #714) for this table. `member_interests`
 * is a single-row-per-identity upsert with no `created_at` column (only
 * `updated_at`), so this counts "published or updated in the window," not
 * "brand new" — the digest copy states that rather than implying novelty
 * the schema can't distinguish. No `removed_at`/soft-delete column exists on
 * this table (a clear/purge is a hard `DELETE`), so unlike
 * `countProjectsSharedSince` there is no soft-removed row to exclude.
 */
export async function countInterestsPublishedSince(since: Date): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM member_interests WHERE updated_at > $1`,
    [since],
  );
  return Number(rows[0].n);
}

// --- Helper handoff (set_helper_availability / find_helper, issue #729) -----
//
// The active-side consumer of member_interests: willing_to_help rides the
// same row set_my_interests/who_is_into already publish/search, so a helper
// must have a published interests row before they can opt in. Matching reuses
// searchMemberInterests' exact query shape (embedding-similarity, embedding
// IS NOT NULL) filtered to willing_to_help = true and excluding the
// requester's own row. helper_notifications is a separate append-only log,
// never edited in place, backing two independent DB-backed rolling-window
// caps (never in-memory counters, so both survive a process restart).

/** Hard cap on a find_helper topic's length, mirroring rate_answer's comment cap. */
export const FIND_HELPER_TOPIC_MAX_CHARS = 200;
/** How many top-ranked candidates find_helper will walk before giving up — bounded above the two rate caps below so a scan isn't starved by a few maxed-out helpers. */
export const FIND_HELPER_CANDIDATE_SCAN_LIMIT = 10;
/** Per-helper cap on notifications received in a rolling 7 days — the "unsolicited pings" guardrail. */
export const FIND_HELPER_WEEKLY_LIMIT_PER_HELPER = 3;
/** Per-requester cap on find_helper calls in a rolling 24h — prevents looping over topics to exhaust many helpers' weekly quotas. */
export const FIND_HELPER_REQUESTER_DAILY_LIMIT = 3;
/**
 * Minimum cosine similarity for a willing_to_help row to count as a genuine
 * match — same floor and same embedding model as
 * KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD. Without this, findHelperCandidates
 * would always return the nearest-ranked willing helper regardless of actual
 * relevance (searchMemberInterests/who_is_into has the same no-floor shape,
 * but it only ever surfaces a list for the REQUESTER to judge; find_helper
 * acts on the match autonomously by sending a DM, so "match" must mean
 * something or AC #5's "no one available" outcome could never be reached).
 */
export const FIND_HELPER_RELEVANCE_THRESHOLD = KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD;

export type SetHelperAvailabilityResult = { ok: true } | { ok: false; reason: 'no_interests_row' };

/**
 * Self-scoped flip of the caller's OWN willing_to_help flag. Requires an
 * existing member_interests row (set via set_my_interests) — matching needs
 * that row's published text/embedding to work at all, so there is nothing to
 * flip a flag on for a caller who has never published interests. Instantly
 * reversible either direction, same "one row, caller's own writes replace it"
 * model setMemberInterests uses.
 */
export async function setHelperAvailability(
  platform: Platform,
  userId: string,
  available: boolean,
): Promise<SetHelperAvailabilityResult> {
  const { rowCount } = await pool.query(
    `UPDATE member_interests SET willing_to_help = $3 WHERE platform = $1 AND user_id = $2`,
    [platform, userId, available],
  );
  return (rowCount ?? 0) > 0 ? { ok: true } : { ok: false, reason: 'no_interests_row' };
}

/**
 * True if `platform`/`userId` has hit FIND_HELPER_REQUESTER_DAILY_LIMIT
 * successful find_helper handoffs (rows where they're the requester) in the
 * trailing 24h — a call that finds no eligible helper writes no row, so it
 * doesn't count against this cap. Checked BEFORE matching runs (issue #729 AC
 * #6), same DB-backed COUNT(*) shape as createKnowledgeTip's rate cap rather
 * than an in-memory counter.
 */
export async function isFindHelperRequesterAtDailyCap(platform: Platform, userId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT count(*) AS n FROM helper_notifications
      WHERE requester_platform = $1 AND requester_user_id = $2
        AND created_at > now() - interval '24 hours'`,
    [platform, userId],
  );
  return Number(rows[0]?.n ?? 0) >= FIND_HELPER_REQUESTER_DAILY_LIMIT;
}

export interface HelperCandidate {
  platform: Platform;
  userId: string;
}

/**
 * find_helper's match query — searchMemberInterests' exact shape (embedding-
 * similarity over member_interests, embedding IS NOT NULL), additionally
 * filtered to willing_to_help = true and excluding the requester's own row
 * (SECURITY: issue #729 — self-matching must be impossible even when the
 * requester has willing_to_help = true for their own row). Returns bare
 * candidate identities only, ranked best-first — never the interests text,
 * since the requester's tool result must never see it (that stays
 * who_is_into-only, and even there only for a caller who searches themselves).
 */
export async function findHelperCandidates(
  topic: string,
  excludePlatform: Platform,
  excludeUserId: string,
  limit = FIND_HELPER_CANDIDATE_SCAN_LIMIT,
): Promise<HelperCandidate[]> {
  let queryVec: number[];
  try {
    queryVec = await embed(topic);
  } catch (err) {
    logger.warn({ err }, 'Embedding failed for find_helper topic');
    return [];
  }
  const { rows } = await pool.query(
    `SELECT platform, user_id
       FROM member_interests
      WHERE willing_to_help = true AND embedding IS NOT NULL
        AND NOT (platform = $2 AND user_id = $3)
        AND 1 - (embedding <=> $1) >= $5
      ORDER BY embedding <=> $1
      LIMIT $4`,
    [pgvector.toSql(queryVec), excludePlatform, excludeUserId, limit, FIND_HELPER_RELEVANCE_THRESHOLD],
  );
  return rows.map((r) => ({ platform: r.platform as Platform, userId: r.user_id }));
}

/**
 * Count of successful find_helper connections (`helper_notifications` rows —
 * one per DM actually sent) since `since` — issue #820's admin-digest
 * flywheel-throughput signal, the third dimension #797 established with
 * `countAcceptedKnowledgeCandidatesSince`/`countProjectsSharedSince` but never
 * covered: the one flywheel action that actively connects two members rather
 * than contributing content. Mirrors those two functions' exact shape.
 */
export async function countHelperMatchesSince(since: Date): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM helper_notifications WHERE created_at > $1`,
    [since],
  );
  return Number(rows[0].n);
}

/**
 * Atomically claims one notification slot for a candidate helper if they're
 * under FIND_HELPER_WEEKLY_LIMIT_PER_HELPER in the trailing 7 days — same
 * `WITH recent AS (...)` restart-proof pattern as createKnowledgeTip, never
 * an in-memory counter (issue #729 SECURITY criterion: pinned by a test that
 * seeds helper_notifications rows directly). Returns false (no row inserted,
 * no DM should be sent) when the helper is already at cap, so the caller can
 * move on to the next candidate; true means this row IS the one-and-only
 * notification for this find_helper call and the caller should now send the DM.
 */
export async function recordHelperNotificationIfUnderCap(
  helperPlatform: Platform,
  helperUserId: string,
  requesterPlatform: Platform,
  requesterUserId: string,
  topic: string,
): Promise<boolean> {
  const { rows } = await pool.query(
    `WITH recent AS (
       SELECT count(*) AS n FROM helper_notifications
        WHERE helper_platform = $1 AND helper_user_id = $2
          AND created_at > now() - interval '7 days'
     )
     INSERT INTO helper_notifications
       (helper_platform, helper_user_id, requester_platform, requester_user_id, topic)
     SELECT $1, $2, $3, $4, $5
      WHERE (SELECT n FROM recent) < $6
     RETURNING id`,
    [
      helperPlatform,
      helperUserId,
      requesterPlatform,
      requesterUserId,
      topic,
      FIND_HELPER_WEEKLY_LIMIT_PER_HELPER,
    ],
  );
  return rows.length > 0;
}
