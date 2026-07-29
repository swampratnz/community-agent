import pgvector from 'pgvector/pg';
import type { Platform, Tier } from '../../platforms/types.js';
import { logger } from '../../logger.js';
import { pool } from '../db.js';
import { embed } from '../embeddings.js';
import { KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD } from './shared.js';

/**
 * The knowledge base: entries, their embeddings, semantic + lexical search,
 * staleness/provenance bookkeeping, and the duplicate/conflict guards. The
 * largest single domain in repository.ts and the one the agent's
 * `knowledge_search` reads through.
 *
 * Extracted verbatim from repository.ts (see its header for why the split
 * exists); `repository.ts` re-exports everything here, so every existing import
 * site is unchanged.
 */

// --- Knowledge -------------------------------------------------------------

/**
 * Higher than QUESTION_CLUSTER_SIMILARITY_THRESHOLD (0.85, used to cluster
 * interactions): a missed duplicate nudge here is only a minor inconvenience,
 * but a false one is noise on every admin save, so we require a tighter match.
 */
export const KNOWLEDGE_DUPLICATE_SIMILARITY_THRESHOLD = 0.92;

export interface KnowledgeDuplicateMatch {
  id: number;
  title: string | null;
  content: string;
  similarity: number;
}

/**
 * Shared near-duplicate lookup used by both `saveKnowledge` and
 * `updateKnowledge` (issue #584) — the one place the 0.92 threshold and the
 * `ORDER BY embedding <=> $1` query are written, so the two write paths can
 * never drift apart. `excludeId` lets `updateKnowledge` exclude the entry
 * being edited from its own candidate set (it would otherwise always match
 * itself at ~1.0 similarity).
 */
async function findNearDuplicateKnowledge(
  scope: string,
  embedding: number[],
  excludeId?: number,
): Promise<KnowledgeDuplicateMatch | undefined> {
  const vec = pgvector.toSql(embedding);
  const { rows: matches } = await pool.query(
    `SELECT id, title, content, 1 - (embedding <=> $1) AS similarity
       FROM knowledge
      WHERE scope = $2 AND embedding IS NOT NULL ${excludeId !== undefined ? 'AND id != $3' : ''}
      ORDER BY embedding <=> $1
      LIMIT 1`,
    excludeId !== undefined ? [vec, scope, excludeId] : [vec, scope],
  );
  const top = matches[0];
  if (top && Number(top.similarity) >= KNOWLEDGE_DUPLICATE_SIMILARITY_THRESHOLD) {
    return {
      id: Number(top.id),
      title: top.title,
      content: top.content,
      similarity: Number(top.similarity),
    };
  }
  return undefined;
}

/**
 * Machine-ingestion provenance stored in `knowledge.created_by_role` alongside
 * the human RBAC tiers. 'auto' = daily web-research (quarantined untrusted at
 * retrieval); 'docs' = official Anthropic docs backfill (trusted, verbatim).
 * No model-facing tool can set these — `save_knowledge` always passes the
 * caller's `Tier`, so only internal ingestion code writes them.
 */
export type KnowledgeProvenance = 'auto' | 'docs';

export async function saveKnowledge(input: {
  content: string;
  title?: string;
  scope?: string;
  sourceUserId?: string;
  // Machine-ingested provenance markers on top of the human RBAC tiers:
  //  - 'auto': daily web-research (quarantined as untrusted at retrieval).
  //  - 'docs': official Anthropic docs backfill (trusted — served verbatim).
  // See searchKnowledge / knowledge_search for how these are treated.
  createdByRole?: Tier | KnowledgeProvenance;
  // Optional citation (issue #214): docs-ingest passes the page it ingested;
  // admin-tier save_knowledge/accept_knowledge_candidate calls may set these
  // explicitly. Only ever reached through those two paths — never derived
  // from message content. verified_at is set to now() whenever sourceUrl is
  // given, otherwise left null.
  sourceUrl?: string;
  sourceTitle?: string;
  // The saving admin's own platform (issue #422) — used only to scope
  // automatic knowledge-gap resolution below when `scope` is a conversation
  // id (see resolveKnowledgeGaps); never stored on the knowledge row itself.
  callerPlatform?: Platform;
}): Promise<{ id: number; similarEntry?: KnowledgeDuplicateMatch }> {
  const scope = input.scope ?? 'global';
  let embedding: number[] | null = null;
  try {
    embedding = await embed(input.title ? `${input.title}\n${input.content}` : input.content);
  } catch (err) {
    logger.warn({ err }, 'Embedding failed for knowledge entry');
  }

  const similarEntry = embedding ? await findNearDuplicateKnowledge(scope, embedding) : undefined;

  const createdByRole = input.createdByRole ?? 'admin';
  const { rows } = await pool.query(
    `INSERT INTO knowledge (scope, title, content, source_user_id, created_by_role, embedding, source_url, source_title, verified_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $7::text IS NOT NULL THEN now() ELSE NULL END) RETURNING id`,
    [
      scope,
      input.title ?? null,
      input.content,
      input.sourceUserId ?? null,
      createdByRole,
      embedding ? pgvector.toSql(embedding) : null,
      input.sourceUrl ?? null,
      input.sourceTitle ?? null,
    ],
  );

  // SECURITY: never resolve gaps off unreviewed 'auto' web-research content
  // (quarantined/untrusted at retrieval) — only a human-authored entry or a
  // trusted 'docs' backfill may silently clear the "never confidently
  // answered" signal. See resolveKnowledgeGaps.
  if (embedding && createdByRole !== 'auto') {
    try {
      await resolveKnowledgeGaps(scope, embedding, input.callerPlatform ?? null);
    } catch (err) {
      logger.warn({ err }, 'Knowledge-gap resolution failed for new entry');
    }
  }

  return { id: Number(rows[0].id), similarEntry };
}

