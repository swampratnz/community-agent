# Module map

One line per module, so a cold session can find the right file without
grepping the whole tree. Read [`README.md`](README.md) first for how to use
this and [`recipes.md`](recipes.md) for the shape of a typical change.

**This file is gated.** `npm run context:check` (part of CI's lint job) fails
if a subsystem or top-level module of `src/` or `src/module/` has
no entry, if an entry names a path that no longer exists, or if entries are
unsorted, duplicated, or left as stubs. `npm run context:fix` adds/drops/sorts
entries mechanically — it cannot write the description, which is the part that
matters.

The framework is **`@swampratnz/agent-base`**, consumed as a package — read
its own docs for anything under it. What lives here is **`src/module/`**, this
deployment's NZ Claude Community content and wiring, plus two files at the
root: **`src/index.ts`**, the composition root, which hands
`src/module/agentModule.ts`'s manifest to the package's `createAgent`, and
**`src/migrate.ts`**, the schema entry point. `src/base/` is GONE and must stay
gone — `scripts/check-import-direction.mjs` fails the build if it reappears,
and also enforces that only the composition root composes.

Two things this map deliberately does **not** try to be:

- **A substitute for reading the code.** It tells you which file to open, not
  what the code says. Never assert behaviour from a one-liner here.
- **Complete.** Nested files inside a subsystem are called out only where the
  subsystem is big enough that "look in `src/module/agent/`" is not an answer.

The security spine — the paths where a mistake is a security bug, not a bug —
is marked **🔒**. Changes there need a `SECURITY:` test (see
[`../../CLAUDE.md`](../../CLAUDE.md)).

<!-- module-map:begin -->

- `src/index.ts` — Process entry point, now a thin composition root: loads config, wires adapters and the router, starts the job registry (agent-base's jobs mechanism + `src/module/jobs/`), and owns the single shutdown sweep's ordering.
- `src/migrate.ts` — `npm run migrate`: applies agent-base's schema fragments then this module's (`src/module/storage/schema/`) as ONE atomic query. Deliberately imports nothing but the storage slice, so a bare migrate still needs only `DATABASE_URL`.
- `src/module/` — The NZ-Claude-Community half of the tree: this deployment's tools, prose, jobs, personas, skills and the composition wiring that names them. Imports the framework from the `@swampratnz/agent-base` package; may never import the composition root (`src/index.ts`) or call `createAgent` itself — it contributes `agentModule.ts`'s manifest and nothing composes but the root.
- `src/module/adminDigest.ts` — Builds and sends the periodic admin digest: moderation, engagement, feedback and cost summaries for admins, scoped to their own conversations.
- `src/module/adminLeverageAlert.ts` — Weekly super-admin push of `adminActivitySummary`'s actions-per-admin rate, the pull-to-push complement of the on-demand `admin_activity` tool.
- `src/module/agent/` — The community half of the agent surface: the tool registry and its per-domain ToolDef files, the prompt sections, persona roster, turn-state keys, skills bundle and changelog reader.
- `src/module/agent/communityPromptSections.ts` — The ONE community-owned prompt-sections file (plan §3 `promptSections`): charter, the community behaviour-guideline chunks, web-search authority domains, PROMPT_REVIEW_CLAUSE, the NZ date grounding, and the plain-style/NZ-English/te reo Māori preference prose — exported as `COMMUNITY_PROMPT_SECTIONS` for the manifest, which fills base's closed slot set (`promptSpine.ts`).
- `src/module/agent/communityTurnState.ts` — The ONE community-owned turn-state file (plan §3): the `declare module` augmentation typing the keys this deployment's tools WRITE on `ToolServerTurnState` (agent-base declares the five reply-side `TurnStateBag` keys its router reads), plus the finalizer the manifest registers, which maps tool scratch state onto `AgentReply.turnState`.
- `src/module/agent/personas.ts` — The community persona roster: today's set (Dave, the default) as `COMMUNITY_PERSONAS` for the manifest, plus a re-export of base's resolution API so import sites are unchanged; content only, never authority over the security section.
- `src/module/agent/skills/` — 🔒 One `SKILL.md` per Agent Skill, plus the plugin manifest. Loaded only when `AGENT_SKILLS_ENABLED`, and only the hand-written `ENABLED_SKILLS` allowlist in `enabledSkills.ts` (registered into base's `skillsManifest.ts`, which enforces never-`'all'`) — never derived from request content.
- `src/module/agent/tools.ts` — The barrel for the tool-registry split: re-exports every moved helper/notify/registry symbol, plus `buildToolServer` from the base kernel. Find your tool by name in `src/module/agent/tools/` before reading anything else.
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
- `src/module/agent/tools/index.ts` — 🔒 `TOOL_REGISTRY`: the declarative tool inventory composed from the per-domain ToolDef arrays — the single source of truth the tier arrays, the Discord-only platform filter, the kernel's tool-server parts and the feature-flag predicates are all derived from, exported as `COMMUNITY_TOOL_TIERS`/`COMMUNITY_TOOL_SERVER_PARTS`/`COMMUNITY_FLAGGED_TOOL_PREDICATES` and registered by `createAgent` from the manifest, never at module scope (invariants pinned by `tests/toolRegistry.test.ts`).
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
- `src/module/agent/tools/teamSetup.ts` — The `team_setup` ToolDef: one CONFIRM-gated admin call composing project_create + add_member (for anyone not yet a community member) + project_add_member + project_bind_here for batch team/event onboarding, audited as a single action with the member list in its params.
- `src/module/agentModule.ts` — 🔒 THE module manifest: every extension point this deployment fills (notices, tool tiers/server parts/flag predicates, skills, prompt sections, commands, bad words, personas, turn-state finalizer, policy keys, migrations) as one inspectable object, handed to agent-base's `createAgent` by `src/index.ts`. Its `init()` asserts the NZ display settings rather than letting a missing env var silently re-render every time in UTC.
- `src/module/backgroundJobs.ts` — The knowledge/context/status/dev-team job run functions and their `JobSpec` entries; the shared tracked-job wrapper they start through lives in the package (`@swampratnz/agent-base/jobs/trackedJob.js`).
- `src/module/commands.ts` — The community command list (plan §3 `commands` row): the ordered `{name, platforms, handler}` entries (kb, projects, whois, guidelines, digest), registered by the manifest into the package's command registry; WhatsApp handlers live here verbatim, Discord halves are bound by slashCommands.ts.
- `src/module/context/` — The community-context learning loop: nightly digest builder, knowledge refresh, Anthropic docs ingest, link-rot check, and the PII-scrubbed export that is the DB-to-repo privacy boundary.
- `src/module/departedAdminAlert.ts` — Watches the admin roster and alerts super admins when someone holding admin has left the server, so stale privilege is noticed.
- `src/module/devTeam/` — Typed HTTP client for the remote dev-team dispatch service behind the super-admin `dev_team_*` tools. Codes to a frozen contract — do not drift it casually.
- `src/module/engagementAlert.ts` — Threshold alerting on community engagement statistics, reusing the usage-alert debounce shape.
- `src/module/github/` — 🔒 GitHub issue creation for the super-admin `suggest_issue` tool. The bot's only GitHub egress and its only write credential; the token is fine-grained and issues-scoped.
- `src/module/jobs/` — The pinned-order community `JOB_REGISTRY` list — only the ORDER lives here; each spec lives with the job module that owns it.
- `src/module/media/` — The Grok image-generation client behind the `generate_image` tool — an optional product integration, not framework (agent-base plan §5).
- `src/module/memberDigest.ts` — The member-facing digest of recent community activity, built from PII-scrubbed aggregates rather than raw messages.
- `src/module/moderation/` — The community-owned default bad-word list registered into the wordlist's fail-loud slot; operators still extend it with MODERATION_BAD_WORDS.
- `src/module/moderation/badWords.ts` — The community-owned default bad-word list, registered by the manifest into the package wordlist's fail-loud slot; operators still extend it with MODERATION_BAD_WORDS.
- `src/module/platforms/` — The community half of the platform layer: the adapter text packs, the Discord slash-command handlers, the adapter factory composition and the WhatsApp linking CLI.
- `src/module/platforms/factories.ts` — The heavy half of the platform registry: the `AdapterFactory` registrations (Discord + the WhatsApp baileys/cloud/disabled provider switch) with each platform's declared tool-capability union and each adapter's injected text pack (`textPacks.ts`), and `createConfiguredAdapters()`, which index.ts composes instead of constructing adapters inline.
- `src/module/platforms/textPacks.ts` — The community-owned adapter text packs (plan §3 `textPacks`): the join-welcome and manual `warn_user` DM strings for Discord, Baileys and WhatsApp Cloud, injected by `factories.ts` into each adapter's now-required text-pack constructor parameter.
- `src/module/routerWiring.ts` — The router's production wiring: `makeRouterDeps`, the ONE place the real implementation behind every `RouterDeps` field is named, so the router mechanism itself never imports the community content its defaults point at; `index.ts` (and every router test) composes `new Router(makeRouterDeps(...))`.
- `src/module/status/` — Anthropic status-page check behind the "is it me or is Anthropic down?" answer, with its own cache so a common question costs nothing.
- `src/module/storage/` — The community-owned policy keys (guidelines and welcome message, plus their te reo Māori variants) with their typed accessors, and this module's schema fragments (`schema/`), both contributed through the manifest.
- `src/module/storage/schema/` — 🔒 This deployment's schema contribution (plan §3 `migrations`): the fragments agent-base does NOT ship, contributed through `AgentModule.migrations` and concatenated AFTER every base fragment as one atomic query. Today that is the standing-preference value allowlists base generalised into shape checks. Never re-declare a base fragment, and never reshape a constraint base owns — pinned by `tests/schemaConstraintIdempotency.test.ts`.
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
