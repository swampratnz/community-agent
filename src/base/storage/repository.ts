/**
 * THE REPOSITORY BARREL — a pure re-export surface, nothing else.
 *
 * repository.ts was ~7,100 lines — every SQL query in the product in one
 * module — which made it both hard to navigate and the repo's worst
 * merge-conflict hotspot, since nearly every feature PR appended to it. The
 * split (audit 2026-07-28 L14) carved it into the per-domain modules under
 * `./repository/`, finishing with `interactions.ts`; they are RE-EXPORTED from
 * here, deliberately, so that all ~59 import sites and `tests/repository.test.ts`
 * keep working unchanged: callers still `import { … } from '.../repository.js'`
 * and neither know nor care which file a function lives in.
 *
 * WHEN YOU ADD A QUERY: put it in the matching `./repository/<domain>.ts` (or
 * add a new domain module + `export *` line here, plus its
 * `docs/agents/module-map.md` entry — `npm run context:check` enforces that).
 * Never add a function body to THIS file again — it holds `export *` lines only.
 *
 * The extracted modules are verbatim moves — no behaviour change — and the
 * security invariant is unchanged wherever it applies: admin-facing reads are
 * conversation-scoped IN SQL (`AND conversation_id = ANY($n)`, `null` meaning
 * super-admin/unrestricted), never by the caller. Keep that in the query.
 *
 * Note `export *` still EXECUTES every domain module's top-level code, which
 * is what loads their lifecycle/registry registrations for any consumer that
 * imports through this barrel.
 */
export * from './repository/preferences.js';
export * from './repository/memberNotes.js';
export * from './repository/shared.js';
export * from './repository/devTeamWatches.js';
export * from './repository/accessRequests.js';
export * from './repository/contextDigests.js';
export * from './repository/memberDiscovery.js';
export * from './repository/docsIngestFailures.js';
export * from './repository/policies.js';
export * from './repository/roster.js';
export * from './repository/adminAudit.js';
export * from './repository/shortcutHits.js';
export * from './repository/digestAlerts.js';
export * from './repository/moderation.js';
export * from './repository/memberProjects.js';
export * from './repository/projects.js';
export * from './repository/members.js';
export * from './repository/knowledge.js';
export * from './repository/knowledgeCandidates.js';
export * from './repository/suggestions.js';
export * from './repository/budgetsPrivacy.js';
export * from './repository/sessions.js';
export * from './repository/questionDigest.js';
export * from './repository/knowledgeGaps.js';
export * from './repository/adminStats.js';
export * from './repository/contentReports.js';
export * from './repository/answerFeedback.js';
export * from './repository/responseLatency.js';
export * from './repository/whatsappLidMap.js';
export * from './repository/interactions.js';
