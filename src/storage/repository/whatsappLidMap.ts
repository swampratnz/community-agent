// ---------------------------------------------------------------------------
// WhatsApp LID -> phone number mapping (see schema.sql, docs/SECURITY.md §6b).
//
// WhatsApp hands out two identifiers for one person: an E.164 phone number and
// a LID (`<digits>@lid`, a privacy id). Only the phone number is a usable
// identity here — every inbound message resolves LID -> phone via `senderPn`,
// so `community_users`, RBAC and project membership all match on the number.
// Group participant metadata gives LIDs and nothing else, which is how four
// unreachable "phantom members" were created on 2026-07-21/27 and 2026-08-01.
//
// The adapter already learned the mapping opportunistically, but kept it in a
// bare in-memory Map — lost on every restart, and invisible to anything
// outside the adapter. These functions are the durable half: the Map stays as
// the hot-path cache in front of them.
//
// PII: a row here links a privacy id to a phone number. It is personal data,
// and `forgetLidMappingsForPhone` is wired into forget_me / purge_user_data so
// it is erased with everything else.
// ---------------------------------------------------------------------------
import { pool } from '../db.js';

/**
 * Record (or refresh) a LID -> phone mapping learned from a real message
 * envelope.
 *
 * `lid` is the PRIMARY KEY, so re-learning is an idempotent `last_seen` bump.
 * The phone is overwritten on conflict rather than kept: WhatsApp can re-issue
 * a LID, and the newest envelope is the authoritative one — a stale mapping
 * would resolve someone to a number that is no longer theirs, which is the one
 * outcome worse than having no mapping at all.
 */
export async function rememberLidPhone(lid: string, phone: string): Promise<void> {
  await pool.query(
    `INSERT INTO whatsapp_lid_map (lid, phone)
          VALUES ($1, $2)
     ON CONFLICT (lid) DO UPDATE
            SET phone = EXCLUDED.phone,
                last_seen = now()`,
    [lid, phone],
  );
}

/**
 * Resolve a LID to the phone number last observed for it, or null when we have
 * never seen that person send a message we could resolve.
 *
 * Null is a normal answer, not an error: the mapping is only ever learned from
 * someone actually posting, so a member who has never spoken in a group the bot
 * can see is simply unknown. Callers must treat null as "cannot resolve" and
 * fall back to asking a human for the number — never as "not a member".
 */
export async function phoneForLid(lid: string): Promise<string | null> {
  const { rows } = await pool.query<{ phone: string }>(`SELECT phone FROM whatsapp_lid_map WHERE lid = $1`, [
    lid,
  ]);
  return rows[0]?.phone ?? null;
}

/**
 * Erase every LID mapping for a phone number. Wired into the forget_me /
 * purge_user_data path: the mapping is PII (it de-anonymises a privacy id), so
 * it must not outlive the data it belongs to. A person can hold more than one
 * LID over time, hence the phone-keyed delete rather than a single row.
 *
 * Returns the number of rows removed so the purge total stays honest.
 */
export async function forgetLidMappingsForPhone(phone: string): Promise<number> {
  const { rowCount } = await pool.query(`DELETE FROM whatsapp_lid_map WHERE phone = $1`, [phone]);
  return rowCount ?? 0;
}
