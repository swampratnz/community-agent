import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Pure pins for the provenance → trust registration (src/base/storage/provenance.ts)
// the AGENT-BASE-PLAN item-4 storage split introduced. provenance.ts is a leaf
// (no config/db imports), so no dummy env is needed here.
import { registerProvenance, trustOf } from '../src/base/storage/provenance.js';

test("SECURITY: trustOf is fail-closed — an UNREGISTERED created_by_role value is 'quarantined', never trusted by accident", () => {
  // The old `!== 'auto'` shape failed OPEN: any unknown value was treated as
  // trusted. The registry must fail CLOSED instead.
  for (const unknown of ['member', 'guest', 'AUTO', 'Docs', '', 'some-future-module', ' admin']) {
    assert.equal(trustOf(unknown), 'quarantined', `trustOf(${JSON.stringify(unknown)}) must fail closed`);
  }
});

test("base registrations: 'auto' is quarantined; 'docs' and the RBAC tier strings that reach created_by_role are trusted", () => {
  assert.equal(trustOf('auto'), 'quarantined');
  assert.equal(trustOf('docs'), 'trusted');
  // The column doubles as the saving human's tier (save_knowledge writes
  // caller.role; accept_knowledge_candidate writes 'admin') — the old
  // `!== 'auto'` gate treated these as trusted, so the registry must too.
  assert.equal(trustOf('admin'), 'trusted');
  assert.equal(trustOf('super_admin'), 'trusted');
});

test('registerProvenance: a module-registered provenance resolves to its declared trust', () => {
  const id = `test-provenance-${Date.now()}`;
  assert.equal(trustOf(id), 'quarantined');
  registerProvenance({ id, trust: 'trusted' });
  assert.equal(trustOf(id), 'trusted');
});

test("SQL quarantine predicates keep the fail-closed != 'auto' form — they stay SQL, never an IN-list of trusted values", () => {
  // The three member-facing surfaces whose quarantine boundary is evaluated in
  // the database: listKnowledgeTopics, listCuratedKnowledgeCreatedSince,
  // listReleaseWatchUpdatesSince. Rewriting any of them as an enumeration of
  // registered-trusted values would flip the boundary from fail-closed to
  // enumerate-open — see the comment block in src/base/storage/provenance.ts.
  const source = readFileSync(
    new URL('../src/base/storage/repository/knowledge.ts', import.meta.url),
    'utf8',
  );
  const occurrences = source.match(/AND created_by_role != 'auto'/g) ?? [];
  assert.equal(
    occurrences.length,
    3,
    "exactly the three known SQL sites must carry the fail-closed `created_by_role != 'auto'` predicate",
  );
  assert.ok(
    !/created_by_role IN \(/.test(source),
    'no query may replace the negated quarantine predicate with a trusted-value IN-list',
  );
});
