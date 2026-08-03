import { pool } from '../db.js';

/**
 * Offline context-digest builder output (issue #51) — the nightly aggregate
 * rows the community-context export reads from.
 *
 * Extracted verbatim from repository.ts (see its header for why the split
 * exists); `repository.ts` re-exports everything here, so every existing import
 * site is unchanged.
 */

// --- Context digests (offline builder output, issue #51) ---------------------

export interface ContextDigest {
  id: number;
  periodStart: Date;
  periodEnd: Date;
  platform: string | null;
  topic: string;
  summary: string;
  exampleRefs: number[];
  distinctUsers: number;
  questionCount: number;
  createdAt: Date;
}

export async function insertContextDigest(input: {
  periodStart: Date;
  periodEnd: Date;
  platform?: string;
  topic: string;
  summary: string;
  exampleRefs: number[];
  distinctUsers: number;
  questionCount: number;
}): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO context_digests
       (period_start, period_end, platform, topic, summary, example_refs, distinct_users, question_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      input.periodStart,
      input.periodEnd,
      input.platform ?? null,
      input.topic,
      input.summary,
      input.exampleRefs,
      input.distinctUsers,
      input.questionCount,
    ],
  );
  return Number(rows[0].id);
}

export async function listContextDigests(days = 30, limit = 20): Promise<ContextDigest[]> {
  const clampedDays = Math.min(Math.max(Math.trunc(days) || 30, 1), 365);
  const clampedLimit = Math.min(Math.max(Math.trunc(limit) || 20, 1), 100);
  const { rows } = await pool.query(
    `SELECT id, period_start, period_end, platform, topic, summary, example_refs,
            distinct_users, question_count, created_at
       FROM context_digests
      WHERE created_at > now() - $1::interval
      ORDER BY created_at DESC, question_count DESC
      LIMIT $2`,
    [`${clampedDays} days`, clampedLimit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    periodStart: r.period_start,
    periodEnd: r.period_end,
    platform: r.platform,
    topic: r.topic,
    summary: r.summary,
    exampleRefs: (r.example_refs as unknown[]).map(Number),
    distinctUsers: Number(r.distinct_users),
    questionCount: Number(r.question_count),
    createdAt: r.created_at,
  }));
}

/** When the builder last produced anything — backs the ~daily freshness guard. */
export async function latestContextDigestAt(): Promise<Date | null> {
  const { rows } = await pool.query(`SELECT max(created_at) AS at FROM context_digests`);
  return rows[0]?.at ?? null;
}