/**
 * Mark unresolved `knowledge_gaps` rows resolved when `embedding` (the
 * vector `saveKnowledge`/`updateKnowledge` already computed for their write)
 * now clears `KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD` against a gap's stored
 * query embedding — the accept-gap curation loop issue #422 closes (#213's
 * review named this sliver; #246 shipped the other one). This is the exact
 * inverse of `recordKnowledgeGap`'s recording rule, so it's internally
 * consistent by construction: a future identical query would no longer
 * record a gap, so it's safe to mark the standing one resolved now.
 *
 * Scope filter mirrors `searchKnowledge`'s visibility model, but inverted
 * (which gaps can *this entry* now answer, vs. which entries can *this
 * caller* see) and, for the conversation-scoped case, deliberately
 * *narrower*: `searchKnowledge` matches `scope = conversationId` alone
 * (SECURITY: cross-platform conversation-id collisions are already
 * mitigated in practice by non-overlapping id shapes there, but the resolve
 * path can't rely on "probably fine" for an automatic write). So here a
 * conversation-scoped entry (`scope` not `'global'` and not a `Platform`
 * literal) only resolves gaps on `callerPlatform` — never cross-platform,
 * even if a conversation id string happened to collide across platforms.
 * `callerPlatform` is unused (and the conversation-scoped branch matches
 * nothing) for a `'global'`- or platform-scoped entry.
 *
 * SECURITY: callers gate this on `createdByRole !== 'auto'` before invoking
 * it (see saveKnowledge/updateKnowledge) — unreviewed 'auto' web-research
 * content is quarantined/untrusted at retrieval and must never silently
 * clear the "never confidently (human-)answered" signal `list_knowledge_gaps`
 * / the digest count depend on. A trusted 'docs' backfill or a human-authored
 * entry (any RBAC `Tier`) may resolve gaps; this function itself has no
 * opinion on provenance, so that check MUST happen before it is called.
 *
 * Known conservative approximation: this checks raw cosine similarity against
 * the gap's floor, not whether the new/edited entry would actually rank in
 * `searchKnowledge`'s top-`topK` (default 5) for that historical query. If
 * 5+ other entries already outscore it, a real future search still wouldn't
 * surface this entry, yet the gap is marked resolved here anyway. Low
 * severity at typical KB sizes; not worth the extra query per gap to fix.
 *
 * Non-blocking: callers must swallow failures themselves — a resolution
 * error must never block the save/update it rides on, same convention
 * `recordKnowledgeGap` already uses for the record side.
 */
async function resolveKnowledgeGaps(
  scope: string,
  embedding: number[],
  callerPlatform: Platform | null,
): Promise<void> {
  await pool.query(
    `UPDATE knowledge_gaps
        SET resolved_at = now()
      WHERE resolved_at IS NULL
        AND embedding IS NOT NULL
        AND (
          $1 = 'global'
          OR platform = $1
          OR (platform = $2 AND conversation_id = $1)
        )
        AND 1 - (embedding <=> $3) >= $4`,
    [scope, callerPlatform, pgvector.toSql(embedding), KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD],
  );
}

/**
 * Semantic search over curated knowledge, scoped to what `caller` may see:
 * `'global'` entries, entries scoped to the caller's platform, and entries
 * scoped to the caller's exact conversation (SECURITY: issue #106 — `scope`
 * used to be write-only metadata; an admin who saved a conversation-scoped
 * entry had it recite to every tier, everywhere). `list_knowledge` (admin
 * browse) deliberately keeps its own unrestricted-by-default behaviour —
 * that's a curation view, not member-facing recall.
 *
 * `opts.scopeRestriction: 'global-only'` (issue #165) narrows the filter to
 * `scope = 'global'` only, ignoring `caller` entirely — for the gated-guest
 * knowledge shortcut, where a guest has no meaningful conversation scope and
 * must never be served a platform- or conversation-scoped entry that may
 * assume member context.
 */
export interface KnowledgeSearchHit {
  id: number;
  title: string | null;
  content: string;
  similarity: number;
  updatedAt: Date;
  /** True for machine-researched entries (created_by_role='auto') — quarantined at retrieval. */
  autoGenerated: boolean;
  /** Optional citation (issue #214) — null unless docs-ingest or an admin save/update set one. */
  sourceUrl: string | null;
  sourceTitle: string | null;
  /** When the citation was (re-)confirmed; null if no source_url has ever been set. */
  verifiedAt: Date | null;
  lastRetrievedAt: Date | null;
  /** Weekly link-rot checker's verdict (issue #448); null means never checked. */
  sourceUnreachable: boolean | null;
  sourceCheckedAt: Date | null;
}

export async function searchKnowledge(
  query: string,
  caller: { platform: Platform; conversationId: string },
  topK = 5,
  opts: { scopeRestriction?: 'global-only' } = {},
): Promise<KnowledgeSearchHit[]> {
  let queryVec: number[];
  try {
    queryVec = await embed(query);
  } catch (err) {
    logger.warn({ err }, 'Embedding query failed; skipping knowledge search');
    return [];
  }
  const globalOnly = opts.scopeRestriction === 'global-only';
  const { rows } = await pool.query(
    globalOnly
      ? `SELECT id, title, content, created_by_role, updated_at, source_url, source_title, verified_at, last_retrieved_at,
                source_unreachable, source_checked_at,
                1 - (embedding <=> $1) AS similarity
           FROM knowledge
          WHERE embedding IS NOT NULL
            AND scope = 'global'
          ORDER BY embedding <=> $1
          LIMIT $2`
      : `SELECT id, title, content, created_by_role, updated_at, source_url, source_title, verified_at, last_retrieved_at,
                source_unreachable, source_checked_at,
                1 - (embedding <=> $1) AS similarity
           FROM knowledge
          WHERE embedding IS NOT NULL
            AND scope IN ('global', $2, $3)
          ORDER BY embedding <=> $1
          LIMIT $4`,
    globalOnly
      ? [pgvector.toSql(queryVec), topK]
      : [pgvector.toSql(queryVec), caller.platform, caller.conversationId, topK],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    title: r.title,
    content: r.content,
    similarity: Number(r.similarity),
    updatedAt: r.updated_at,
    autoGenerated: r.created_by_role === 'auto',
    sourceUrl: r.source_url,
    sourceTitle: r.source_title,
    verifiedAt: r.verified_at,
    lastRetrievedAt: r.last_retrieved_at,
    sourceUnreachable: r.source_unreachable,
    sourceCheckedAt: r.source_checked_at,
  }));
}

/**
 * Threshold for `searchKnowledgeLexical`'s `word_similarity()` score (0-1,
 * pg_trgm's own conventional default). A code constant, not env-configurable,
 * matching how `KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD` /
 * `KNOWLEDGE_DUPLICATE_SIMILARITY_THRESHOLD` / `KNOWLEDGE_TIE_MARGIN` are
 * already done in this codebase. This is a distinct similarity space from
 * `KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD` (cosine similarity of dense sentence
 * embeddings) — the two are never compared against each other.
 */
export const KNOWLEDGE_TRIGRAM_THRESHOLD = 0.3;

