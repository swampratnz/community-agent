import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Pure (no DB) pins for the storage lifecycle registries introduced by the
// AGENT-BASE-PLAN item-4 storage split (src/base/storage/lifecycle.ts). The purge
// count arithmetic cannot be exercised here (DB tests cover behaviour in CI);
// what CAN be proven without a database is the registry SHAPE the arithmetic
// depends on: which contributors exist, in what order they run, which of them
// feed the my_data summary, and that the statements the old inline code left
// uncounted stayed uncounted.
//
// Dummy env so importing the barrel (which loads config via interactions.ts)
// parses cleanly — same block as tests/backgroundJobCost.test.ts.
process.env.CLAUDE_CODE_OAUTH_TOKEN ??= 'test-token';
process.env.DISCORD_BOT_TOKEN ??= 'test-token';
process.env.DISCORD_GUILD_ID ??= '1';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
process.env.WHATSAPP_PROVIDER ??= 'disabled';

/**
 * The exact statement order of the old inline purgeSingleIdentity transaction
 * (after its hardcoded prologue: sessions clear → interactions delete →
 * digest-invalidation hooks, and before its hardcoded epilogue: the three
 * breadcrumb-NULLing UPDATEs). Registration happens at module load of each
 * owning domain file; the explicit `order` values — not load order — are what
 * pin this sequence.
 */
const EXPECTED_PURGE_ORDER = [
  'knowledge',
  'content_reports',
  'server_roster',
  'member_notes',
  'suggestions',
  'admin_digest_sends',
  'response_style_prefs',
  'language_prefs',
  'member_warnings',
  'answer_feedback',
  'knowledge_gaps',
  'dev_team_watches',
  'moderation_appeals',
  'member_projects',
  'member_interests',
  'knowledge_candidates',
  'helper_notifications',
  'project_connection_requests',
  'projects',
  'whatsapp_lid_map',
  'access_requests',
];

/** The my_data table set — everything else is deliberately purge-only (issue #188's asymmetry). */
const EXPECTED_SUMMARIZED = [
  'knowledge',
  'content_reports',
  'suggestions',
  'member_projects',
  'member_interests',
];

async function loadRegistry() {
  // The barrel's `export *` lines execute every domain module — the exact
  // registration path production takes.
  await import('../src/base/storage/repository.js');
  return import('../src/base/storage/lifecycle.js');
}

test('purge contributors: exactly the pinned tables, registered in the old inline statement order', async () => {
  const { purgeContributors } = await loadRegistry();
  const contributors = purgeContributors();
  assert.deepEqual(
    contributors.map((c) => c.name),
    EXPECTED_PURGE_ORDER,
    'contributor set/order must match purgeSingleIdentity’s pinned transaction order — see its comment before changing this',
  );
  // Explicit orders must be strictly increasing so no two contributors ever
  // tie (a tie would make the transaction order depend on module load order).
  for (let i = 1; i < contributors.length; i++) {
    assert.ok(
      contributors[i].order > contributors[i - 1].order,
      `contributor orders must be strictly increasing (${contributors[i - 1].name} → ${contributors[i].name})`,
    );
  }
});

test('SECURITY: no purge contributor is named blocked_users — forget_me/purge_user_data must never erase the row enforcing an admin block, including via a linked identity (issue #572)', async () => {
  const { purgeContributors } = await loadRegistry();
  assert.ok(
    !purgeContributors().some((c) => c.name === 'blocked_users'),
    'blocked_users must never gain a purge contributor — the negative space is the invariant',
  );
});

test('my_data summarize() exists on exactly the historical summary tables — the five purge-only omissions stay omitted (issue #188)', async () => {
  const { purgeContributors } = await loadRegistry();
  const summarized = purgeContributors()
    .filter((c) => typeof c.summarize === 'function')
    .map((c) => c.name);
  assert.deepEqual(summarized, EXPECTED_SUMMARIZED);
  // The deliberate omissions named in getMyDataSummary's doc comment exist as
  // contributors (so the purge covers them) but expose no summarize.
  for (const omitted of [
    'member_notes',
    'server_roster',
    'admin_digest_sends',
    'member_warnings',
    'answer_feedback',
  ]) {
    const contributor = purgeContributors().find((c) => c.name === omitted);
    assert.ok(contributor, `${omitted} must still have a purge contributor`);
    assert.equal(
      typeof contributor.summarize,
      'undefined',
      `${omitted} must stay my_data-omitted (purge-only)`,
    );
  }
});

test('interactions-invalidated hooks: the base digest-coherence sweep is registered first', async () => {
  await import('../src/base/storage/repository.js');
  const { onInteractionsInvalidatedHooks } = await import('../src/base/storage/lifecycle.js');
  const { invalidateDigestsForInteractions } = await import('../src/base/storage/repository/shared.js');
  const hooks = onInteractionsInvalidatedHooks();
  assert.ok(hooks.length >= 1, 'at least the base sweep must be registered');
  assert.equal(
    hooks[0],
    invalidateDigestsForInteractions,
    'shared.ts’s sweep must be the FIRST hook — purge/delete/edit coherence depends on it',
  );
});

test('member-removed hooks: exactly the project_members cleanup is registered (issue #927)', async () => {
  await import('../src/base/storage/repository.js');
  const { onMemberRemovedHooks } = await import('../src/base/storage/lifecycle.js');
  assert.equal(onMemberRemovedHooks().length, 1);
});

test('roster-leave hooks: pinned names and order — the failure log lines interpolate the names', async () => {
  await import('../src/base/storage/repository.js');
  const { onRosterLeaveHooks } = await import('../src/base/storage/lifecycle.js');
  assert.deepEqual(
    onRosterLeaveHooks().map((h) => h.name),
    ['member_projects', 'member_interests', 'helper_notifications', 'project_connection_requests'],
    'names double as the roster-leave log context (`Roster-leave ${name} cleanup failed`) — renaming one changes an operator-visible log line',
  );
});

test('purge count arithmetic: counted-vs-uncounted classification is unchanged (source pin)', () => {
  // The total is messages + candidates + Σ contributor returns — no other term.
  const budgetsSource = readFileSync(
    new URL('../src/base/storage/repository/budgetsPrivacy.ts', import.meta.url),
    'utf8',
  );
  assert.ok(
    budgetsSource.includes('return messages + candidates + contributed;'),
    'purgeSingleIdentity’s total must stay exactly messages + candidates + Σ contributors',
  );
  // The three breadcrumb-NULLing UPDATEs stay in the hardcoded epilogue,
  // uncounted (fire-and-sum-nothing: results deliberately not captured).
  for (const table of [
    'projects SET created_by',
    'project_members SET added_by',
    'project_surfaces SET bound_by',
  ]) {
    assert.ok(
      budgetsSource.includes(`await client.query(\`UPDATE ${table} = NULL WHERE`),
      `epilogue UPDATE for ${table} must stay uncounted (bare await, no destructuring)`,
    );
  }
  // The fourth authorship-NULLing UPDATE (project_notes) lives inside the
  // projects contributor and must stay uncounted there too.
  const projectsSource = readFileSync(
    new URL('../src/base/storage/repository/projects.ts', import.meta.url),
    'utf8',
  );
  assert.match(
    projectsSource,
    /await tx\.query\(\n\s+`UPDATE project_notes SET author_platform = NULL, author_user_id = NULL/,
    'project_notes authorship-NULL must stay a bare (uncounted) statement inside the projects contributor',
  );
});
