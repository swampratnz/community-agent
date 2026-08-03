# AGENT-BASE extraction plan

How to extract a community-agnostic **agent-base** framework from this repo
into [`swampratnz/agent-base`](https://github.com/swampratnz/agent-base), with
the NZ-Claude-Community behaviour becoming a **module** on top of it, so that
further agents (e.g. a personal finance agent) can be built on the same base.

Produced from a full classification sweep of `src/`, `tests/`, `scripts/`,
`.github/workflows/` and `docs/` (2026-08).

**Status (2026-08-03): Phase 0 done, Phase 1 DONE, Phase 2 DONE, Phase 3 IN
PROGRESS — the framework is extracted to `swampratnz/agent-base` and this repo
now consumes it as a package (see §Phase 3 for what that left).** The plan text below is left as written — it is the
record of what was decided, not a status board. Per-phase status notes are
inserted at each heading, and the residue Phase 3 inherits is listed in §6.

## 1. The headline findings

1. **The behaviour splits cleanly; the wiring does not.** The security spine
   (tool gating, CONFIRM flow, outbound filtering, RBAC-from-storage,
   quarantine rendering, SQL conversation scoping), the memory layer, the
   platform adapters, the job scheduler and the budget/alert machinery are all
   already community-agnostic in *mechanism*. What is NZ-specific is mostly
   **content**: prose (charter, guidelines, Dave persona, six SKILL.md files),
   the te reo Māori / plain-language string tables (`*_MI` / `*_PLAIN`
   constants across ~10 files), the fixed Claude/Anthropic knowledge sources,
   and the community product features (strikes, digests, matchmaking,
   showcase).
2. **Most "community-sounding" features are actually base.** Gated access +
   access requests, escalation-to-human, the whole knowledge-base engine
   (retrieval, staleness, gaps, link check, curation queue mechanism),
   auto-answer, team projects (scoped shared memory), suggestions,
   answer feedback, privacy self-service — a finance agent plausibly wants
   every one of them. What is community is their *content and policy*
   (Claude topics, NZ guidelines, docs/status URLs, strike thresholds).
3. **The dev/CI infrastructure is the most extractable asset** — arguably more
   valuable than the runtime: the self-improving pipeline, the security-test
   floor, the context-pack gate, the ratchet conventions and the deterministic
   loops are generic, with community-specificity confined to prompt preambles,
   dummy-env blocks, and the `docs/VISION.md` rubric (which is already the
   *designed* seam: "tune quality by editing this file, not the loop prompts").
4. **Five chokepoints do most of the coupling damage**, and they repeat across
   every subsystem survey:
   - the import-time `config` singleton (`src/config.ts`), read at module
     scope by nearly every file (even `FEATURE_FLAGGED_TOOL_GROUPS` is
     computed at import);
   - the quadruply-stringly tool surface: each tool exists in the
     `buildToolServer()` megaclosure, the `rbac.ts` tier arrays, the
     `FEATURE_FLAGGED_TOOL_GROUPS` drop table, and the `*_CAPABILITIES_TEXT`
     prose — all keyed on literal `mcp__community__*` names;
   - the monolithic `storage/repository.ts` barrel + single `schema.sql`
     (base and community tables in one atomic replay, `purgeSingleIdentity`
     hard-coding deletes for ~22 tables across the line);
   - the NZ i18n axis (`'mi'` / `'plain'`) baked into closed union types on
     the platform contract, the DB CHECK constraints and dozens of paired
     constants;
   - `src/index.ts` hand-wiring ~20 jobs with a mirrored shutdown list, and
     `router.ts`'s 25-positional-parameter constructor whose *defaults* import
     community code.

The good news: the codebase already practices injection almost everywhere
(Moderator deps, throwing-stub test pattern, `Queryable` transactions,
`pendingAlertQueue`/`healthState` built as leaf modules on purpose). Extraction
is mostly *reifying seams the code already half-uses*, not untangling logic.

## 2. Target end-state

```
swampratnz/agent-base            (framework repo)
  packages/core                  runtime framework (npm: @swampratnz/agent-core)
    agent/        turn engine, prompt assembler (slot-based), confirm flow,
                  outbound DLP, WebSearch guard, tool-hosting kernel
    platforms/    PlatformAdapter contract + Discord/WhatsApp adapters,
                  wire helpers, text chunking (adapter factory registry)
    storage/      pool, embeddings, migration runner (fragment concatenation),
                  base repositories, lifecycle hooks, purge-contributor registry
    runtime/      router spine, job scheduler, notification service,
                  notice catalogue, health, retention, budgets, crash handlers
    module-api/   the AgentModule interface (§3)
  workflows/                     reusable GitHub workflows (the pipeline)
  scripts/                       the gates (security floor, context pack, …)
  template/                      new-agent repo template: CLAUDE.md, docs
                                 skeletons, empty ratchet-state files, CI env
  docs/                          base SECURITY/ARCHITECTURE/STANDARDS

swampratnz/community-agent       (this repo, becomes an app)
  src/module/…                   the NZ community module: its tools, jobs,
                                 schema fragment, prompt sections, strings
                                 ('mi'), skills, personas (Dave), VISION.md
  src/main.ts                    createAgent({ modules: [communityModule] })

swampratnz/finance-agent         (future, proves the seams)
```

Distribution recommendation: **npm package(s) + reusable workflows**, not a
copy-template, for everything with a contract (runtime, gate scripts, pipeline
workflows + their marker-comment constants — these must be versioned
*together*). Per-repo **state** stays per-repo: `tests/security-floor.json`,
`tsconfig.tests.json` include list, `docs/agents/module-map.md`, VISION.md,
theme labels, dummy CI env, governance-path list, CHANGELOG.

## 3. The module API (what a module registers)

One manifest object per module; base owns ordering, the security spine, and
every enforcement point. Nothing a module registers can bypass outbound
filtering, reorder the router's security sequence, or widen the skills
allowlist. Extension points, each traced to where it lives today:

| Extension point | Replaces today |
| --- | --- |
| `tools: ToolDef[]` — `{name, minTier, platforms?, featureFlag?, confirm?, audit?, rateLimit?, readOnlyHint, capabilityLine, schema, handler(args, ctx)}`; ctx exposes the kernel helpers (`audited`, `requireConfirm`, `callerScope`, `adapterFor`, `notify`, `turnState`) | the `buildToolServer()` closure, `rbac.ts` tier arrays, `FEATURE_FLAGGED_TOOL_GROUPS`, `DISCORD_ONLY_TOOLS`, `*_CAPABILITIES_TEXT` (rundown becomes registry-generated) |
| `configSchema` — zod slice parsed by the base loader, handed back typed at init (`config.modules.<name>`); cross-schema refinements supported | the 1,583-line `EnvSchema`; import-time `config` reads move to init-time injection |
| `migrations` — idempotent SQL fragment(s), concatenated base-first and run as ONE atomic query, same conventions (IF NOT EXISTS, one DROP/ADD pair per CHECK); modules never ALTER base CHECKs (make `shortcut_hits.kind`, `background_job_costs.job` registrations instead) | monolithic `schema.sql` + `migrate.ts` |
| `repositories` + lifecycle hooks — `PurgeContributor {purge(tx), summarize()}`, `onInteractionsDeleted(ids, tx)`, `onMemberRemoved/onRosterLeave(tx)` | `purgeSingleIdentity`'s 22-table transaction, `invalidateDigestsForInteractions` called from base delete paths, `removeMember`'s inline `project_members` delete |
| `jobs: JobSpec[]` — `{name, enabled(cfg), intervalMs, runOnce(deps)}`; base owns `startTrackedJob`, failure tracker, cost recording, single shutdown sweep; `BackgroundJobName` becomes an open string | `index.ts`'s 20 hand-wired `startX()` calls + mirrored shutdown list; community jobs inside `backgroundJobs.ts` |
| `promptSections` — charter, behaviour guidelines, persona roster, web-search authority domains, timezone/date format; rendered BELOW the immutable base security spine | `COMMUNITY_CHARTER`, the community half of `GUIDELINES_TEMPLATE`, `personas.ts` content, `NZ_DATE_FORMAT` |
| `strings` — locale/style catalogue `notice(id, {language, style})`; module declares supported axes (`mi`, `plain`) and packs; CONFIRM/CANCEL tokens stay base-owned literals | every `*_MI`/`*_PLAIN` constant pair + per-site precedence logic in router/core/notices/outbound/moderator; the `'mi'` unions on `OutgoingMessage` and `language_prefs` become open, module-registered |
| `intercepts` + `postTurnHandlers` — pre-turn handlers at named stages (never before/among the security-ordered spine: block → role → gate → CONFIRM → pause → rate → budget); generic turn-state bag replaces the five community fields on `AgentReply`/`ToolServerTurnState` | inline knowledge/FAQ shortcuts, WhatsApp `!` text commands, escalation offer, auto-answer; `knowledgeGapCluster` etc. threaded through core types |
| `commands` — `{name, platforms, handler}` mapped to Discord slash registration and the text-command intercept | `slashCommands.ts` handlers, `tryWhatsAppTextCommand` |
| `adapters` — factory registry `{platform: string, create(cfg)}`; `Platform` becomes an open branded string; per-platform tool availability derived from adapter capability declarations | `new DiscordAdapter()` + provider switch in `index.ts`; the closed `'discord'\|'whatsapp'` union duplicated in core.ts/tools.ts/zod enums |
| `textPacks` for adapters — welcome/warn/caveat strings + guidelines-append policy, returned as plain strings that base still runs through `filtered()` | `WELCOME_MESSAGE*`, `WARN_USER_DM_PREFIX*` constants ×3 adapters, `storage/policies.ts` community keys |
| `moderationPolicy` — inbound-content hook + post-warn policy (strike bookkeeping); engine stays base | `createModerator(this)` in the Discord adapter ctor, `applyManualWarnStrike` called from the generic `moderate` tool |
| `digestSignals` / `reviewQueues` / `submissionProviders` — registries for admin digest sections, `review_queue`, `my_submissions` | `buildAdminDigestMessage`'s 45 positional params, hard-coded queue lists |
| `ingestSources` / `refreshTopics` — `{indexUrl, pathPrefixStrips, provenance, trust}` + fixed topic lists (in module CODE, not env — preserves the non-runtime-controllable research surface) | Anthropic `llms.txt` / status-page / Claude-topic hardcoding in `context/`, `status/` |
| `skills` — `{skillsDir, enabledSkills[]}`; base keeps the never-`'all'` invariant | `SKILLS_DIR` + `enabledSkills.ts` |
| `secrets` — `registerRuntimeSecret()` per credential | the hand-listed `runtimeSecrets()` |
| `featureFlags`, `auditActionKinds`, `trackedCostJobs` | `FEATURE_FLAG_MAP`, `MODERATION_ACTION_KINDS`, `TRACKED_JOBS` allowlists |

## 4. Strategy: strangle in place, extract last

**Do the inversion inside this repo first**, where CI, the ~206 test files,
the security floor and the pipeline already adjudicate every step. Only lift
code into `agent-base` once `src/base/` and `src/module/` compile with a
one-way import rule between them. Building agent-base greenfield and porting
would forfeit the entire safety net and re-derive every seam blind.

### Phase 0 — decisions (owner, cheap, do first)

- Confirm distribution: npm package(s) + reusable workflows (§2). Requires a
  publishing story (GitHub Packages is the low-friction default for a private
  org scope).
- Naming: package scope, MCP server namespace (make the `community` server key
  and `mcp__<ns>__` prefix a module property), whether `community_users`
  is renamed in base (recommend: keep the physical table name for prod
  compatibility, alias it `agent_users` in base docs/API only).
- Decide whether `whats_new`/CHANGELOG is a base capability (it uniquely
  couples runtime to the changelog dev-toolchain). Recommend: yes, base but
  opt-in.
- Pipeline throttling during heavy phases: the refactor PRs will conflict with
  concurrent feature PRs; plan to drain the `status:approved` queue or lower
  the WIP cap while the storage/config/tools inversions land.

### Phase 1 — reify the seams (sequenced refactor PRs in this repo)

> **DONE.** All nine items landed as sequenced PRs, none changing behaviour.
> What they left behind, in the order below: the leaf cleanups
> (`shouldNotifyAfterWindow`, `notifications.ts`, `util/rateReservation.ts`,
> `util/sanitizeName.ts`, one parameterised `retention.ts`); the declarative
> tool registry (`ToolDef`/`defineTool` + per-domain files under
> `agent/tools/`, with `toolsForRole`, the feature-flag filter and the
> capability rundown all derived from it); the config split (per-domain zod
> slices behind a composition barrel, plus `config/boot.ts` so `npm run
> migrate` needs only `DATABASE_URL`); the storage split (the `repository/`
> domain carve-out completed to a pure barrel, ordered schema fragments +
> concatenating migrator, the `lifecycle.ts` purge/hook registries,
> provenance→trust as a registration); the job registry and single shutdown
> sweep; the notice catalogue over open language/style axes with
> adapter-injected text packs; the router split (deps object, the frozen
> `PRE_TURN_SPINE` intercept chain, post-turn handler registry, generic
> turn-state bag); the slot-based prompt assembler with a base-owned security
> spine, persona registry and skills manifest, byte-stability pinned; and the
> platform registry with capability-derived tool availability.

Ordered by dependency; each is one PR-sized unit with its own tests, and none
changes behaviour:

1. **Leaf cleanups** (parallelizable, tiny): move `WindowClosedError` to
   `platforms/types.ts`; one `shouldNotifyAfterWindow` debounce replacing four
   copies; one `alertSuperAdmins`/notification service replacing four drifted
   variants (and collapse the router's `reserve*Slot` copies onto it); move
   `sanitizeName` out of `systemPrompt.ts`; move the WebSearch guard + rate-
   reservation helpers out of `tools.ts` into a base util; collapse the three
   retention sweeps into one parameterised helper; fix `grokImage.ts` to take
   an injected secret-paths list.
2. **Tool registry** (highest leverage single change): declarative `ToolDef`
   with `minTier`/`platforms`/`featureFlag`/`confirm`/`audit`/`capabilityLine`;
   derive `toolsForRole`, feature-flag filtering, and the `community_info`
   rundown from the registry. Split `tools.ts` into per-domain files as part
   of the move (the registry makes the megaclosure unnecessary). Kills the
   four-places-per-tool problem before anything else moves.
3. **Config split**: base schema + per-module zod slices, two-phase load
   (parse env → init modules with typed config), decouple storage/migrate
   config from `CLAUDE_CODE_OAUTH_TOKEN` (retires `migrate:ci`'s dummy token),
   move module-scope `config` reads to init-time (the
   `FEATURE_FLAGGED_TOOL_GROUPS` import-time trap).
4. **Storage split**: finish the `repository/` domain carve-out (the audit-L14
   work already in flight); schema fragments + concatenating migrator (still
   one atomic query — fragments must be byte-compatible with the already-
   applied prod schema); `PurgeContributor` + `onInteractionsDeleted` +
   `onMemberRemoved` hooks; provenance→trust as a registration
   (`'auto'`=quarantined, `'docs'`=trusted) instead of `!= 'auto'` in ~20
   queries; break the `repository.ts ⇄ docsIngest.ts` cycle.
5. **Jobs + composition root**: `JobSpec` registry, open job names,
   `index.ts` → `main(modules)`, single shutdown sweep.
6. **Strings catalogue + open locale axis**: notice catalogue; `'mi'`/`'plain'`
   become module-registered variants; `OutgoingMessage` gains an opaque render
   variant; adapters take injected text packs; `language_prefs` CHECK moves to
   the community fragment.
7. **Router split**: deps object (kill the 25 positional params), pre-turn
   intercept chain with the security spine fixed and non-reorderable,
   post-turn handler registry + generic turn-state bag (removes the five
   community fields from `AgentReply`), command registration (slash + `!`).
8. **Prompt/persona/skills seams**: slot-based `buildSystemPrompt` with the
   security clauses base-owned. ⚠️ Byte-stability is load-bearing for prompt
   caching — the assembler must produce byte-identical output per (role,
   policy, persona, day) and a test should pin it. Persona registration;
   skills manifest (`PROMPT_REVIEW_CLAUSE` + SKILL.md move together, keeping
   the byte-identity test).
9. **Adapter factory + platform-open types**: registry, capability-derived
   tool availability, `memberId.ts` heuristics become per-adapter.

### Phase 2 — two packages, one repo

> **DONE.** Two directories in one package, not npm workspaces — the workspace
> split buys nothing until Phase 3 actually publishes. What landed:
>
> - Every remaining base→community runtime edge was inverted FIRST, via
>   fail-loud registries (`registerToolTiers`, `registerToolServerParts`,
>   `registerFlaggedToolPredicates`, `registerNoticePack`,
>   `registerPolicyKeys`, `registerCommands`, `registerDefaultBadWords`, the
>   prompt-section slots, the persona/skills registries), plus the
>   `routerWiring.ts` composition extraction, the `commands/registry.ts` +
>   `platforms/discord/slashDispatch.ts` mechanism split, the
>   `storage/policyStore.ts`/`storage/policies.ts` split, the
>   `jobs/runner.ts`/`jobs/trackedJob.ts` mechanism split, adapter text packs
>   (including a language-keyed warn prefix, so no locale is named in a base
>   type) and a module-owned MCP server name.
> - The physical move: 121 files to `src/base/`, 64 to `src/module/`,
>   `src/index.ts` staying put as the composition root. All by `git mv`, so
>   history follows; the only content change was ~800 rewritten relative
>   specifiers.
> - The one-way rule enforced twice: an eslint `no-restricted-imports` block
>   on `src/base/**` (no `allowTypeImports`) and
>   `scripts/check-import-direction.mjs` (`npm run imports:check`, CI's lint
>   job), which resolves specifiers against the file system and also forbids
>   `src/module/` importing the composition root. Pinned by
>   `tests/importDirection.test.ts`.
> - Gate scripts grew the per-package roots they lacked
>   (`check-context-pack.mjs`'s repeatable `--src`,
>   `check-dist-schema.mjs`'s dist root), and the schema fragments moved whole
>   into `src/base/storage/schema/` keeping one ordered manifest —
>   per-module migration contribution is still Phase 3 work.
> - The anticipated `tests/security-floor.json` lowering never happened: the
>   test files themselves did not move, only the paths they import, so the
>   manifest is byte-identical across the whole phase and no
>   `allow-security-floor-lower` label was needed. `tsconfig.tests.json`
>   gained exactly one entry, for the new import-direction test.

Move files into `src/base/` and `src/module/` (or npm workspaces), add an
import-direction lint rule (module → base only), update `docs/agents/`
module-map, `tsconfig.tests.json` and `tests/security-floor.json` in the same
diffs (the floor's H1 lowering guard will require the `allow-security-floor-
lower` label + explanation for the test-file moves — plan one labelled,
explained migration PR rather than fighting the gate piecemeal). Gate scripts
grow the per-package roots they currently lack (`check-context-pack.mjs`
single-`src/` assumption, `check-security-test-count.mjs` hardcoded
`tests/`).

### Phase 3 — extract to agent-base

> **The runtime half is DONE.** `src/base/` is gone; `@swampratnz/agent-base`
> is a dependency; every `src/module/**` import points at it; `src/index.ts`
> composes through `createAgent({ modules: [nzCommunityModule] })` over ONE
> manifest (`src/module/agentModule.ts`); this deployment contributes its own
> schema fragments through `AgentModule.migrations`; and the residue §6 listed
> is resolved on the base side — `DISPLAY_TIMEZONE`/`DISPLAY_LOCALE`,
> `DOCS_INGEST_INDEX_URL` and `STATUS_CHECK_API_URL` are env, the gated-notice
> sentence and the `Community guidelines:` header are notice-pack entries
> (`gatedNoticeWithAdmins`, `guidelinesHeading`), and base's locale literals
> became `isRegisteredLanguage()`/`isRegisteredStyle()` probes over the
> registered axes.
>
> **Publish and subpath exports are DONE too.** `@swampratnz/agent-base@0.1.1`
> is on the public registry, `package-lock.json` carries its real `resolved`
> URL and `integrity` hash, and the package's own `exports` map publishes
> `./*` — so `@swampratnz/agent-base/<module>.js` resolves from the package
> and the postinstall shim that used to add that entry is deleted. 0.1.1 also
> made `AgentModule<Ctx>` generic, which retired this repo's one
> `toolServerParts` cast.
>
> What Phase 3 still owes, in rough order:
>
> - **The remaining §3 extension points.** `AgentModule` has no `configSchema`,
>   `adapters`, `jobs`, `ingestSources`, `digestSignals` or `moderationPolicy`
>   field, so those still bind through this repo's own wiring
>   (`platforms/factories.ts`, `jobs/registry.ts`, `routerWiring.ts`) against
>   base's fixed config schema.
> - **The pipeline as reusable workflows**, and the repo template, both
>   untouched.

- Lift `src/base/` + base tests + the injection corpus + gate scripts into
  `swampratnz/agent-base`; publish; this repo consumes the package and keeps
  a thin compatibility barrel so import sites don't churn.
- Pipeline as reusable workflows called with per-repo inputs: product-name
  string, VISION.md path, theme labels, dummy CI env block (better: a config
  CI mode so workflows stop enumerating app env vars), governance-path list.
  The `claude[bot]`/`github-actions[bot]` identity strings and marker-comment
  constants are load-bearing for auto-merge/handoff security — version them
  with the workflows, never template them per-repo.
- agent-base gets its own CI (same gates, empty ratchet-state files), its own
  SECURITY.md (the spine + pipeline threat model), and the repo template.

### Phase 4 — prove it

Scaffold the personal-finance agent from the template. It exercises every
seam: own tools with confirm/audit, own tables/migrations, own jobs, own
charter/persona/VISION, a compliance-flavoured inbound-policy hook, a
different status-page source, no te reo pack — a good test that the i18n and
moderation seams are genuinely optional. Treat any base patch the finance
agent needs as the seam-quality metric.

## 5. Risks and open questions

- **Prod DB continuity**: the fragments must replay byte-compatibly over the
  monolith-built schema (same discipline the schema comments already
  enforce). No table renames in phase 1–3.
- **Prompt-cache regression**: any prompt reassembly that isn't byte-stable
  silently doubles cost. Pin with a test before touching `systemPrompt.ts`.
- **Gate friction is a feature**: security-floor moves, module-map updates and
  the tests-include ratchet will red every extraction PR that forgets them —
  that's the designed behaviour; budget for it in each PR rather than
  batching.
- **Subscription-auth caveat** (README): the auth isolation should be a base
  property — keep the API-key switch easy in `agent-base` from day one.
- **Versioning across repos**: once split, a base change that community needs
  lands as publish → bump. Mitigations: changesets + a canary job in
  agent-base that builds community-agent against HEAD.
- Open: monorepo-with-workspaces in agent-base vs one package; whether the
  team-projects subsystem ships in core or as a first-party optional module
  (same question for image-gen, dev-team, github-issues — recommend:
  optional first-party modules in the agent-base repo, which also
  dog-foods the module API).

## 6. Known residue after Phase 2 (inherited by Phase 3)

Phase 2's contract was **no import edge from `src/base/` to `src/module/`**,
and that holds — `npm run imports:check` proves it on every CI run. It is a
weaker property than "`src/base/` contains nothing community-specific", and
the gap is listed here honestly rather than left for Phase 3 to rediscover.
None of it blocks the lift; all of it would embarrass a second agent built on
the base.

**Locale literals still branching inside base.** The notice catalogue made the
language/style axes open and module-registered, and every notice *string* is
module-side. What remains is base code branching on the two literal axis
values to decide which variant to ask for: `src/base/router.ts` (a dozen
`lang === 'mi'` branches), `src/base/agent/core.ts`
(`languagePreference === 'mi'`, `responseStyle === 'plain'`),
`src/base/agent/systemPrompt.ts`'s `'response-style'`/`'language-preference'`
slot selectors, and `src/base/moderation/moderator.ts`'s `lang !== 'mi'`
precedence check. A finance agent with no te reo pack gets dead branches, not
wrong behaviour. The fix is to push variant selection behind the catalogue
(select by the caller's raw preference, let the pack decide) rather than to
add more axis values to base.

**Hardcoded community values in base.**

- `src/base/gatedNotice.ts` — the static fallback is a catalogue entry, but
  `renderGatedNotice`'s dynamic admin-naming variant builds its sentence
  ("Kia ora! This assistant is member-only. Ask a community admin — … — to add
  you as a member and I can help.") inline in base.
- `src/base/util/nzTime.ts` — `Pacific/Auckland` is pinned as *the* timezone,
  not injected.
- `src/base/config/knowledge.ts` — defaults the docs index to
  `https://platform.claude.com/llms.txt` and the status feed to
  `https://status.claude.com/api/v2/summary.json`. Overridable by env, but the
  default is an Anthropic URL in a framework file.
- The literal `Community guidelines:` join header, duplicated across
  `src/base/router.ts` and all three adapters.

**Community field NAMES in base contracts.** `CommunityPromptSections`
(`src/base/agent/promptSpine.ts`) declares slots called `charter`,
`communityConduct`, `promptReviewClause`, `miLanguagePreference`; the
`community_users` table name stays as-is by the §Phase-0 decision. These are
structural types and physical table names — base declares the shape, the
module supplies the value, and there is no import edge either way — so this is
naming residue, not coupling. Renaming is cosmetic and is best done at the
package boundary, where the names become public API.

**Schema is still one manifest.** `src/base/storage/schema/` holds the
community fragments (`50`–`54`) alongside the base ones and replays them as
one atomic query. Per-module migration contribution is explicitly Phase 3
work (§3, `migrations` row).