/**
 * Lexical fallback for `knowledge_search`'s semantic-miss path (issue #362):
 * a zero-model-cost, SQL-only substring match for the input class dense
 * sentence embeddings represent least reliably — short, rare,
 * SNAKE_CASE/camelCase identifiers and error codes copied verbatim from a
 * doc, log, or another member's message. Reuses `searchKnowledge`'s exact
 * scope filtering (SECURITY: same `scope IN ('global', platform,
 * conversationId)` / `global-only` behaviour, same params) so it can never
 * surface an entry the semantic path couldn't already return to the same
 * caller — only the ranking function differs.
 *
 * Uses `word_similarity(query, text)` rather than symmetric `similarity()`:
 * `similarity()` scores the two strings' *overall* trigram overlap, which
 * collapses toward zero for a short query against a realistic multi-sentence
 * entry (the intersection is tiny relative to the union); `word_similarity`
 * instead finds the best-matching *extent* of words within `text` and scores
 * that against `query`, which is what "does this literal string appear
 * inside this longer text" actually needs. `title` is nullable, so both the
 * query here and the `knowledge_trgm_idx` index expression it can use must
 * `COALESCE(title, '')` — a raw `title || ' ' || content` is NULL (and so
 * silently never matches) for every null-titled entry.
 */
export async function searchKnowledgeLexical(
  query: string,
  caller: { platform: Platform; conversationId: string },
  topK = 5,
  opts: { scopeRestriction?: 'global-only' } = {},
): Promise<KnowledgeSearchHit[]> {
  const globalOnly = opts.scopeRestriction === 'global-only';
  const { rows } = await pool.query(
    globalOnly
      ? `SELECT id, title, content, created_by_role, updated_at, source_url, source_title, verified_at, last_retrieved_at,
                source_unreachable, source_checked_at,
                word_similarity($1, COALESCE(title, '') || ' ' || content) AS similarity
           FROM knowledge
          WHERE scope = 'global'
            AND word_similarity($1, COALESCE(title, '') || ' ' || content) >= $2
          ORDER BY similarity DESC
          LIMIT $3`
      : `SELECT id, title, content, created_by_role, updated_at, source_url, source_title, verified_at, last_retrieved_at,
                source_unreachable, source_checked_at,
                word_similarity($1, COALESCE(title, '') || ' ' || content) AS similarity
           FROM knowledge
          WHERE scope IN ('global', $2, $3)
            AND word_similarity($1, COALESCE(title, '') || ' ' || content) >= $4
          ORDER BY similarity DESC
          LIMIT $5`,
    globalOnly
      ? [query, KNOWLEDGE_TRIGRAM_THRESHOLD, topK]
      : [query, caller.platform, caller.conversationId, KNOWLEDGE_TRIGRAM_THRESHOLD, topK],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    title: r.title,
    content: r.content,
    similarity: Number(r.similarity),
    updatedAt: r.updated_at,
    autoGenerated: r.created_by_role === 'auto',
    sourceUrl: r.source_url,
    sourceTitle: r.source_title,
    verifiedAt: r.verified_at,
    lastRetrievedAt: r.last_retrieved_at,
    sourceUnreachable: r.source_unreachable,
    sourceCheckedAt: r.source_checked_at,
  }));
}

/**
 * Whether a knowledge entry counts as stale for the member-facing "may be
 * outdated" nudge (issue #214) — reuses `countStaleKnowledge`'s exact
 * "neither edited nor retrieved recently" definition so the codebase has one
 * staleness concept, not two. `staleDays` is `config.adminDigest
 * .knowledgeStaleDays`; 0 means the feature is off (never stale).
 *
 * `maxAgeDays` (issue #380, `config.adminDigest.knowledgeStaleMaxAgeDays`) is
 * an additive, OR-ed absolute content-age ceiling that fires off `updatedAt`
 * alone, deliberately ignoring `lastRetrievedAt` — a popular entry's
 * `last_retrieved_at` otherwise resets `staleDays`'s clock on every hit,
 * making the entries with the most reach the ones this predicate is
 * structurally blindest to. 0 means the ceiling is off (never fires),
 * matching `staleDays`'s own convention, so with both 0 this is
 * byte-identical to the pre-#380 behaviour.
 */
export function isKnowledgeStale(
  entry: { updatedAt: Date; lastRetrievedAt: Date | null },
  staleDays: number,
  maxAgeDays = 0,
): boolean {
  if (staleDays > 0) {
    const lastTouched = Math.max(entry.updatedAt.getTime(), entry.lastRetrievedAt?.getTime() ?? 0);
    if (Date.now() - lastTouched >= staleDays * 86_400_000) return true;
  }
  return maxAgeDays > 0 && Date.now() - entry.updatedAt.getTime() >= maxAgeDays * 86_400_000;
}

/**
 * Record that `ids` were surfaced as relevant `knowledge_search` hits.
 * Fire-and-forget from the tool handler (issue #134) — callers must swallow
 * failures themselves, same as `notifySuggestionResolved`, so a counter-write
 * error never delays or fails a member's search. Deliberately only touches
 * retrieval_count/last_retrieved_at: see the schema comment on those columns
 * for why this must not bump `updated_at`.
 */
export async function recordKnowledgeRetrieval(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    `UPDATE knowledge
        SET retrieval_count = retrieval_count + 1, last_retrieved_at = now()
      WHERE id = ANY($1::bigint[])`,
    [ids],
  );
}

export interface KnowledgeEntry {
  id: number;
  scope: string;
  title: string | null;
  content: string;
  createdByRole: string;
  updatedAt: Date;
  retrievalCount: number;
  lastRetrievedAt: Date | null;
  sourceUrl: string | null;
  sourceTitle: string | null;
  verifiedAt: Date | null;
  /** Link-rot check result (issue #448) — null means never checked (or no sourceUrl). */
  sourceUnreachable: boolean | null;
  sourceCheckedAt: Date | null;
}

/**
 * Browse knowledge entries directly (as opposed to semantic search),
 * optionally filtered by scope. `staleOnly` (issue #280) reuses
 * `countStaleKnowledge`'s exact `GREATEST(updated_at,
 * COALESCE(last_retrieved_at, updated_at))` predicate against `staleDays`
 * (the caller passes `config.adminDigest.knowledgeStaleDays` — 0 means the
 * feature is off, and callers are expected to short-circuit before reaching
 * here in that case, same as `countStaleKnowledge`'s callers do), composed
 * with `scope` via AND, and orders by that same expression ASC (most-overdue
 * first) instead of the default `updated_at DESC` — the point of the filter
 * is triaging a backlog, so the worst offender comes first.
 * `provenance` (issue #294) filters to entries whose `created_by_role`
 * equals the given value, composed with `scope`/`staleOnly` via AND, same
 * combinable-filter pattern as `staleOnly`.
 *
 * `staleMaxAgeDays` (issue #380) is the same additive, OR-ed absolute
 * content-age ceiling as `isKnowledgeStale`'s `maxAgeDays` — composed with
 * `staleDays` inside `staleOnly`'s own predicate, not a separate filter.
 * Unset/0 = disabled, so `staleOnly` alone is byte-identical to pre-#380.
 *
 * `sourceUnreachable` (issue #448) filters to entries the weekly link-rot
 * checker flagged `source_unreachable = true`, composed with the other
 * filters via AND, same combinable-filter pattern as `staleOnly`/
 * `provenance`. Structurally admin-gated the same way as `staleOnly` — this
 * function has no caller/tier concept of its own; `list_knowledge` (the only
 * caller) is admin-tier gated in full via `assertAtLeast`.
 */
