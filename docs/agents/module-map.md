# Module map

One line per module, so a cold session can find the right file without
grepping the whole tree. Read [`README.md`](README.md) first for how to use
this and [`recipes.md`](recipes.md) for the shape of a typical change.

**This file is gated.** `npm run context:check` (part of CI's lint job) fails
if a subsystem or top-level module of `src/`, `src/base/` or `src/module/` has
no entry, if an entry names a path that no longer exists, or if entries are
unsorted, duplicated, or left as stubs. `npm run context:fix` adds/drops/sorts
entries mechanically — it cannot write the description, which is the part that
matters.

The tree has two halves and one composition root. **`src/base/`** is the
community-agnostic framework; **`src/module/`** is this deployment's NZ Claude
Community content and wiring; **`src/index.ts`** is the composition root that
may import both. The import rule is one-way — base may never import module —
and it is enforced twice, by eslint and by
`scripts/check-import-direction.mjs`.

Two things this map deliberately does **not** try to be:

- **A substitute for reading the code.** It tells you which file to open, not
  what the code says. Never assert behaviour from a one-liner here.
- **Complete.** Nested files inside a subsystem are called out only where the
  subsystem is big enough that "look in `src/base/agent/`" is not an answer.

The security spine — the paths where a mistake is a security bug, not a bug —
is marked **🔒**. Changes there need a `SECURITY:` test (see
[`../../CLAUDE.md`](../../CLAUDE.md)).

<!-- module-map:begin -->

- `src/base/` — The community-agnostic framework half of the tree (agent-base plan §Phase-2): agent kernel, platform adapters, storage, router spine, jobs, auth, config, util. It may NEVER import from `src/module/` — enforced by eslint and `scripts/check-import-direction.mjs`.
- `src/base/ackClassifier.ts` — Deterministic "is this just 'thanks'?" classifier; lets the router skip a whole agent turn (and its cost) on a pure acknowledgement.
- `src/base/agent/` — 🔒 The Claude Agent SDK integration: system prompt spine and slot assembler, the tool-hosting kernel, the confirm flow, outbound filtering, the WebSearch guard. Most security-relevant subsystem — see the per-file entries below.
- `src/base/agent/core.ts` — 🔒 Builds the per-turn `query()` options (model, tools, plugins/skills, session tail) and runs the agent turn. Tool surface is derived from the caller's tier here.
- `src/base/agent/featureFlags.ts` — Base feature-flag predicate slot: core.ts's subtractive per-turn filter reads `flaggedToolPredicates()` from here, registered by the tool registry at import time (fail-loud before registration).
- `src/base/agent/outbound.ts` — 🔒 The outbound reply filter (secret redaction + behaviour policy) applied to every message the bot sends. Deterministic, and deliberately not something the model can talk its way past.
- `src/base/agent/pendingActions.ts` — 🔒 The confirm-before-destructive flow: destructive tools register a pending action for the router to execute after an explicit confirmation, rather than firing directly.
- `src/base/agent/personaRegistry.ts` — The base persona registry mechanism: append-only, id-unique registration with a single immutable default; `getPersona`/`selectPersona` resolve over whatever roster the community file registered. Voice only, never authority.
- `src/base/agent/promptSpine.ts` — 🔒 The system prompt's base-owned security spine (injection-defence/RBAC clauses at hard-coded positions) plus the closed community-section slot registration; no registration can reorder, rename, or precede a spine clause.
- `src/base/agent/rateReservers.ts` — The two media-input reservation caps (per-sender daily image-input and hourly voice-transcription reservers) the platform adapters check before any media download.
- `src/base/agent/secrets.ts` — 🔒 `runtimeSecrets()`: the exact-value secret list the outbound filter redacts as a backstop against unknown egress paths. Add every new outward credential here.
- `src/base/agent/skillsManifest.ts` — 🔒 Skills manifest registration (`{skillsDir, enabledSkills}`) consumed by core.ts; owns the never-`'all'` allowlist invariant and freezes the registered list so a module can never widen skill activation.
- `src/base/agent/systemPrompt.ts` — 🔒 The slot assembler for the system prompt: frozen top-level slot order over `promptSpine.ts`'s security spine, registered community sections (including the style/language slot bodies), persona voice and role/policy notes — no community prose lives here. Byte-stability per (role, policy, persona, day) is pinned by `tests/systemPromptByteStability.test.ts`.
- `src/base/agent/toolServer.ts` — 🔒 The base tool-hosting kernel: `buildToolServer` composes the per-turn MCP server from the module-registered parts (`registerToolServerParts` — server name, registry, context factory), failing closed until the tool registry has been imported.
- `src/base/agent/tools/types.ts` — `ToolDef`/`ToolContext`/`defineTool`: the declarative registry's type surface (docs/TOOL-REGISTRY-DESIGN.md).
- `src/base/agent/turnState.ts` — Base half of the generic turn-state bag: empty module-augmentable `ToolServerTurnState`/`TurnStateBag` interfaces and the finalizer registry `execTurn` runs on the genuine-success path only.
- `src/base/agent/webSearchGuard.ts` — 🔒 The WebSearch PreToolUse guard: per-conversation hourly volume cap, exact-then-embedding query dedup, and the per-conversation lock keeping check-then-record atomic. Fail-closed by contract — a thrown `embed()` denies the call.
- `src/base/auth/` — 🔒 Identity and role resolution: tiers come from env plus the `community_users` table, never from message content. Four files, all small and worth reading in full — `tiers.ts` is the dependency-free tier lattice (`atLeast`/`assertAtLeast`, imported by the tool domain files); `rbac.ts`'s tier lists are REGISTERED by the tool registry (`registerToolTiers`, called at src/module/agent/tools/index.ts module scope) and `toolsForRole` fails closed until that registration has run; `memberId.ts` is a thin, fail-closed dispatcher over the platform registry's per-adapter member-id rules (`src/base/platforms/*/memberIdRules.ts`).
- `src/base/backgroundJobCostAlert.ts` — Alerts super admins when background-job spend crosses a configured threshold, so an expensive job cannot run up cost unnoticed.
- `src/base/backgroundJobHealth.ts` — Pure consecutive-failure debounce tracker for scheduled jobs, so one outage produces one alert rather than an alert per tick.
- `src/base/budgetCheckFailureNotice.ts` — Pure debounce for the single super-admin DM sent when the daily reply-budget check itself fails (a systemic condition, not a per-user one).
- `src/base/commands/` — The base command-registry mechanism: the `TEXT_COMMAND_UNMATCHED` sentinel, the handler/binding/`RegisteredCommand` types, the fail-loud `registerCommands`/`registeredCommands` slot both command surfaces read, and the `bindDiscordCommand` late-binding hook.
- `src/base/commands/registry.ts` — The one file in `src/base/commands/` today — see the subsystem entry above.
- `src/base/config.ts` — The composition barrel: merges the per-domain slice fragments from `src/base/config/` into the full env schema, applies the cross-slice refine, parses once (fail-fast on a bad deploy), and exports the `config` singleton plus the pure `loadConfig(env)`.
- `src/base/config/` — Per-domain zod slice fragments (each var's chain + doc comment lives with its domain) and their slice-local refinements; `env.ts` owns the one dotenv load + blank-normalisation. Adding a setting starts in the right slice here.
- `src/base/config/boot.ts` — Boot-path config: validates ONLY the db+log slices so `logger.ts`/`storage/db.ts`/`storage/migrate.ts` run with just `DATABASE_URL` — what lets a bare `npm run migrate` work without the app's other required vars.
- `src/base/context/` — What is left of the context loop once the community sources moved out: the import-free docs-ingest chunk-title leaf shared by ingestion and the knowledge repository.
- `src/base/context/docTitles.ts` — Import-free leaf for docs-ingest chunk-title helpers (`pageKeyOf`); shared by docsIngest.ts and repository/knowledge.ts so neither imports the other (the old repository ⇄ docsIngest cycle).
- `src/base/crashHandlers.ts` — Installs handlers for unhandled rejections and uncaught exceptions, so a process death always leaves a logged reason.
- `src/base/dailyBudgetNotice.ts` — Static text for the daily reply-budget notice; the 24h debounce window itself is tracked inline by the router.
- `src/base/dailyReplyBudgetWarning.ts` — The short warning line appended to a real reply as a member approaches their daily budget, so the cutoff is not the first sign a limit exists.
- `src/base/gatedNotice.ts` — The message shown to a guest whose request needs a tier they do not have, including who to ask for access.
- `src/base/health.ts` — The HTTP health server (`/healthz`) and the adapter/DB probes behind it.
- `src/base/healthState.ts` — Pure health logic (disconnect debounce, payload shape), kept import-free of config and HTTP so it is directly unit-testable.
- `src/base/jobs/` — The background-job mechanism: `JobSpec` (open name, declarative gate, self-owned cadence) in `types.ts`, the generic start/stop sweeps in `runner.ts`, and the shared tracked-job wrapper in `trackedJob.ts`.
- `src/base/jobs/runner.ts` — The base job-runner mechanism: `startRegisteredJobs(specs, adapters)`/`stopRegisteredJobs(started)` sweep whatever spec list the composition root passes (index.ts passes `JOB_REGISTRY`) — it never imports the community job list itself.
- `src/base/jobs/trackedJob.ts` — `startTrackedJob`: the shared 6h tick + consecutive-failure tracker/alert wrapper most job starters use, plus the queue-on-outage super-admin alert helper the bespoke pollers share.
- `src/base/logger.ts` — The pino logger plus the hashing helper used to keep identifiers out of logs.
- `src/base/media/` — Local-only media handling that carries no community content: Whisper voice transcription for WhatsApp notes, decoded on-host and never shipped to a third party.
- `src/base/moderation/` — Two-stage moderation: a zero-cost wordlist pass, then a model pass, with admins and super admins exempt. The enforcer is injected so the platform side stays swappable.
- `src/base/mutedRoleAlertNotice.ts` — Pure debounce for the super-admin alert raised when Discord muted-role permission overwrites exhaust their retries.
- `src/base/notifications.ts` — The shared super-admin DM fan-out every alert producer delegates to (connected-adapters-only, window-reopen queueing, optional queue-on-outage), plus the rolling-hour alert-slot reserver factory behind the router's and moderator's guild-wide alert caps.
- `src/base/pauseNotice.ts` — Pure debounce for the "the bot is paused" reply, on a longer window than the rate-limit notice because a pause is longer-lived.
- `src/base/pendingAlertQueue.ts` — Best-effort queue for super-admin alerts raised while every adapter was disconnected, so an alert during an outage is not simply lost.
- `src/base/platforms/` — 🔒 The platform abstraction plus the Discord and WhatsApp (Baileys and Cloud API) adapters and the slash-command dispatch mechanism. Adapters own the send path, so outbound filtering and chunking live at their edges.
- `src/base/platforms/registry.ts` — 🔒 The lightweight platform registry: per-platform descriptors (id + member-id rules, no heavy adapter imports), `KNOWN_PLATFORMS`, and `assertToolAvailabilityConsistent` — the startup/test invariant that every ToolDef platform restriction is derived from declared adapter capabilities, since `Platform` is an open string now.
- `src/base/platforms/types.ts` — 🔒 The `IncomingMessage` / `PlatformAdapter` contract every adapter normalises into, the open `Platform` string type (registry-validated, closed zod enums at the model boundary), and the `PlatformMemberIdRules` contract the per-platform `memberIdRules.ts` modules implement. Identity fields here are the only trusted source of who is speaking.
- `src/base/rateLimitNotice.ts` — Pure debounce for the per-user rate-limit notice, so a burst of over-limit messages yields exactly one notice.
- `src/base/replyRetraction.ts` — In-memory, TTL'd, size-capped map from an inbound message to the bot's reply, so a reply can be retracted when the prompt that caused it is deleted.
- `src/base/retention.ts` — All three age-based retention sweeps (interactions per SECURITY.md's promise, departed roster rows, stale pending access requests) as one parameterised daily job; each purge is gated only on its own days config, so disabling one never suppresses another.
- `src/base/router.ts` — 🔒 The hot path: every inbound message lands here. The pre-turn sequence now runs as the named intercept chain from `routerIntercepts.ts` (spine steps + registered shortcuts), then the agent call and the post-turn alert/record sequence.
- `src/base/routerIntercepts.ts` — 🔒 The pre-turn intercept chain contract: the frozen security-spine order (`PRE_TURN_SPINE` — block → role → gate → CONFIRM → … → budget, non-reorderable, pinned by a SECURITY: test) plus the append-only post-spine registry community shortcuts/commands register into.
- `src/base/storage/` — 🔒 Postgres + pgvector: the pool, the schema fragments + concatenating migrator, local embeddings, the policy-store mechanism, and the repository that owns every query. Admin-facing reads are conversation-scoped in SQL here.
- `src/base/storage/lifecycle.ts` — 🔒 The storage lifecycle registries: purge contributors (forget_me/purge_user_data's per-domain deletes + my_data summaries, order-pinned), interactions-invalidated hooks, member-removed and roster-leave hooks. Part of the purge path — the erasure promise is only as complete as what registers here.
- `src/base/storage/policyStore.ts` — The runtime-policy mechanism: 30s-TTL cached reads/writes over the `policies` table, the base keys (`code_answers`, `paused`) with their accessors, and `registerPolicyKeys` for module keys — the community keys + typed accessors live in `policies.ts`, which registers at its own import time. Reads/writes of an unregistered key THROW (fail loud), and `resetPolicyCacheForTests` lives here.
- `src/base/storage/provenance.ts` — 🔒 Provenance→trust registration for `knowledge.created_by_role` (`trustOf`): 'auto' quarantined, 'docs' + the RBAC tier strings trusted, UNKNOWN values fail closed to quarantined. The TS half of the quarantine boundary; the SQL `!= 'auto'` predicates deliberately stay SQL.
- `src/base/storage/repository.ts` — 🔒 The repository barrel every caller imports: PURE `export *` lines over the per-domain modules in `repository/` — no query bodies live here anymore. Conversation scoping for admin reads is enforced in the queries themselves, not by callers.
- `src/base/storage/repository/` — 🔒 The per-domain query modules the audit-L14 carve-out produced (complete — `repository.ts` is now only the barrel). Add a new query to its domain module here; everything is re-exported so import sites never change.
- `src/base/storage/repository/interactions.ts` — 🔒 The raw interaction archive: recordInteraction, semantic memory search, recap/tail reads, and the platform delete/edit honouring paths (scoped to platform+conversation+message id).
- `src/base/storage/repository/projects.ts` — 🔒 Project shared memory (issue #927). `visibleProjectIds` is the one place the two access checks live — membership (expanded through linked `persons`) and surface (a bound conversation or a DM) — and every read/write here goes through it in SQL.
- `src/base/storage/repository/whatsappLidMap.ts` — 🔒 Durable WhatsApp LID -> phone mapping. A LID is a privacy id that looks like a number but matches no one; persisting what the adapter learns from real envelopes lets a LID be resolved rather than refused. PII — erased by `forget_me`/`purge_user_data`. See docs/SECURITY.md §6b.
- `src/base/storage/schema/` — 🔒 The schema as ordered SQL fragments (00–27 base, 50–54 community, 70 adapter — the gaps are deliberate) concatenated by `manifest.ts` and replayed by `migrate.ts` as ONE atomic query on every deploy. Every statement stays `IF NOT EXISTS`; new fragments must be added to the manifest's explicit array (never a glob — order is load-bearing), and a fragment missing from it fails the sync test.
- `src/base/strings/` — The notice-catalogue mechanism: `notice(id, {language, style})` over whatever pack a module registered, owning the "'mi' beats 'plain', default English" precedence. Unregistered reads THROW rather than render blank text.
- `src/base/usageAlert.ts` — Usage-threshold alerting to super admins with a debounce tracker shared by several other alert modules.
- `src/base/util/` — Shared leaf helpers with no dependencies of their own: NZ-timezone rendering, the `shouldNotifyAfterWindow` notice debounce, the rate-reservation primitives, and the display-name sanitiser (see entries below).
- `src/base/util/rateReservation.ts` — 🔒 The three in-memory rate-cap primitives (sliding window, UTC calendar day, per-key cooldown) behind every tool/adapter reservation cap. Reservations are never refunded on failure, so induced-failure retries can't bypass a cap.
- `src/base/util/sanitizeName.ts` — 🔒 Neutralises attacker-controlled display names (bracket stripping, whitespace/NEL collapse, hard truncation) before they are interpolated anywhere the model or another member reads them. Every rendered name goes through here.
- `src/base/voiceLanguageCaveatNotice.ts` — Fixed caveat DM for a te reo Māori speaker sending a voice note, because the transcription model is English-only and would otherwise fail silently.
- `src/index.ts` — Process entry point, now a thin composition root: loads config, wires adapters and the router, starts the job registry (`src/base/jobs/` + `src/module/jobs/`), and owns the single shutdown sweep's ordering.
- `src/module/` — The NZ-Claude-Community half of the tree: this deployment's tools, prose, jobs, personas, skills and the composition wiring that names them. Free to import base; nothing in base may import back.
- `src/module/adminDigest.ts` — Builds and sends the periodic admin digest: moderation, engagement, feedback and cost summaries for admins, scoped to their own conversations.
- `src/module/adminLeverageAlert.ts` — Weekly super-admin push of `adminActivitySummary`'s actions-per-admin rate, the pull-to-push complement of the on-demand `admin_activity` tool.
- `src/module/agent/` — The community half of the agent surface: the tool registry and its per-domain ToolDef files, the prompt sections, persona roster, turn-state keys, skills bundle and changelog reader.
- `src/module/agent/communityPromptSections.ts` — The ONE community-owned prompt-sections file (plan §3 `promptSections`): charter, the community behaviour-guideline chunks, web-search authority domains, PROMPT_REVIEW_CLAUSE, the NZ date grounding, and the plain-style/NZ-English/te reo Māori preference prose, registered into `promptSpine.ts`'s closed slot set.
- `src/module/agent/communityTurnState.ts` — The ONE community-owned turn-state file (plan §3): `declare module` augmentation typing the five community keys on `ToolServerTurnState`/`TurnStateBag`, plus the registered finalizer that maps tool scratch state onto `AgentReply.turnState`.
- `src/module/agent/personas.ts` — The community persona roster: registers today's set (Dave, the default) into `personaRegistry.ts` and re-exports the resolution API for unchanged import sites; content only, never authority over the security section.
- `src/module/agent/skills/` — 🔒 One `SKILL.md` per Agent Skill, plus the plugin manifest. Loaded only when `AGENT_SKILLS_ENABLED`, and only the hand-written `ENABLED_SKILLS` allowlist in `core.ts` — never derived from request content.
- `src/module/agent/tools.ts` — The barrel for the tool-registry split: re-exports every moved helper/notify/registry symbol (plus `buildToolServer` from the base kernel) and loads the registry's module-scope registrations. Find your tool by name in `src/module/agent/tools/` before reading anything else.
- `src/module/agent/tools/accessAndSuggestions.ts` — The `list_access_requests`/`list_suggestions`/`resolve_suggestion` ToolDef domain: guest access-request and member-suggestion triage.
- `src/module/agent/tools/activity.ts` — The `whats_new`/`user_history` ToolDef domain: the bot's own changelog plus scoped per-member message history for moderation.
- `src/module/agent/tools/appealsAdmin.ts` — The `list_appeals`/`resolve_appeal` ToolDef domain: the admin review side of the appeal_moderation queue, with the origin-platform resolution DM.
- `src/module/agent/tools/broadcast.ts` — The `announce`/`create_poll`/`end_poll`/`create_thread`/`archive_thread` ToolDef domain plus their per-conversation sliding-hour reservers and rate/bound constants.
- `src/module/agent/tools/context.ts` — 🔒 `makeToolContext`: the per-turn tool kernel — owns `audited` (audit row + super-admin alert pairing) and `requireConfirm` (the CONFIRM gate's forgeable-pending-notice sanitize strip), plus `adapterFor`/`callerScope`/`resolveMemberTarget`.
- `src/module/agent/tools/devTeam.ts` — The `dev_team_*` ToolDef domain (dispatch/status/result/backlog/findings/verify) plus its per-super-admin daily dispatch reserver.
- `src/module/agent/tools/digestMember.ts` — The `community_digest` ToolDef domain: on-demand pull of the weekly member digest, quarantined before it re-enters model context.
- `src/module/agent/tools/digestsAdmin.ts` — The `question_digest`/`admin_digest`/`review_queue`/`response_latency` ToolDef domain: read-only, callerScope-bounded admin signal roll-ups.
- `src/module/agent/tools/discordRoles.ts` — The `assign_community_role`/`remove_community_role`/`list_assignable_roles` ToolDef domain (Discord-only cosmetic roles) with the local allowlist guard.
- `src/module/agent/tools/events.ts` — The `create_event`/`cancel_event` ToolDef domain (Discord Scheduled Events, both CONFIRM-gated) plus the event field-bound constants.
- `src/module/agent/tools/feedback.ts` — The `suggest_improvement`/`rate_answer`/`request_human_help` ToolDef domain, plus the per-caller human-help daily reserver and its exported limit.
- `src/module/agent/tools/helpers.ts` — Module-scope pure helpers shared by tool domains: `text()`/`untrusted()` result wrappers, the knowledge/usage/dev-team formatters, the feature-flag allowlists, and shared zod fragments.
- `src/module/agent/tools/imageGen.ts` — The `generate_image` ToolDef domain plus its in-flight set and per-user daily reserver.
- `src/module/agent/tools/index.ts` — 🔒 `TOOL_REGISTRY`: the declarative tool inventory composed from the per-domain ToolDef arrays — the single source of truth rbac.ts's tier arrays, the Discord-only platform filter, the base kernel's tool-server parts and the feature-flag predicates are all registered from at module scope (invariants pinned by `tests/toolRegistry.test.ts`).
- `src/module/agent/tools/info.ts` — The `community_info`/`community_guidelines`/`check_status`/`list_events` ToolDef domain, owning the static per-tier capability rundown texts.
- `src/module/agent/tools/knowledgeAdmin.ts` — The admin knowledge-curation ToolDef domain: save/list/update/delete/merge knowledge, duplicate/conflict/gap audits, the candidate review queue, and answer-feedback roll-ups.
- `src/module/agent/tools/knowledgeMember.ts` — The member-facing knowledge ToolDef domain: `knowledge_search` (with its turn-state gap/stale correlation writes), `list_knowledge_topics`, `suggest_knowledge`, `withdraw_knowledge_tip`.
- `src/module/agent/tools/membership.ts` — The `add_member`/`remove_member`/`link_member`/`unlink_member` ToolDef domain: community membership and cross-platform identity linking.
- `src/module/agent/tools/memory.ts` — The `remember_search`/`catch_up` ToolDef domain: recall over past interactions, with the shared per-message truncation cap and the catch_up window/row limits.
- `src/module/agent/tools/moderation.ts` — The `moderate`/`clear_warnings`/`list_member_warnings`/`list_muted_members`/`list_blocked_members`/`moderation_history` ToolDef domain plus the per-conversation warn reserver.
- `src/module/agent/tools/notify.ts` — The notify family (super-admin/admin fan-out, approval/resolution DMs) with window-reopen queueing, plus `applyManualWarnStrike`/`ackReportedMessage` side-effect helpers.
- `src/module/agent/tools/policyText.ts` — The `set_community_guidelines`/`set_welcome_message` ToolDef domain plus the two Discord-message-limit-derived text caps.
- `src/module/agent/tools/prefs.ts` — The `set_response_style`/`set_language_preference` ToolDef domain: self-scoped, closed-enum standing preferences.
- `src/module/agent/tools/projectNotes.ts` — The `project_recall`/`project_note`/`project_list` ToolDef domain: team-project shared memory, access-scoped in SQL via `visibleProjectIds`.
- `src/module/agent/tools/projectsAdmin.ts` — The `project_*` admin ToolDef domain (create/add/remove member, bind/unbind, info, archive/unarchive): team-project membership and surface bindings, never tiers.
- `src/module/agent/tools/reactions.ts` — The `react_to_message` ToolDef domain plus its closed emoji allowlist and per-user daily reaction reserver.
- `src/module/agent/tools/reportsAdmin.ts` — The `list_reports`/`resolve_report` ToolDef domain: content-report triage with the linked-identity accused-admin exclusion.
- `src/module/agent/tools/reportsMember.ts` — The `report_content`/`withdraw_report`/`appeal_moderation` ToolDef domain plus the per-caller appeal cooldown reserver.
- `src/module/agent/tools/roster.ts` — The `add_member_note`/`list_member_notes`/`delete_member_note`/`list_roster`/`list_context_digests` ToolDef domain: admin-curated member context and roster views.
- `src/module/agent/tools/selfService.ts` — The `forget_me`/`my_submissions`/`my_warnings`/`my_data` ToolDef domain: the caller's own data, always self-scoped.
- `src/module/agent/tools/social.ts` — The member-discovery ToolDef domain: interests (`set_my_interests`/`who_is_into`), peer help (`set_helper_availability`/`find_helper`), and the project showcase (`share_project`/`list_projects`/`request_project_connection`).
- `src/module/agent/tools/superAdmin.ts` — The super-admin ToolDef domain (grant/revoke admin, purge, audit/usage/engagement views, pause/resume, set_policy, redeploy, suggest_issue) plus the per-super-admin daily issue reserver.
- `src/module/backgroundJobs.ts` — The knowledge/context/status/dev-team job run functions and their `JobSpec` entries; the shared tracked-job wrapper they start through lives in `src/base/jobs/trackedJob.ts`.
- `src/module/commands.ts` — The community command list (plan §3 `commands` row): the ordered `{name, platforms, handler}` entries (kb, projects, whois, guidelines, digest) plus `WhatsAppTextCommandDeps`, self-registered into `base/commands/registry.ts` at module scope; WhatsApp handlers live here verbatim, Discord halves are bound by slashCommands.ts.
- `src/module/context/` — The community-context learning loop: nightly digest builder, knowledge refresh, Anthropic docs ingest, link-rot check, and the PII-scrubbed export that is the DB-to-repo privacy boundary.
- `src/module/departedAdminAlert.ts` — Watches the admin roster and alerts super admins when someone holding admin has left the server, so stale privilege is noticed.
- `src/module/devTeam/` — Typed HTTP client for the remote dev-team dispatch service behind the super-admin `dev_team_*` tools. Codes to a frozen contract — do not drift it casually.
- `src/module/engagementAlert.ts` — Threshold alerting on community engagement statistics, reusing the usage-alert debounce shape.
- `src/module/github/` — 🔒 GitHub issue creation for the super-admin `suggest_issue` tool. The bot's only GitHub egress and its only write credential; the token is fine-grained and issues-scoped.
- `src/module/jobs/` — The pinned-order community `JOB_REGISTRY` list — only the ORDER lives here; each spec lives with the job module that owns it.
- `src/module/media/` — The Grok image-generation client behind the `generate_image` tool — an optional product integration, not framework (agent-base plan §5).
- `src/module/memberDigest.ts` — The member-facing digest of recent community activity, built from PII-scrubbed aggregates rather than raw messages.
- `src/module/moderation/` — The community-owned default bad-word list registered into the wordlist's fail-loud slot; operators still extend it with MODERATION_BAD_WORDS.
- `src/module/moderation/badWords.ts` — The community-owned default bad-word list, registered into `moderation/wordlist.ts`'s fail-loud slot at import time; operators still extend it with MODERATION_BAD_WORDS.
- `src/module/platforms/` — The community half of the platform layer: the adapter text packs, the Discord slash-command handlers, the adapter factory composition and the WhatsApp linking CLI.
- `src/module/platforms/factories.ts` — The heavy half of the platform registry: the `AdapterFactory` registrations (Discord + the WhatsApp baileys/cloud/disabled provider switch) with each platform's declared tool-capability union and each adapter's injected text pack (`textPacks.ts`), and `createConfiguredAdapters()`, which index.ts composes instead of constructing adapters inline.
- `src/module/platforms/textPacks.ts` — The community-owned adapter text packs (plan §3 `textPacks`): the join-welcome and manual `warn_user` DM strings for Discord, Baileys and WhatsApp Cloud, injected by `factories.ts` into each adapter's now-required text-pack constructor parameter.
- `src/module/routerWiring.ts` — The router's production wiring: `makeRouterDeps`, the ONE place the real implementation behind every `RouterDeps` field is named, so the router mechanism itself never imports the community content its defaults point at; `index.ts` (and every router test) composes `new Router(makeRouterDeps(...))`.
- `src/module/status/` — Anthropic status-page check behind the "is it me or is Anthropic down?" answer, with its own cache so a common question costs nothing.
- `src/module/storage/` — The community-owned policy keys (guidelines and welcome message, plus their te reo Māori variants) and their typed accessors, registered into the base policy store at import time.
- `src/module/strings/` — The community notice pack: every notice's English/mi/plain text verbatim, plus the `NoticeIdMap` augmentation that keeps per-id return types.
- `src/module/usageCostDigest.ts` — The periodic cost digest (spend, cache hit rate) sent to super admins.

<!-- module-map:end -->

## Outside the checked region

Not gated (these move rarely, and the linked docs describe them far better
than a one-liner could):

| Path | What it is |
|---|---|
| `.github/workflows/` | The pipeline. `docs/PIPELINE.md` is the authority — read it, not the YAML, unless you are changing the YAML. |
| `scripts/` | Repo gates and helpers: the security-test floor, changelog coverage, pipeline outcomes, this pack's checker, handoff notes. |
| `tests/` | ~160 `*.test.ts` files, one concern each, named after what they cover. `tests/security-floor.json` is the per-file `SECURITY:` test manifest. |
| `deploy/` | systemd unit and deploy assets for the production host. |
| `audit/` | Point-in-time security audit records. |
| `docs/` | `ARCHITECTURE.md` and `SECURITY.md` are the deep references; both are large, so search them rather than reading front to back. |
