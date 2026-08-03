# Tool registry — design sketch

Phase 1 item 2 of `docs/AGENT-BASE-PLAN.md`: the declarative `ToolDef` registry
that kills the four-places-per-tool problem and splits `tools.ts`. This sketch
is grounded in a fresh audit of HEAD (all counts and line refs verified).

## 1. The problem, measured

117 tools. One new **admin-tier, confirm-gated** tool today costs **11 edits
across 6 files** (worst case, flagged + Discord-only: **15 files**):

| Registration point | Where | If missed |
| --- | --- | --- |
| `tool(...)` declaration | `tools.ts` (inside the 5,500-line `buildToolServer` closure) | — |
| Server `tools:[...]` array | `tools.ts:8211` — all 117 consts listed again by hand | **Silent**: offered in `allowedTools` but absent from the server |
| Tier array | `rbac.ts` `MEMBER_TOOLS`/`ADMIN_TOOLS`/`SUPER_ADMIN_TOOLS` | **Silent**: dead code in production for every role (shipped once — `response_latency`, post-mortem at `rbac.ts:313`) |
| Platform list | `rbac.ts` `DISCORD_ONLY_TOOLS` (hand-derived from adapter capabilities; test keeps a second hand-copy) | **Silent**: token waste on WhatsApp turns |
| Feature-flag group | `core.ts:291` `FEATURE_FLAGGED_TOOL_GROUPS` (flag booleans frozen at import time; test keeps a third hand-copy) | **Silent**: token waste when flag off |
| `requireConfirm(desc, minTier, run)` | inline per call site; `minTier` hand-repeated, never linked to the tier array | Destructive action fires straight from a model turn |
| `audited({actionKind,...})` | inline per call site; free-string kind | **Silent**: privileged action with no audit row, no super-admin alert — nothing tests "every mutation is audited" |
| Capability line | `tools.ts` `*_CAPABILITIES_TEXT` prose + a hand-maintained coverage `Map` in `tests/tools.test.ts` + char-cap bumps | Loud (CI) — but three hand edits |

Four of these fail **silently**. The tier arrays, the flag groups, the
platform list and the test-side copies exist only because the declaration
site can't carry the metadata.

## 2. Target shape

### `ToolDef` — one declaration carries everything

```ts
// src/base/agent/tools/types.ts
export interface ToolDef<Shape extends ZodRawShape = ZodRawShape> {
  /** Bare snake_case name; the registry derives `mcp__community__<name>`
      everywhere — the prefix is never hand-typed again. */
  name: string;
  description: string;

  /** Tier that gets the tool OFFERED (guest keeps the member surface, as today). */
  minTier: 'member' | 'admin' | 'super_admin';
  /** Re-assert real membership in-handler, excluding open-mode guests —
      today's ad-hoc `atLeast(caller.role,'member')` pattern in ~8 member
      tools, made declarative and kernel-enforced. */
  memberGate?: boolean;

  /** Omit = all platforms. `['discord']` replaces DISCORD_ONLY_TOOLS. */
  platforms?: readonly Platform[];
  /** Evaluated per turn against the live config — replaces the import-time
      frozen FEATURE_FLAGGED_TOOL_GROUPS booleans. */
  featureFlag?: (cfg: Config) => boolean;

  /** Declares the tool confirm-gated and owns the tier the router re-checks
      at CONFIRM time. The handler still builds the (dynamic) description and
      calls ctx.requireConfirm — but no longer passes minTier, so the tier
      can never disagree with the declaration. */
  confirm?: { minTier: 'member' | 'admin' | 'super_admin' };
  /** Declares the audit action kind; ctx.audited reads it from the def, so
      the free-string can't drift, and the registry can aggregate
      auditActionKinds for later phases. */
  audit?: { actionKind: string };

  readOnlyHint: boolean;
  /** One line for the community_info rundown; null = deliberately exempt
      (community_info itself). Replaces the test-side coverage Maps. */
  capabilityLine: string | null;

  schema: Shape;
  handler: (args: InferShape<Shape>, ctx: ToolContext) => Promise<CallToolResult>;
}
```

### `ToolContext` — the kernel, extracted from the closure

The megaclosure exists only so 117 handlers can capture `caller`/`adapter`
and five helper closures. Handlers instead take an explicit `ctx`, built once
per turn by a kernel factory:

```ts
// src/module/agent/tools/context.ts
export interface ToolContext {
  caller: CallerContext;
  adapter: PlatformAdapter;
  getAdapter?: AdapterLookup;
  turnState?: ToolServerTurnState;
  getLangPref: typeof getLanguagePreference;
  adapterFor(platform: Platform): PlatformAdapter | undefined;
  callerScope(): string[] | null;
  audited(opts: AuditedOpts): Promise<AuditedResult>;   // fires the super-admin alert, as today
  requireConfirm(description: string, run: () => Promise<string>): CallToolResult;
  resolveMemberTarget(raw: string, platform?: Platform): Promise<...>;
}
export function makeToolContext(def-agnostic inputs...): ToolContext
```