export async function listKnowledge(
  input: {
    scope?: string;
    limit?: number;
    offset?: number;
    staleOnly?: boolean;
    staleDays?: number;
    staleMaxAgeDays?: number;
    provenance?: string;
    sourceUnreachable?: boolean;
  } = {},
): Promise<KnowledgeEntry[]> {
  const params: unknown[] = [];
  const clauses: string[] = [];
  if (input.scope) {
    params.push(input.scope);
    clauses.push(`scope = $${params.length}`);
  }
  if (input.provenance) {
    params.push(input.provenance);
    clauses.push(`created_by_role = $${params.length}`);
  }
  if (input.sourceUnreachable) {
    clauses.push(`source_unreachable = true`);
  }
  if (input.staleOnly) {
    params.push(input.staleDays ?? 0);
    const staleDaysParam = params.length;
    params.push(input.staleMaxAgeDays ?? 0);
    const maxAgeDaysParam = params.length;
    clauses.push(
      `(($${staleDaysParam} > 0 AND GREATEST(updated_at, COALESCE(last_retrieved_at, updated_at)) < now() - ($${staleDaysParam} || ' days')::interval)` +
        ` OR ($${maxAgeDaysParam} > 0 AND updated_at < now() - ($${maxAgeDaysParam} || ' days')::interval))`,
    );
  }
  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  // "Most overdue first" must track whichever staleness criterion is active. When
  // the content-age ceiling is on (#380), rank by `updated_at` (content age) so a
  // genuinely-old entry surfaces first even if it's popular — sorting by
  // GREATEST(updated_at, last_retrieved_at) would push a frequently-served but
  // stale-content entry to "least urgent", the exact blind spot the ceiling
  // exists to close. Window-only (`staleDays` alone) keeps longest-untouched
  // (edit OR retrieval) first.
  const orderClause = !input.staleOnly
    ? `ORDER BY updated_at DESC`
    : (input.staleMaxAgeDays ?? 0) > 0
      ? `ORDER BY updated_at ASC`
      : `ORDER BY GREATEST(updated_at, COALESCE(last_retrieved_at, updated_at)) ASC`;
  params.push(input.limit ?? 20);
  const limitParam = params.length;
  params.push(input.offset ?? 0);
  const { rows } = await pool.query(
    `SELECT id, scope, title, content, created_by_role, updated_at, retrieval_count, last_retrieved_at,
            source_url, source_title, verified_at, source_unreachable, source_checked_at
       FROM knowledge
       ${whereClause}
      ${orderClause}
      LIMIT $${limitParam} OFFSET $${params.length}`,
    params,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    scope: r.scope,
    title: r.title,
    content: r.content,
    createdByRole: r.created_by_role,
    updatedAt: r.updated_at,
    retrievalCount: Number(r.retrieval_count),
    lastRetrievedAt: r.last_retrieved_at,
    sourceUrl: r.source_url,
    sourceTitle: r.source_title,
    verifiedAt: r.verified_at,
    sourceUnreachable: r.source_unreachable,
    sourceCheckedAt: r.source_checked_at,
  }));
}

export interface KnowledgeTopicsResult {
  titles: string[];
  totalCount: number;
}

/**
 * Titles-only browse of the knowledge base for the member-facing
 * `list_knowledge_topics` tool (issue #437) — the missing proactive "what's
 * covered" counterpart to `knowledge_search`'s reactive search. Reuses
 * `searchKnowledge`/`searchKnowledgeLexical`'s exact scope predicate
 * (`scope IN ('global', platform, conversationId)`) so a member never sees a
 * title from a scope they couldn't already reach via `knowledge_search`, plus
 * the issue #214 apparent-authority boundary (`created_by_role != 'auto'`) —
 * a quarantined auto-researched entry can't gain apparent authority by
 * appearing in an official-looking topic index. Null and blank titles are
 * excluded (some conversation-scoped entries have none, same
 * `COALESCE(title, '')` case `searchKnowledgeLexical` already works around).
 *
 * `COUNT(*) OVER()` returns the full match count alongside the `LIMIT`ed page
 * in one round trip, so a caller can render an exact "+N more" truncation
 * note without a second query — keeping this the single deterministic SELECT
 * the proposal's cost story promises.
 */
export async function listKnowledgeTopics(
  caller: { platform: Platform; conversationId: string },
  limit: number,
): Promise<KnowledgeTopicsResult> {
  const { rows } = await pool.query(
    `SELECT title, COUNT(*) OVER() AS total_count
       FROM knowledge
      WHERE scope IN ('global', $1, $2)
        AND created_by_role != 'auto'
        AND title IS NOT NULL
        AND trim(title) != ''
      ORDER BY title
      LIMIT $3`,
    [caller.platform, caller.conversationId, limit],
  );
  return {
    titles: rows.map((r) => r.title as string),
    totalCount: rows.length > 0 ? Number(rows[0].total_count) : 0,
  };
}

/**
 * Exact count of knowledge entries untouched — neither edited nor retrieved —
 * in the last `days` (issue #199). `GREATEST(updated_at,
 * COALESCE(last_retrieved_at, updated_at))` takes whichever of the two
 * signals is more recent: an entry never retrieved falls back to its edit
 * time, and one edited after its last retrieval is judged by that edit, not
 * a stale `last_retrieved_at`. A plain `COALESCE` alone would get this
 * second case backwards (it'd prefer a non-null but older
 * `last_retrieved_at` over a fresh edit). Guild-wide, matching
 * `countAccessRequests`/`countPendingSuggestions` — knowledge entries carry
 * no conversation scope for `list_knowledge` to restrict by either.
 *
 * `maxAgeDays` (issue #380) is the same additive, OR-ed absolute content-age
 * ceiling as `isKnowledgeStale`'s — an entry whose `updated_at` alone exceeds
 * it counts as stale regardless of `days`/`last_retrieved_at`. Unset/0 =
 * disabled, so with the default this is byte-identical to pre-#380.
 */
