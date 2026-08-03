import { pool } from '../db.js';

/**
 * Counters for the zero-model-call shortcut paths (ack, repeat-question,
 * knowledge), which usageStats folds into its digest.
 *
 * Extracted verbatim from repository.ts (see its header for why the split
 * exists); `repository.ts` re-exports everything here, so every existing import
 * site is unchanged.
 */

// --- Shortcut hits -----------------------------------------------------------

export type ShortcutKind =
  'ack' | 'knowledge' | 'repeat_question' | 'repeat_max_turns' | 'slash_command' | 'whatsapp_text_command';

/**
 * Records a hit of one of the four env-gated turn-skipping shortcuts (issue
 * #440), a Discord slash-command reply (issue #863, aggregated as a single
 * `slash_command` kind), or a WhatsApp `!`-prefixed text-command reply (issue
 * #859, aggregated as a single `whatsapp_text_command` kind, tracked here per
 * issue #874) — each avoids a `query()` call against the shared Max pool but
 * was previously visible only via a single `logger.debug`/`.info` line.
 * Callers are expected to fire this without awaiting and swallow rejections
 * (mirrors `recordBackgroundJobCost`'s convention) — a failed write must
 * never block or delay the shortcut's own reply.
 */
export async function recordShortcutHit(kind: ShortcutKind): Promise<void> {
  await pool.query(`INSERT INTO shortcut_hits (kind) VALUES ($1)`, [kind]);
}

export async function sumShortcutHits(
  days = 7,
): Promise<{ total: number; byKind: Array<{ kind: string; count: number }> }> {
  const clampedDays = Math.min(Math.max(Math.trunc(days) || 7, 1), 365);
  const { rows } = await pool.query(
    `SELECT kind, count(*) AS n
       FROM shortcut_hits
      WHERE created_at > now() - $1::interval
      GROUP BY kind ORDER BY kind`,
    [`${clampedDays} days`],
  );
  const byKind = rows.map((r) => ({ kind: r.kind as string, count: Number(r.n) }));
  return { total: byKind.reduce((sum, r) => sum + r.count, 0), byKind };
}