Security-critical properties this preserves **in exactly one place**:

- `requireConfirm`'s bracket/newline/Unicode-line-separator strip (the forgeable-
  pending-notice defence) lives only in the kernel. A domain file cannot
  re-implement it wrongly because it receives it via `ctx`.
- `audited`'s "audit row + `'system'`-priority super-admin alert" pairing
  lives only in the kernel.
- Handler-side `assertAtLeast` stays (defence in depth, unchanged) — and the
  kernel ADDS a wrapper-level tier assert derived from `minTier`, so a tool
  can no longer be reachable below its declared tier even if a handler
  forgets its own check. (Today only the offer-side filters plus per-handler
  asserts stand between a tier and a tool.)

### Registry assembly and the server

```ts
// src/module/agent/tools/index.ts — THE single source of truth
export const TOOL_REGISTRY: readonly ToolDef[] = [
  ...infoTools, ...knowledgeMemberTools, ...memoryTools, ...selfServiceTools,
  ...feedbackTools, ...socialTools, ...projectTools, ...moderationTools,
  ...broadcastTools, ...eventTools, ...knowledgeAdminTools, ...rosterTools,
  ...digestTools, ...superAdminTools, ...devTeamTools, ...imageGenTools,
];
```

`buildToolServer` keeps its signature and keeps returning ONE flat
`createSdkMcpServer` (this matters — see hazards):

```ts
export function buildToolServer(caller, adapter, getAdapter?, turnState?, getLangPref?) {
  const ctx = makeToolContext(caller, adapter, getAdapter, turnState, getLangPref);
  return createSdkMcpServer({
    name: 'community', version: '2.0.0',
    tools: TOOL_REGISTRY.map((def) =>
      tool(def.name, def.description, def.schema,
           (args) => def.handler(args, ctx),
           { annotations: { readOnlyHint: def.readOnlyHint } })),
  });
}
```

### What gets DERIVED (and what dies)

| Derived from registry | Replaces | Dies with it |
| --- | --- | --- |
| `toolsForRole(role, platform)` | the three tier arrays + `DISCORD_ONLY_TOOLS` | the test's second hand-copy of the Discord-only list |
| Per-turn flag filtering (predicates evaluated at `buildQueryOptions` time) | `FEATURE_FLAGGED_TOOL_GROUPS` | the frozen-boolean import-time trap*; the test's third hand-copy of flagged names |
| Server `tools:` array | the 117-entry hand list | the "declared but not registered" failure mode |
| Registry invariant tests | `tests/tools.test.ts:613`'s reflection guard | the whole class: every def is registered, offered, and tier-consistent **by construction**, pinned by one test over the registry |
| confirm/audit metadata | hand-repeated `minTier`, free-string `actionKind` | tier drift between offer-gate and confirm-gate |
| (optionally, see §5) `community_info` rundown | `*_CAPABILITIES_TEXT` + test coverage Maps + char-cap bumps | two-to-three hand edits per tool |

*Honest caveat: `config` itself still validates env at import time, so
per-flag test files still need their own process until the Phase 1 **config
split** (plan item 3). What dies NOW is the second freeze — the groups array
caching `enabled` booleans at `core.ts` import — and the hand-kept
name lists. The predicates read live config at call time.

## 3. File layout

```
src/module/agent/tools.ts            → pure barrel: re-exports buildToolServer, every
                                 helper/test-visible export, unchanged paths for
                                 the 21 test files that import from it
src/module/agent/tools/
  index.ts                    → TOOL_REGISTRY + buildToolServer
  types.ts                    → ToolDef, ToolContext types
  context.ts                  → makeToolContext (audited/requireConfirm/… kernel)
  helpers.ts                  → text(), untrusted(), formatters (module-scope, pure —
                                 lifted verbatim)
  notify.ts                   → notifySuperAdmins/notifyAdmins/notify* family
                                 (already adapter-argument-injected, lift verbatim)
  <domain>.ts × ~16           → the ToolDef arrays (clusters as in §2's registry),
                                 each owning its domain-local module state
                                 (reservers, imageGenInFlight) — moved, never
                                 re-declared
```

Domain boundaries follow the file's own section banners plus the explorer's
cluster map; each domain file lands in the 150–600 line range instead of 8,300.

## 4. Migration: strangler, one domain per PR

This cannot be one PR. The registry types + kernel + conversions land as a
sequence, each individually green and behaviour-neutral:

- **PR A — kernel + types + smallest domain.** `tools/` dir, `ToolDef`/
  `ToolContext`, `makeToolContext` (the closure helpers move here), registry
  scaffold, and the **dev-team domain (6 tools) + image gen (1 tool)**
  converted — the cleanest cluster (transport already lives in
  `src/module/devTeam/client.ts`). `buildToolServer` becomes
  `[...legacyClosureTools, ...registryTools]`. Crucially PR A adds the
  **cross-check test**: for every converted def, its `minTier`/`platforms`/
  `featureFlag` must agree with the (still-authoritative) hand arrays in
  `rbac.ts`/`core.ts`. During the strangle there are two sources of truth;
  this test is what makes that safe.
- **PRs B–F — domain batches.** Mechanical conversions in reviewable chunks
  (~15–25 tools each): member info/prefs/self-service → knowledge (member,
  then admin) → moderation/reports/appeals → membership/roster/roles/projects
  → broadcast/events/digests/super-admin. Hand arrays stay untouched; the
  cross-check test grows with each batch.
- **PR G — the flip.** All 117 converted: derive `toolsForRole`, flag
  filtering and the server array from the registry; delete the three tier
  arrays, `DISCORD_ONLY_TOOLS`, `FEATURE_FLAGGED_TOOL_GROUPS`, the test-side
  hand-copies, and the cross-check test (its job is done); add the registry
  invariant tests. `rbac.ts` keeps exporting `toolsForRole` with an identical
  signature; `MEMBER_TOOLS` etc. become derived exports if anything still
  wants them.
- **PR H (separable, decision below) — rundown generation.**

Each PR: module-map entries for new files, security-floor updates where
`SECURITY:` tests move/are added, full gate suite. Every PR keeps
`tests/tools.test.ts` passing UNCHANGED via the barrel — test migration to
per-domain test files is deliberately NOT part of this work (it can ratchet
later; coupling it in would make every PR huge).

## 5. Open decisions (input wanted)

1. **`community_info` rundown generation — now (PR H) or defer?**
   Member text is already one-line-per-tool → generating it can be made
   near-byte-identical. Admin/super text is consolidated hand prose
   (63 tools ≠ 63 lines, char-capped at 4,260/4,920) — generating it means a
   one-time visible text change, cap re-baselines, and re-checking the
   knowledge eval. Recommendation: **defer to PR H** and land the registry
   value first; the coverage Maps keep gating until then.
2. **Domain granularity.** ~16 files averaging ~7 tools (sketched above) vs
   ~8 coarser files (~15 tools each). Recommendation: ~16 — matches the
   existing banners, and files stay small enough to read whole.
3. **Kernel-level tier enforcement** (the wrapper `assertAtLeast` derived
   from `minTier`, in ADDITION to per-handler asserts). Strictly a security
   strengthening, but it changes the error text a wrongly-routed call
   returns. Recommendation: include it in PR A; pin the message.

## 6. Hazards and their mitigations (from the audit)

| Hazard | Mitigation |
| --- | --- |
| `tests/tools.test.ts` (22,796 lines) destructures ~50 exports from `agent/tools.js` and reaches into the SDK server's private `_registeredTools` in dozens of places | `tools.ts` stays a barrel with identical exports; ONE flat `createSdkMcpServer` call is preserved so the private-field shape never changes |
| Process-singleton rate reservers: re-declaring one in a second file silently doubles its cap; two (`reserveVoiceTranscriptionSlot`, `reserveImageInputDaily`) are imported by all three platform adapters | Each reserver moves WITH its domain file exactly once and is re-exported through the barrel (the #953 `webSearchGuard` precedent); a grep gate in review: no `make*Reserver(` call may appear twice for the same cap |
| `requireConfirm`'s sanitize strip and `audited`'s alert pairing are the security spine of 22 + 55 call sites across every domain | They exist only in `context.ts`; domain files receive them via `ctx` and have no reason (or example) to re-implement. The existing SECURITY tests for confirm-flow sanitisation keep passing through the barrel |
| Tool ORDER lands in the model prompt (SDK tool listing), so reordering churns the prompt cache once per registry PR | Accept the one-time cache miss per PR (same cost as any tool addition today); registry order is deterministic thereafter. Do NOT try to preserve legacy order — it buys nothing after the flip |
| `ENABLED_SKILLS` read at import time inside `FEATURE_FLAG_MAP` | Out of scope here (config split, plan item 3) — noted so nobody "fixes" it mid-conversion |

## 7. What this deliberately does NOT do

- No behaviour change to any tool handler (bodies move verbatim; only the
  capture mechanism changes from closure to `ctx`).
- No change to `pendingActions.ts`, the router's CONFIRM intercept, or the
  deterministic pending notice.
- No test-file split, no `MODERATION_ACTION_KINDS` change (storage split),
  no config split, no `AgentModule` manifest yet — this PR series produces
  the `tools: ToolDef[]` extension point the manifest will later consume.