export async function countStaleKnowledge(days: number, maxAgeDays = 0): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*) AS n
       FROM knowledge
      WHERE ($1 > 0 AND GREATEST(updated_at, COALESCE(last_retrieved_at, updated_at)) < now() - ($1 || ' days')::interval)
         OR ($2 > 0 AND updated_at < now() - ($2 || ' days')::interval)`,
    [days, maxAgeDays],
  );
  return Number(rows[0].n);
}

/**
 * Every knowledge entry carrying a `sourceUrl`, for the weekly link-rot
 * checker (issue #448) to sweep. `sourceUrl` is admin-authored only (set via
 * save_knowledge/update_knowledge/docs-ingest) — not a new untrusted-input
 * surface. Guild-wide, unscoped, matching the checker's own job scope.
 */
export async function listKnowledgeSourceUrls(): Promise<Array<{ id: number; sourceUrl: string }>> {
  const { rows } = await pool.query(
    `SELECT id, source_url FROM knowledge WHERE source_url IS NOT NULL ORDER BY id`,
  );
  return rows.map((r) => ({ id: Number(r.id), sourceUrl: r.source_url }));
}

/**
 * Persist one entry's link-rot check result (issue #448). Deliberately NOT
 * routed through the `knowledge_set_updated_at` trigger's column list (see
 * the schema comment on `source_unreachable`/`source_checked_at`) — a
 * reachability check is not a content edit.
 */
export async function recordKnowledgeSourceCheck(id: number, unreachable: boolean): Promise<void> {
  await pool.query(`UPDATE knowledge SET source_unreachable = $2, source_checked_at = now() WHERE id = $1`, [
    id,
    unreachable,
  ]);
}

/** Freshness watermark for the checker's ~weekly scheduler guard (issue #448). */
export async function latestKnowledgeSourceCheckAt(): Promise<Date | null> {
  const { rows } = await pool.query(`SELECT max(source_checked_at) AS latest FROM knowledge`);
  return rows[0]?.latest ?? null;
}

/**
 * Exact count of knowledge entries the weekly link-rot checker (issue #448)
 * flagged unreachable, for the admin digest fold-in (issue #624) —
 * `countStaleKnowledge`'s exact `COUNT(*)` shape. Counts only
 * `source_unreachable = true` rows, independent of any given row's
 * staleness/rating/duplicate/candidate status, so it can never cross-
 * contaminate the other digest counts. Guild-wide, unscoped, matching
 * `list_knowledge`'s own unscoped `sourceUnreachable` filter this mirrors.
 */
export async function countUnreachableSourceKnowledge(): Promise<number> {
  const { rows } = await pool.query(`SELECT count(*) AS n FROM knowledge WHERE source_unreachable = true`);
  return Number(rows[0].n);
}

/**
 * Update a knowledge entry's title/content/scope and re-embed. Returns false
 * if no row matched. `sourceUrl`/`sourceTitle` (issue #214) follow the same
 * "undefined = leave unchanged" convention as title/content; supplying
 * either one re-verifies the citation (`verified_at` bumped to now()).
 */
export async function updateKnowledge(input: {
  id: number;
  title?: string;
  content?: string;
  scope?: string;
  sourceUrl?: string;
  sourceTitle?: string;
  // The editing admin's own platform (issue #422) — same use as
  // saveKnowledge's callerPlatform, only for scoping automatic
  // knowledge-gap resolution below; never stored on the knowledge row.
  callerPlatform?: Platform;
}): Promise<{ updated: boolean; similarEntry?: KnowledgeDuplicateMatch }> {
  const { rows: existingRows } = await pool.query(
    `SELECT title, content, scope, source_url, source_title, created_by_role FROM knowledge WHERE id = $1`,
    [input.id],
  );
  if (existingRows.length === 0) return { updated: false };

  const title = input.title !== undefined ? input.title : existingRows[0].title;
  const content = input.content !== undefined ? input.content : existingRows[0].content;
  const scope = input.scope !== undefined ? input.scope : existingRows[0].scope;
  const sourceUrl = input.sourceUrl !== undefined ? input.sourceUrl : existingRows[0].source_url;
  const sourceTitle = input.sourceTitle !== undefined ? input.sourceTitle : existingRows[0].source_title;
  const reVerify = input.sourceUrl !== undefined || input.sourceTitle !== undefined;

  let embedding: number[] | null = null;
  try {
    embedding = await embed(title ? `${title}\n${content}` : content);
  } catch (err) {
    logger.warn({ err }, 'Embedding failed for knowledge update');
  }

  // Same near-duplicate check saveKnowledge runs, excluding this entry from
  // its own candidate set (issue #584) — an ordinary curation edit that
  // converges this entry's wording onto another entry's topic otherwise
  // produces no signal until the weekly digest.
  const similarEntry = embedding ? await findNearDuplicateKnowledge(scope, embedding, input.id) : undefined;

  const { rowCount } = await pool.query(
    `UPDATE knowledge
        SET title = $2, content = $3, scope = COALESCE($4, scope), embedding = COALESCE($5, embedding),
            source_url = $6, source_title = $7,
            verified_at = CASE WHEN $8 THEN now() ELSE verified_at END
      WHERE id = $1`,
    [
      input.id,
      title ?? null,
      content,
      input.scope ?? null,
      embedding ? pgvector.toSql(embedding) : null,
      sourceUrl ?? null,
      sourceTitle ?? null,
      reVerify,
    ],
  );

  // SECURITY: same 'auto'-provenance exclusion as saveKnowledge — an entry's
  // created_by_role never changes here, so the pre-edit row's value is the
  // authoritative check.
  if (embedding && existingRows[0].created_by_role !== 'auto') {
    try {
      await resolveKnowledgeGaps(scope, embedding, input.callerPlatform ?? null);
    } catch (err) {
      logger.warn({ err }, 'Knowledge-gap resolution failed for edited entry');
    }
  }

  return { updated: (rowCount ?? 0) > 0, similarEntry };
}

/**
 * The current title/content of a knowledge entry (or null if none), so
 * `update_knowledge` can record the pre-edit text in its audit row — an
 * in-place overwrite otherwise leaves no way to see (or recover) what an
 * injected admin turn replaced.
 */
export async function getKnowledgeContentById(
  id: number,
): Promise<{ title: string | null; content: string } | null> {
  const { rows } = await pool.query(`SELECT title, content FROM knowledge WHERE id = $1`, [id]);
  return rows[0] ? { title: rows[0].title, content: rows[0].content } : null;
}

/** Delete a knowledge entry by id. Returns false if no row matched. */
export async function deleteKnowledge(id: number): Promise<boolean> {
  const { rowCount } = await pool.query(`DELETE FROM knowledge WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

