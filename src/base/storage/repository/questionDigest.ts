import { pool } from '../db.js';
import { QUESTION_CLUSTER_SIMILARITY_THRESHOLD, cosineSim } from './shared.js';

/**
 * Question clustering for the admin digest: groups recent member questions by
 * embedding similarity so admins see themes rather than a raw list.
 *
 * 🔒 Carries conversation-scoped admin reads (see shared.ts's note on the
 * scoping contract); the `conversationIds` filter moved verbatim.
 *
 * Extracted verbatim from repository.ts (see its header for why the split
 * exists); `repository.ts` re-exports everything here, so every existing import
 * site is unchanged.
 */

// --- Question digest ---------------------------------------------------------

export interface QuestionCluster {
  representative: string;
  count: number;
}

/**
 * Greedily cluster recently-addressed inbound messages by embedding
 * similarity to surface recurring, un-curated questions — a signal for what
 * should become a `knowledge` entry. Clustering runs in application code over
 * an already time-bounded, conversation-scoped result set (no SQL self-join;
 * see #21 for why that's the right tradeoff at this scale).
 */
export async function recentQuestionClusters(
  conversationIds: readonly string[] | null,
  days = 7,
  limit = 10,
): Promise<QuestionCluster[]> {
  const clampedDays = Math.min(Math.max(Math.trunc(days) || 7, 1), 30);
  const clampedLimit = Math.min(Math.max(Math.trunc(limit) || 10, 1), 50);

  const params: unknown[] = [`${clampedDays} days`];
  let scope = '';
  if (conversationIds) {
    params.push([...conversationIds]);
    scope = `AND conversation_id = ANY($${params.length})`;
  }

  const { rows } = await pool.query(
    `SELECT content, embedding
       FROM interactions
      WHERE addressed_to_bot = true AND direction = 'inbound'
        AND embedding IS NOT NULL
        AND created_at > now() - $1::interval
        ${scope}
      ORDER BY created_at ASC`,
    params,
  );

  const clusters: Array<{ representative: string; embedding: number[]; count: number }> = [];
  for (const row of rows) {
    const vec = row.embedding as number[] | null;
    if (!vec) continue;
    const match = clusters.find((c) => cosineSim(c.embedding, vec) >= QUESTION_CLUSTER_SIMILARITY_THRESHOLD);
    if (match) {
      match.count += 1;
    } else {
      clusters.push({ representative: row.content, embedding: vec, count: 1 });
    }
  }

  return clusters
    .filter((c) => c.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, clampedLimit)
    .map((c) => ({ representative: c.representative, count: c.count }));
}
