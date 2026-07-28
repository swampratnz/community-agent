import { pool } from '../db.js';

/**
 * Runtime policy rows (the `policies` table) behind set_policy / pause-resume.
 *
 * Extracted verbatim from repository.ts (see its header for why the split
 * exists); `repository.ts` re-exports everything here, so every existing import
 * site is unchanged.
 */

// --- Policies ----------------------------------------------------------------

export async function getPolicyValue(key: string): Promise<unknown> {
  const { rows } = await pool.query(`SELECT value FROM policies WHERE key = $1`, [key]);
  return rows[0]?.value ?? null;
}

export async function setPolicyValue(key: string, value: unknown, updatedBy: string): Promise<void> {
  await pool.query(
    `INSERT INTO policies (key, value, updated_by)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(value), updatedBy],
  );
}