/**
 * Consolidate a detected duplicate/conflict pair (issue #886) — the rung
 * `list_duplicate_knowledge`/`list_knowledge_conflicts` both name in their own
 * descriptions ("merge (update_knowledge) or retire (delete_knowledge)") but
 * that this codebase never implemented, leaving the two calls unlinked and
 * silently dropping the retired entry's retrieval_count/last_retrieved_at
 * history (issue #134's signal).
 *
 * Keeps `keepId`, folds `mergeId`'s usage history onto it, then deletes
 * `mergeId`. `title`/`content`/`scope` follow `updateKnowledge`'s own
 * "undefined = leave unchanged" convention — omitting all three re-embeds
 * nothing and leaves the survivor's wording byte-identical.
 *
 * Guards against a single bad id silently deleting the wrong entry with no
 * recovery path: `keepId === mergeId`, or either id not existing, fails with
 * no mutation. Runs as sequential queries, matching this file's existing
 * convention (no other function here wraps queries in an explicit
 * transaction) — a `mergeId` delete failing after the `keepId` count-fold is
 * a known, accepted (non-transactional) risk for this infrequent,
 * admin-invoked, non-security path.
 */
export async function mergeKnowledgeEntries(
  keepId: number,
  mergeId: number,
  input: { title?: string; content?: string; scope?: string } = {},
): Promise<{ merged: boolean; error?: string }> {
  if (keepId === mergeId) {
    return { merged: false, error: `keepId and mergeId must differ (both were #${keepId}).` };
  }

  const { rows } = await pool.query(
    `SELECT id, title, content, scope, retrieval_count, last_retrieved_at FROM knowledge WHERE id = ANY($1::bigint[])`,
    [[keepId, mergeId]],
  );
  const keep = rows.find((r) => Number(r.id) === keepId);
  const merge = rows.find((r) => Number(r.id) === mergeId);
  if (!keep) return { merged: false, error: `No knowledge entry with id ${keepId}.` };
  if (!merge) return { merged: false, error: `No knowledge entry with id ${mergeId}.` };

  const title = input.title !== undefined ? input.title : keep.title;
  const content = input.content !== undefined ? input.content : keep.content;
  const scope = input.scope !== undefined ? input.scope : keep.scope;

  let embedding: number[] | null = null;
  if (input.title !== undefined || input.content !== undefined) {
    try {
      embedding = await embed(title ? `${title}\n${content}` : content);
    } catch (err) {
      logger.warn({ err }, 'Embedding failed for knowledge merge');
    }
  }

  const retrievalCount = Number(keep.retrieval_count) + Number(merge.retrieval_count);

  await pool.query(
    `UPDATE knowledge
        SET title = $2, content = $3, scope = $4, embedding = COALESCE($5, embedding),
            retrieval_count = $6, last_retrieved_at = GREATEST($7::timestamptz, $8::timestamptz)
      WHERE id = $1`,
    [
      keepId,
      title ?? null,
      content,
      scope,
      embedding ? pgvector.toSql(embedding) : null,
      retrievalCount,
      keep.last_retrieved_at,
      merge.last_retrieved_at,
    ],
  );

  await pool.query(`DELETE FROM knowledge WHERE id = $1`, [mergeId]);

  return { merged: true };
}

export interface KnowledgeDuplicatePair {
  aId: number;
  aTitle: string | null;
  bId: number;
  bTitle: string | null;
  similarity: number;
}

/**
 * Retroactive audit (issue #316) for near-duplicate knowledge pairs that
 * `saveKnowledge`'s write-time nudge (KNOWLEDGE_DUPLICATE_SIMILARITY_THRESHOLD
 * above) never caught: entries that predate that check, or that converged
 * later via independent `updateKnowledge` edits. Same-scope only, same
 * threshold, same `<=>` operator — deliberately reuses #93's established
 * technique rather than inventing a new one. `a.id < b.id` both dedups each
 * pair to a single row (never A↔B and B↔A) and gives the self-join a stable
 * ordering to join on.
 */
export async function listDuplicateKnowledge(scope?: string, limit = 20): Promise<KnowledgeDuplicatePair[]> {
  const clampedLimit = Math.min(Math.max(Math.trunc(limit) || 20, 1), 100);
  const params: unknown[] = [scope ?? null, KNOWLEDGE_DUPLICATE_SIMILARITY_THRESHOLD];
  params.push(clampedLimit);
  const { rows } = await pool.query(
    `SELECT a.id AS a_id, a.title AS a_title,
            b.id AS b_id, b.title AS b_title,
            1 - (a.embedding <=> b.embedding) AS similarity
       FROM knowledge a
       JOIN knowledge b ON a.id < b.id AND a.scope = b.scope
      WHERE a.embedding IS NOT NULL AND b.embedding IS NOT NULL
        AND ($1::text IS NULL OR a.scope = $1)
        AND 1 - (a.embedding <=> b.embedding) >= $2
      ORDER BY similarity DESC
      LIMIT $3`,
    params,
  );
  return rows.map((r) => ({
    aId: Number(r.a_id),
    aTitle: r.a_title,
    bId: Number(r.b_id),
    bTitle: r.b_title,
    similarity: Number(r.similarity),
  }));
}

/**
 * Exact near-duplicate pair count (issue #378), for the weekly admin digest
 * — the growth path #316 itself named ("fold a 'N duplicate pairs pending
 * review' count into the weekly admin digest once the pull tool proves
 * useful"). A true `SELECT count(*)` over the identical self-join
 * `listDuplicateKnowledge` uses (same `a.id < b.id` same-scope join, same
 * `KNOWLEDGE_DUPLICATE_SIMILARITY_THRESHOLD` floor), never `.length` of that
 * function's `LIMIT`-bounded list, so a backlog past its default limit of 20
 * is not understated. Guild-wide when `scope` is omitted, matching
 * `listDuplicateKnowledge`'s own unscoped behaviour.
 */
