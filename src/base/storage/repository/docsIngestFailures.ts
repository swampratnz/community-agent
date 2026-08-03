import { pool } from '../db.js';

/**
 * Docs-ingest dead-URL tracking (issue #611): consecutive-failure counts per
 * ingested page, so a permanently-gone doc URL is reported rather than retried
 * forever in silence.
 *
 * Extracted verbatim from repository.ts (see its header for why the split
 * exists); `repository.ts` re-exports everything here, so every existing import
 * site is unchanged.
 */

// --- Docs-ingest dead-URL tracking (issue #611) ------------------------------

export interface DocsIngestUrlFailure {
  url: string;
  consecutiveFailures: number;
  lastFailedAt: Date;
  /** Non-null once the URL crossed the dead threshold and was reported. */
  reportedAt: Date | null;
}

/**
 * Every URL currently in a failing streak. A row exists only while a URL is
 * failing (a successful fetch deletes it — see `clearDocsIngestUrlFailures`),
 * so this is bounded by the size of the upstream index's dead tranche, not by
 * history. Returned raw: the caller (`runDocsIngest`) applies the
 * threshold/recheck policy, keeping this function free of config coupling and
 * the policy directly unit-testable.
 */
export async function listDocsIngestUrlFailures(): Promise<DocsIngestUrlFailure[]> {
  const { rows } = await pool.query(
    `SELECT url, consecutive_failures, last_failed_at, reported_at FROM docs_ingest_url_failures`,
  );
  return rows.map((r) => ({
    url: r.url as string,
    consecutiveFailures: Number(r.consecutive_failures),
    lastFailedAt: r.last_failed_at as Date,
    reportedAt: (r.reported_at as Date | null) ?? null,
  }));
}

/**
 * Record one more consecutive failure for each URL, creating the row on first
 * failure. `first_failed_at` is preserved across bumps (it dates the streak);
 * `last_failed_at` moves to now, which is what the re-probe cooldown measures
 * from. No-op on an empty list.
 */
export async function recordDocsIngestUrlFailures(urls: readonly string[]): Promise<void> {
  // De-duplicated because ON CONFLICT DO UPDATE errors outright ("cannot affect
  // row a second time") if the same key appears twice in one statement.
  const unique = [...new Set(urls)];
  if (unique.length === 0) return;
  await pool.query(
    `INSERT INTO docs_ingest_url_failures (url)
     SELECT unnest($1::text[])
     ON CONFLICT (url) DO UPDATE
       SET consecutive_failures = docs_ingest_url_failures.consecutive_failures + 1,
           last_failed_at = now()`,
    [unique],
  );
}

/**
 * Clear the failing streak for URLs that fetched successfully — this is what
 * makes the streak CONSECUTIVE (one success resets it) and what lets an
 * upstream fix self-heal a skipped URL on its next re-probe. No-op on an empty
 * list.
 */
export async function clearDocsIngestUrlFailures(urls: readonly string[]): Promise<void> {
  if (urls.length === 0) return;
  await pool.query(`DELETE FROM docs_ingest_url_failures WHERE url = ANY($1)`, [[...urls]]);
}

/**
 * Stamp `reported_at` on URLs whose dead-threshold crossing has just been
 * logged, so the operator is told once rather than on every subsequent run.
 * No-op on an empty list.
 */
export async function markDocsIngestUrlsReported(urls: readonly string[]): Promise<void> {
  if (urls.length === 0) return;
  await pool.query(
    `UPDATE docs_ingest_url_failures SET reported_at = now() WHERE url = ANY($1) AND reported_at IS NULL`,
    [[...urls]],
  );
}
