/**
 * Cross-cutting internals shared by repository.ts and its per-domain modules
 * under repository/. Lives in its own module so a domain module can use a
 * shared constant without importing repository.ts back (which would be a cycle,
 * since repository.ts re-exports the domain modules). repository.ts re-exports
 * everything here, so external import sites — including agent/tools.ts, which
 * imports this floor and re-exports it — are unchanged.
 */

import type { PoolClient } from 'pg';
import { pool } from '../db.js';

/**
 * A pool or a checked-out transaction client — anything that can run a query.
 * Functions take this so a caller inside a `BEGIN`/`COMMIT` can pass its client
 * and have the write land atomically with the rest of its transaction. Shared
 * here because both repository.ts and extracted domain modules use it.
 */
export type Queryable = Pick<PoolClient, 'query'>;

/**
 * Relevance floor for `knowledge_search` hits, in cosine similarity
 * (`1 - (embedding <=> query)`, same units as `searchKnowledge`'s returned
 * `similarity`). This is a *relevance* floor ("is this topically usable at
 * all"), not a *duplicate* floor like `QUESTION_CLUSTER_SIMILARITY_THRESHOLD`
 * below (0.85, "is this the same question") — it is deliberately much lower.
 *
 * The value is a function of the current embedding model
 * (`config.db.embeddingModel`, currently Xenova/all-MiniLM-L6-v2) and query
 * distribution, not a universal constant. It was derived empirically against
 * `tests/fixtures/knowledgeEval.json` (see the `negativeQueries` case in
 * knowledgeEval.test.ts): with this model, unambiguously off-topic queries
 * (e.g. "what's the best coffee place near the venue") score ~0.15-0.22
 * against every fixture entry, and a topically-adjacent near-miss (asking how
 * long admin applications take to hear back — same topic as "Requesting admin
 * role", but a question that entry doesn't answer) tops out at ~0.33, while
 * all but a couple of the weakest genuine paraphrase matches score 0.36+. A
 * small minority of very loosely-worded genuine matches score below this
 * floor too (e.g. "what are the guidelines for behaving in this server" vs.
 * the actual "Discord server rules" entry, ~0.30) — that's an intentional
 * precision-over-recall trade-off: this feature exists specifically so a
 * low-confidence hit results in "no confident match" (which the system
 * prompt turns into an honest hedge) rather than a shaky answer stated as
 * fact. If `EMBEDDING_MODEL` ever changes, this constant must be re-derived
 * the same way — a model swap will otherwise silently degrade filtering with
 * no test failure.
 *
 * Defined here (not in agent/tools.ts, which re-exports it for
 * `knowledge_search`'s own filtering) so `knowledgeCoversTopic` below — the
 * issue #102 candidate dedup guard — can share the exact same floor without
 * agent/tools.ts and storage/repository.ts importing each other.
 */
export const KNOWLEDGE_SEARCH_RELEVANCE_THRESHOLD = 0.35;

/**
 * Invalidate every context digest whose provenance refs include any of
 * `interactionIds`, deleting its still-*pending* knowledge candidates first
 * (the same deletion-coherence logic `purgeSingleIdentity` applies, issues
 * #51/#102). Shared so the delete/edit-honouring path (issue #48) invalidates
 * digests built over a message the same way a privacy purge does — otherwise a
 * deleted/edited message's content lives on inside a digest summary. Returns
 * the number of pending candidates removed. No-op on an empty id list.
 */
export async function invalidateDigestsForInteractions(
  interactionIds: number[],
  db: Queryable = pool,
): Promise<number> {
  if (interactionIds.length === 0) return 0;
  const { rows: invalidatedDigests } = await db.query(
    `SELECT id FROM context_digests WHERE example_refs && $1::bigint[]`,
    [interactionIds],
  );
  const digestIds = invalidatedDigests.map((r) => Number(r.id));
  if (digestIds.length === 0) return 0;
  const { rowCount: deletedCandidates } = await db.query(
    `DELETE FROM knowledge_candidates WHERE digest_id = ANY($1::bigint[]) AND status = 'pending'`,
    [digestIds],
  );
  await db.query(`DELETE FROM context_digests WHERE id = ANY($1::bigint[])`, [digestIds]);
  return deletedCandidates ?? 0;
}

export const QUESTION_CLUSTER_SIMILARITY_THRESHOLD = 0.85;

/** Dot product of two embed()-produced (L2-normalized) vectors equals cosine similarity. */
export function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}