export async function countDuplicateKnowledge(scope?: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*) AS n
       FROM knowledge a
       JOIN knowledge b ON a.id < b.id AND a.scope = b.scope
      WHERE a.embedding IS NOT NULL AND b.embedding IS NOT NULL
        AND ($1::text IS NULL OR a.scope = $1)
        AND 1 - (a.embedding <=> b.embedding) >= $2`,
    [scope ?? null, KNOWLEDGE_DUPLICATE_SIMILARITY_THRESHOLD],
  );
  return Number(rows[0].n);
}

/**
 * Half-open "conflict candidate" band (issue #330), sitting between the
 * retrieval relevance floor (KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD, 0.35) and
 * the near-duplicate threshold (KNOWLEDGE_DUPLICATE_SIMILARITY_THRESHOLD,
 * 0.92): two entries this similar are about the same topic but worded
 * differently enough that they might disagree, rather than being the same
 * fact said twice. MAX is bound to the near-duplicate threshold itself
 * (half-open, `< MAX`) so the two bands abut without overlap — a pair is
 * either a near-duplicate (>= MAX) or a conflict candidate ([MIN, MAX)),
 * never both.
 */
export const KNOWLEDGE_CONFLICT_SIMILARITY_MIN = 0.55;
export const KNOWLEDGE_CONFLICT_SIMILARITY_MAX = KNOWLEDGE_DUPLICATE_SIMILARITY_THRESHOLD;

export interface KnowledgeConflictPair {
  aId: number;
  aTitle: string | null;
  bId: number;
  bTitle: string | null;
  similarity: number;
}

/**
 * Read-only audit (issue #330) for "conflict candidate" pairs: same-scope
 * knowledge entries that both clear the relevance floor for some query but
 * sit well under the near-duplicate threshold — worded differently enough
 * that they might quietly disagree (e.g. one entry states a fact a newer,
 * unrelated-looking entry has since corrected). Mirrors listDuplicateKnowledge's
 * exact shape (same-scope `a.id < b.id` self-join, NULL-embedding rows
 * excluded, same limit clamp) but bounds similarity to the half-open
 * conflict band instead of the near-duplicate floor. Output is framed to
 * admins as *candidates to review*, not confirmed contradictions — the query
 * itself makes no judgement beyond relatedness.
 */
export async function listKnowledgeConflictCandidates(
  scope?: string,
  limit = 20,
): Promise<KnowledgeConflictPair[]> {
  const clampedLimit = Math.min(Math.max(Math.trunc(limit) || 20, 1), 100);
  const params: unknown[] = [
    scope ?? null,
    KNOWLEDGE_CONFLICT_SIMILARITY_MIN,
    KNOWLEDGE_CONFLICT_SIMILARITY_MAX,
    clampedLimit,
  ];
  const { rows } = await pool.query(
    `SELECT a.id AS a_id, a.title AS a_title,
            b.id AS b_id, b.title AS b_title,
            1 - (a.embedding <=> b.embedding) AS similarity
       FROM knowledge a
       JOIN knowledge b ON a.id < b.id AND a.scope = b.scope
      WHERE a.embedding IS NOT NULL AND b.embedding IS NOT NULL
        AND ($1::text IS NULL OR a.scope = $1)
        AND 1 - (a.embedding <=> b.embedding) >= $2
        AND 1 - (a.embedding <=> b.embedding) < $3
      ORDER BY similarity DESC
      LIMIT $4`,
    params,
  );
  return rows.map((r) => ({
    aId: Number(r.a_id),
    aTitle: r.a_title,
    bId: Number(r.b_id),
    bTitle: r.b_title,
    similarity: Number(r.similarity),
  }));
}

/**
 * Exact conflict-candidate pair count (issue #378), for the weekly admin
 * digest — the growth path #330 itself named ("fold a 'top conflict
 * candidate' line into the weekly admin digest... deliberately deferred so
 * this PR stays small and the band is proven useful via manual admin
 * invocation first"). A true `SELECT count(*)` over the identical self-join
 * `listKnowledgeConflictCandidates` uses (same `a.id < b.id` same-scope
 * join, same half-open `[KNOWLEDGE_CONFLICT_SIMILARITY_MIN,
 * KNOWLEDGE_CONFLICT_SIMILARITY_MAX)` band), never `.length` of that
 * function's `LIMIT`-bounded list, so a backlog past its default limit of 20
 * is not understated. Guild-wide when `scope` is omitted, matching
 * `listKnowledgeConflictCandidates`'s own unscoped behaviour.
 */
export async function countKnowledgeConflictCandidates(scope?: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*) AS n
       FROM knowledge a
       JOIN knowledge b ON a.id < b.id AND a.scope = b.scope
      WHERE a.embedding IS NOT NULL AND b.embedding IS NOT NULL
        AND ($1::text IS NULL OR a.scope = $1)
        AND 1 - (a.embedding <=> b.embedding) >= $2
        AND 1 - (a.embedding <=> b.embedding) < $3`,
    [scope ?? null, KNOWLEDGE_CONFLICT_SIMILARITY_MIN, KNOWLEDGE_CONFLICT_SIMILARITY_MAX],
  );
  return Number(rows[0].n);
}

/**
 * Live-path conflict check (issue #389) for the exact set of ids
 * `knowledge_search` is about to serve in one answer — the real-time
 * backstop for the gap #330 (pull-only admin audit) and #378 (weekly digest
 * count) both leave open between an entry being saved and an admin's next
 * audit pass. Same technique, band, NULL-embedding exclusion, AND same-scope
 * join predicate as `listKnowledgeConflictCandidates`/
 * `countKnowledgeConflictCandidates` (same `[KNOWLEDGE_CONFLICT_SIMILARITY_MIN,
 * KNOWLEDGE_CONFLICT_SIMILARITY_MAX)` half-open band, `1 - (a.embedding <=>
 * b.embedding)` measure, `a.id < b.id AND a.scope = b.scope` pairing), but
 * restricted to `a.id = ANY($1) AND b.id = ANY($1)` instead of a full-table
 * self-join, and `LIMIT 1` since the caller only needs a boolean, not the
 * pair(s) themselves.
 *
 * The `a.scope = b.scope` predicate is required here, not redundant:
 * `searchKnowledge` queries `WHERE scope IN ('global', platform,
 * conversationId)` in one call, so `ids` can span multiple scopes. A
 * conversation-specific override of a global/platform entry (an intended,
 * supported pattern per `save_knowledge`'s own scope docs) is typically
 * topically similar to the entry it supersedes and would otherwise be
 * misflagged as a conflict rather than recognised as a deliberate override
 * (review on #393).
 *
 * Short-circuits to `false` with zero SQL queries when `ids.length < 2` —
 * there is nothing to compare, and the caller (`knowledgeSearch` in
 * tools.ts) already gates on this, but the guard lives here too so this
 * function is safe to call directly without relying on that.
 */
export async function hasConflictAmongIds(ids: number[]): Promise<boolean> {
  if (ids.length < 2) return false;
  const { rows } = await pool.query(
    `SELECT 1
       FROM knowledge a
       JOIN knowledge b ON a.id < b.id AND a.scope = b.scope
      WHERE a.id = ANY($1) AND b.id = ANY($1)
        AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL
        AND 1 - (a.embedding <=> b.embedding) >= $2
        AND 1 - (a.embedding <=> b.embedding) < $3
      LIMIT 1`,
    [ids, KNOWLEDGE_CONFLICT_SIMILARITY_MIN, KNOWLEDGE_CONFLICT_SIMILARITY_MAX],
  );
  return rows.length > 0;
}

