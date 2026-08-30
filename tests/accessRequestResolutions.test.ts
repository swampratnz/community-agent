import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// config.ts validates env at import time — provide a dummy environment
// before importing anything that (transitively) loads it, matching the
// convention in tests/adminDigest.test.ts. DATABASE_URL gates the
// DB-integration tests below (skipped cleanly when unset, per CLAUDE.md).
const hasDb = Boolean(process.env.DATABASE_URL);

process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

const skip = hasDb
  ? false
  : 'DATABASE_URL not set — skipping DB-integration tests (CLAUDE.md: exercise against a local Postgres 16 + pgvector)';

const { pool, closeDb } = await import('@swampratnz/agent-base/storage/db.js');
const { recordAccessRequestResolution, listAccessRequestResolutionsSince } =
  await import('../src/module/storage/accessRequestResolutions.js');

after(async () => {
  await closeDb();
});

// issue #1239's whole design turns on this table carrying no identity: the
// gated-access onboarding queue is the single most sensitive non-member
// record this bot keeps (docs/SECURITY.md's residual-risks section — on
// WhatsApp the user id IS the phone number), so the resolution-speed signal
// is built to survive access_requests' delete-on-resolve WITHOUT reversing
// it. Pinning the exact column set is what stops a future change from
// silently widening this table into an identity store.
test(
  'SECURITY: access_request_resolutions has exactly the columns {id, requested_at, resolved_at, outcome} — no platform, user id, or display name column (issue #1239 acceptance criteria 1, 6)',
  { skip },
  async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'access_request_resolutions' ORDER BY column_name`,
    );
    const columns = rows.map((r) => r.column_name).sort();
    assert.deepEqual(
      columns,
      ['id', 'outcome', 'requested_at', 'resolved_at'],
      'SECURITY: an extra column here would be a silent identity-retention regression on the single most ' +
        'sensitive non-member record this bot keeps',
    );
  },
);

test(
  "SECURITY: access_request_resolutions.outcome CHECK constraint rejects any value outside ('approved', 'declined') (issue #1239 acceptance criterion 1)",
  { skip },
  async () => {
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO access_request_resolutions (requested_at, outcome) VALUES (now(), 'pending')`,
        ),
      /check constraint|violates/i,
      "an outcome outside the closed enum must be rejected at the database, not merely by the caller's TypeScript type",
    );
  },
);

test(
  'recordAccessRequestResolution + listAccessRequestResolutionsSince round-trip: outcome and requestedAt survive, resolvedAt defaults to now() (issue #1239 acceptance criterion 4)',
  { skip },
  async () => {
    const requestedAt = new Date(Date.now() - 3 * 3_600_000);
    const before = Date.now();
    await recordAccessRequestResolution(requestedAt, 'approved');
    const after = Date.now();

    const since = new Date(before - 1000);
    const rows = await listAccessRequestResolutionsSince(since);
    const row = rows.find(
      (r) => r.requestedAt.getTime() === requestedAt.getTime() && r.outcome === 'approved',
    );
    assert.ok(row, 'the freshly inserted row is read back by listAccessRequestResolutionsSince');
    assert.ok(
      row && row.resolvedAt.getTime() >= before - 1000 && row.resolvedAt.getTime() <= after + 1000,
      'resolvedAt defaults to the moment of insertion (now()), not the caller-supplied requestedAt',
    );

    await pool.query(
      `DELETE FROM access_request_resolutions WHERE requested_at = $1 AND outcome = 'approved'`,
      [requestedAt],
    );
  },
);

test(
  'listAccessRequestResolutionsSince excludes a row whose resolved_at falls before the given since cutoff (issue #1239 acceptance criterion 4)',
  { skip },
  async () => {
    const requestedAt = new Date(Date.now() - 30 * 24 * 3_600_000);
    await recordAccessRequestResolution(requestedAt, 'declined');
    // Back-date resolved_at itself, outside any realistic FRESHNESS_DAYS
    // window — recordAccessRequestResolution always writes now(), so this
    // simulates a resolution that happened long ago.
    await pool.query(
      `UPDATE access_request_resolutions SET resolved_at = now() - interval '30 days' WHERE requested_at = $1 AND outcome = 'declined'`,
      [requestedAt],
    );

    const since = new Date(Date.now() - 7 * 24 * 3_600_000);
    const rows = await listAccessRequestResolutionsSince(since);
    assert.ok(
      !rows.some((r) => r.requestedAt.getTime() === requestedAt.getTime()),
      'a resolution outside the since window must not be returned',
    );

    await pool.query(
      `DELETE FROM access_request_resolutions WHERE requested_at = $1 AND outcome = 'declined'`,
      [requestedAt],
    );
  },
);

// Structural check for the "needs no registerPurgeContributor hook" half of
// acceptance criterion 6 — access_request_resolutions carries no identity
// column (pinned above), so there is nothing here for forget_me/
// purge_user_data to reach, and this module never registers a purge
// contributor for it. A future contributor doing so would be adding an
// identity join this table was deliberately designed not to need.
test('SECURITY: src/module/storage/accessRequestResolutions.ts registers no purge contributor for access_request_resolutions — the table carries no identity for forget_me/purge_user_data to erase (issue #1239 acceptance criterion 6)', () => {
  const source = readFileSync(
    new URL('../src/module/storage/accessRequestResolutions.ts', import.meta.url),
    'utf8',
  );
  assert.ok(
    !source.includes('registerPurgeContributor'),
    'this table needs no purge hook — it carries no platform/userId/displayName to erase by construction',
  );
});
