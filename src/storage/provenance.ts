/**
 * Provenance → trust registration (AGENT-BASE-PLAN Phase 1 item 4).
 *
 * `knowledge.created_by_role` records WHO/WHAT wrote an entry: a machine
 * ingestion provenance (`'auto'` daily web research, `'docs'` official docs
 * backfill) or — the column deliberately doubles as the saving human's RBAC
 * tier — a tier string (`'admin'`, `'super_admin'`). Retrieval-time trust
 * used to be derived ad hoc as `created_by_role !== 'auto'`; this registry is
 * the single TS-level source of that mapping, so a future module can add its
 * own provenance without editing the knowledge queries.
 *
 * SECURITY — fail-closed: `trustOf` returns `'quarantined'` for ANY value
 * that was never registered. The old `!== 'auto'` shape failed OPEN (an
 * unknown value was treated as trusted); an unregistered provenance now gets
 * the untrusted rendering, gap-resolution exclusion and shortcut exclusion
 * until someone deliberately registers it as trusted
 * (tests/provenanceTrust.test.ts pins this).
 *
 * SQL keeps its own predicate: the `created_by_role != 'auto'` WHERE clauses
 * in repository/knowledge.ts stay as SQL on purpose (they are the quarantine
 * boundary evaluated in the database, and rewriting them as an IN-list of
 * registered-trusted values would flip them from fail-closed to
 * enumerate-open). Each such site carries a comment pointing back here, and
 * tests/provenanceTrust.test.ts asserts the `!=` form survives.
 */

export type ProvenanceTrust = 'quarantined' | 'trusted';

const registry = new Map<string, ProvenanceTrust>();

export function registerProvenance(reg: { id: string; trust: ProvenanceTrust }): void {
  registry.set(reg.id, reg.trust);
}

/** The registered trust of a `created_by_role` value; UNKNOWN values are `'quarantined'` (fail-closed). */
export function trustOf(provenance: string): ProvenanceTrust {
  return registry.get(provenance) ?? 'quarantined';
}

// Base registrations. 'auto' = unreviewed daily web research, quarantined at
// retrieval; 'docs' = the official Anthropic docs backfill, trusted (served
// verbatim — see docsIngest.ts's header for why that is a deliberate call).
registerProvenance({ id: 'auto', trust: 'quarantined' });
registerProvenance({ id: 'docs', trust: 'trusted' });
// The column doubles as the saving human's RBAC tier (save_knowledge writes
// `caller.role`, accept_knowledge_candidate writes 'admin'), and the old
// `!== 'auto'` gate treated those tier strings as trusted — so they are
// registered trusted here explicitly. 'member'/'guest' are deliberately NOT
// registered: no write path produces them, and fail-closed means a row that
// somehow carried one would be quarantined, never trusted by accident.
registerProvenance({ id: 'admin', trust: 'trusted' });
registerProvenance({ id: 'super_admin', trust: 'trusted' });