/**
 * Upsert a `global`-scoped knowledge entry keyed by exact title. Used by the
 * daily knowledge refresh (src/context/knowledgeRefresh.ts): each fixed topic
 * has a stable title, so this refreshes the SAME row every run rather than
 * accumulating duplicates. Updates the existing row's content (re-embedding via
 * `updateKnowledge`) or inserts a new one. Returns the id and whether it was
 * created. Deliberately global-scope only — the refresh never writes anywhere
 * else.
 */
export async function upsertGlobalKnowledgeByTitle(
  title: string,
  content: string,
): Promise<{ id: number; created: boolean } | 'title-taken-by-human'> {
  // Look at whatever already owns this (title, global) — including its
  // provenance. The quarantine model downstream (knowledge_search wrapping,
  // shortcut exclusion) keys off created_by_role='auto', so this write must
  // NEVER splice unreviewed research into a human-owned row, nor create a
  // colliding duplicate. The fixed titles are printed in docs/CHANGELOG and
  // visible via list_knowledge, so a human recreating one is a real path.
  const { rows } = await pool.query(
    `SELECT id, created_by_role FROM knowledge WHERE title = $1 AND scope = 'global' ORDER BY id LIMIT 1`,
    [title],
  );
  if (rows[0]) {
    if (rows[0].created_by_role !== 'auto') return 'title-taken-by-human';
    const id = Number(rows[0].id);
    await updateKnowledge({ id, content });
    return { id, created: false };
  }
  // 'auto' provenance flows to knowledge_search so the content is quarantined
  // (untrusted-wrapped) at retrieval — this is unreviewed, web-derived text.
  const saved = await saveKnowledge({ title, content, scope: 'global', createdByRole: 'auto' });
  return { id: saved.id, created: true };
}

/**
 * Most recent `updated_at` across knowledge entries whose title is in `titles`
 * — the daily knowledge refresh's freshness guard, so a redeploy (which
 * restarts the process) can't re-run the research within the same day. Null
 * when none of those entries exist yet (first ever run).
 */
export async function latestKnowledgeUpdateAt(titles: readonly string[]): Promise<Date | null> {
  if (titles.length === 0) return null;
  const { rows } = await pool.query(
    `SELECT max(updated_at) AS latest FROM knowledge WHERE scope = 'global' AND title = ANY($1)`,
    [[...titles]],
  );
  return rows[0]?.latest ?? null;
}

export type KnowledgeSyncOutcome = 'created' | 'updated' | 'unchanged' | 'title-taken-by-other';

/**
 * Idempotent, content-diffing upsert of one `global` knowledge chunk under a
 * machine-ingestion `provenance` (src/context/docsIngest.ts). Keyed by title:
 *  - existing row of the SAME provenance, identical content -> 'unchanged'
 *    (NO re-embed — this is what makes the ~weekly docs refresh cheap: only
 *    genuinely changed sections pay the embedding cost).
 *  - existing row of the SAME provenance, different content -> re-embed,'updated'.
 *  - existing row of a DIFFERENT provenance (human/other) -> 'title-taken-by-other',
 *    never overwritten (a human entry always wins its title).
 *  - no row -> insert with this provenance, 'created'.
 */
/**
 * `source` (issue #214) is the page docs-ingest derived the chunk from —
 * `url` populates `source_url` automatically; `title` (a human-readable label
 * distinct from the storage `title` dedup key) populates `source_title`.
 * Optional so other provenances/callers are unaffected.
 */
export async function syncGlobalKnowledgeByProvenance(
  title: string,
  content: string,
  provenance: KnowledgeProvenance,
  source?: { url: string; title?: string },
): Promise<KnowledgeSyncOutcome> {
  const { rows } = await pool.query(
    `SELECT id, content, created_by_role, source_url FROM knowledge WHERE title = $1 AND scope = 'global' ORDER BY id LIMIT 1`,
    [title],
  );
  if (rows[0]) {
    if (rows[0].created_by_role !== provenance) return 'title-taken-by-other';
    if (rows[0].content === content) {
      // Backfill the citation on a pre-existing row that predates this
      // feature (or was ingested before source became available) — metadata
      // only, so it deliberately bypasses updateKnowledge's re-embed and
      // never touches updated_at (source_url isn't a tracked column on the
      // update trigger, same exclusion as retrieval_count).
      if (source?.url && !rows[0].source_url) {
        await pool.query(
          `UPDATE knowledge SET source_url = $2, source_title = $3, verified_at = now() WHERE id = $1`,
          [rows[0].id, source.url, source.title ?? null],
        );
      }
      return 'unchanged';
    }
    await updateKnowledge({
      id: Number(rows[0].id),
      content,
      sourceUrl: source?.url,
      sourceTitle: source?.title,
    });
    return 'updated';
  }
  await saveKnowledge({
    title,
    content,
    scope: 'global',
    createdByRole: provenance,
    sourceUrl: source?.url,
    sourceTitle: source?.title,
  });
  return 'created';
}

/** Most recent `updated_at` across all `global` entries of a machine provenance — the ingest freshness guard (redeploy-safe). Null if none exist yet. */
export async function latestKnowledgeUpdateAtByProvenance(
  provenance: KnowledgeProvenance,
): Promise<Date | null> {
  const { rows } = await pool.query(
    `SELECT max(updated_at) AS latest FROM knowledge WHERE scope = 'global' AND created_by_role = $1`,
    [provenance],
  );
  return rows[0]?.latest ?? null;
}

/** All `global` knowledge titles written under a given machine provenance. */
export async function listGlobalKnowledgeTitlesByProvenance(
  provenance: KnowledgeProvenance,
): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT title FROM knowledge WHERE scope = 'global' AND created_by_role = $1 AND title IS NOT NULL`,
    [provenance],
  );
  return rows.map((r) => r.title as string);
}

/**
 * Delete the named `global` entries of the given provenance. Scoped by
 * provenance so it can never touch a human- or other-provenance row even if a
 * title collides. Returns the number removed. Used by docs ingest to prune the
 * chunks of pages that vanished from the upstream index (the caller computes the
 * doomed titles from the index, so a transient fetch failure can't cause a
 * deletion). No-op on an empty list.
 */
export async function deleteProvenancedKnowledgeByTitles(
  provenance: KnowledgeProvenance,
  titles: readonly string[],
): Promise<number> {
  if (titles.length === 0) return 0;
  const { rowCount } = await pool.query(
    `DELETE FROM knowledge WHERE scope = 'global' AND created_by_role = $1 AND title = ANY($2)`,
    [provenance, [...titles]],
  );
  return rowCount ?? 0;
}
