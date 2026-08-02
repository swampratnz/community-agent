# Module map

One line per module, so a cold session can find the right file without
grepping the whole tree. Read [`README.md`](README.md) first for how to use
this and [`recipes.md`](recipes.md) for the shape of a typical change.

**This file is gated.** `npm run context:check` (part of CI's lint job) fails
if a `src/` subsystem or top-level module has no entry, if an entry names a
path that no longer exists, or if entries are unsorted, duplicated, or left as
stubs. `npm run context:fix` adds/drops/sorts entries mechanically — it cannot
write the description, which is the part that matters.

Two things this map deliberately does **not** try to be:

- **A substitute for reading the code.** It tells you which file to open, not
  what the code says. Never assert behaviour from a one-liner here.
- **Complete.** Nested files inside a subsystem are called out only where the
  subsystem is big enough that "look in `src/agent/`" is not an answer.

The security spine — the paths where a mistake is a security bug, not a bug —
is marked **🔒**. Changes there need a `SECURITY:` test (see
[`../../CLAUDE.md`](../../CLAUDE.md)).

<!-- module-map:begin -->

- `src/ackClassifier.ts` — Deterministic "is this just 'thanks'?" classifier; lets the router skip a whole agent turn (and its cost) on a pure acknowledgement.
- `src/adminDigest.ts` — Builds and sends the periodic admin digest: moderation, engagement, feedback and cost summaries for admins, scoped to their own conversations.
- `src/adminLeverageAlert.ts` — Weekly super-admin push of `adminActivitySummary`'s actions-per-admin rate, the pull-to-push complement of the on-demand `admin_activity` tool.
- `src/agent/` — 🔒 The Claude Agent SDK integration: system prompt, tool definitions and gating, the confirm flow, outbound filtering. Most security-relevant subsystem — see the per-file entries below.
- `src/agent/core.ts` — 🔒 Builds the per-turn `query()` options (model, tools, plugins/skills, session tail) and runs the agent turn. Tool surface is derived from the caller's tier here.
- `src/agent/outbound.ts` — 🔒 The outbound reply filter (secret redaction + behaviour policy) applied to every message the bot sends. Deterministic, and deliberately not something the model can talk its way past.
- `src/agent/pendingActions.ts` — 🔒 The confirm-before-destructive flow: destructive tools register a pending action for the router to execute after an explicit confirmation, rather than firing directly.
- `src/agent/personas.ts` — The selectable persona definitions (voice, tone, quirks) the system prompt draws its voice rules from; content only, never authority over the security section.
- `src/agent/secrets.ts` — 🔒 `runtimeSecrets()`: the exact-value secret list the outbound filter redacts as a backstop against unknown egress paths. Add every new outward credential here.
- `src/agent/skills/` — 🔒 One `SKILL.md` per Agent Skill, plus the plugin manifest. Loaded only when `AGENT_SKILLS_ENABLED`, and only the hand-written `ENABLED_SKILLS` allowlist in `core.ts` — never derived from request content.
- `src/agent/systemPrompt.ts` — 🔒 Assembles the system prompt: security guidelines, persona voice rules, and the NZ-date grounding. Voice rules never override the security section above them.
- `src/agent/tools.ts` — 🔒 The barrel for the tool-registry split (re-exports every moved helper/notify/registry symbol) plus the remaining unconverted closure tools in `buildToolServer`. Still large; find your tool by name before reading anything else.
- `src/agent/tools/context.ts` — 🔒 `makeToolContext`: the per-turn tool kernel — owns `audited` (audit row + super-admin alert pairing) and `requireConfirm` (the CONFIRM gate's forgeable-pending-notice sanitize strip), plus `adapterFor`/`callerScope`/`resolveMemberTarget`.
- `src/agent/tools/devTeam.ts` — The `dev_team_*` ToolDef domain (dispatch/status/result/backlog/findings/verify) plus its per-super-admin daily dispatch reserver.
- `src/agent/tools/digestMember.ts` — The `community_digest` ToolDef domain: on-demand pull of the weekly member digest, quarantined before it re-enters model context.
- `src/agent/tools/feedback.ts` — The `suggest_improvement`/`rate_answer`/`request_human_help` ToolDef domain, plus the per-caller human-help daily reserver and its exported limit.
- `src/agent/tools/helpers.ts` — Module-scope pure helpers shared by tool domains: `text()`/`untrusted()` result wrappers, the knowledge/usage/dev-team formatters, the feature-flag allowlists, and shared zod fragments.
- `src/agent/tools/imageGen.ts` — The `generate_image` ToolDef domain plus its in-flight set and per-user daily reserver.
- `src/agent/tools/index.ts` — 🔒 `TOOL_REGISTRY`: the declarative tool inventory composed from the per-domain ToolDef arrays; `tests/toolRegistry.test.ts` cross-checks its tier/platform/flag metadata against rbac.ts/core.ts until the flip.
- `src/agent/tools/info.ts` — The `community_info`/`community_guidelines`/`check_status`/`list_events` ToolDef domain, owning the static per-tier capability rundown texts.
- `src/agent/tools/knowledgeMember.ts` — The member-facing knowledge ToolDef domain: `knowledge_search` (with its turn-state gap/stale correlation writes), `list_knowledge_topics`, `suggest_knowledge`, `withdraw_knowledge_tip`.
- `src/agent/tools/memory.ts` — The `remember_search`/`catch_up` ToolDef domain: recall over past interactions, with the shared per-message truncation cap and the catch_up window/row limits.
- `src/agent/tools/notify.ts` — The notify family (super-admin/admin fan-out, approval/resolution DMs) with window-reopen queueing, plus `applyManualWarnStrike`/`ackReportedMessage` side-effect helpers.
- `src/agent/tools/prefs.ts` — The `set_response_style`/`set_language_preference` ToolDef domain: self-scoped, closed-enum standing preferences.
- `src/agent/tools/projectNotes.ts` — The `project_recall`/`project_note`/`project_list` ToolDef domain: team-project shared memory, access-scoped in SQL via `visibleProjectIds`.
- `src/agent/tools/reactions.ts` — The `react_to_message` ToolDef domain plus its closed emoji allowlist and per-user daily reaction reserver.
- `src/agent/tools/reportsMember.ts` — The `report_content`/`withdraw_report`/`appeal_moderation` ToolDef domain plus the per-caller appeal cooldown reserver.
- `src/agent/tools/selfService.ts` — The `forget_me`/`my_submissions`/`my_warnings`/`my_data` ToolDef domain: the caller's own data, always self-scoped.
- `src/agent/tools/social.ts` — The member-discovery ToolDef domain: interests (`set_my_interests`/`who_is_into`), peer help (`set_helper_availability`/`find_helper`), and the project showcase (`share_project`/`list_projects`/`request_project_connection`).
- `src/agent/tools/types.ts` — `ToolDef`/`ToolContext`/`defineTool`: the declarative registry's type surface (docs/TOOL-REGISTRY-DESIGN.md).
- `src/agent/webSearchGuard.ts` — 🔒 The WebSearch PreToolUse guard: per-conversation hourly volume cap, exact-then-embedding query dedup, and the per-conversation lock keeping check-then-record atomic. Fail-closed by contract — a thrown `embed()` denies the call.
- `src/auth/` — 🔒 Identity and role resolution: tiers come from env plus the `community_users` table, never from message content. Three files, all small and worth reading in full.
- `src/backgroundJobCostAlert.ts` — Alerts super admins when background-job spend crosses a configured threshold, so an expensive job cannot run up cost unnoticed.
- `src/backgroundJobHealth.ts` — Pure consecutive-failure debounce tracker for scheduled jobs, so one outage produces one alert rather than an alert per tick.
- `src/backgroundJobs.ts` — The scheduler: registers, tracks and runs every opt-in background job (context builder, knowledge refresh, docs ingest, retention sweeps) and records their cost.
- `src/budgetCheckFailureNotice.ts` — Pure debounce for the single super-admin DM sent when the daily reply-budget check itself fails (a systemic condition, not a per-user one).
- `src/config.ts` — The zod-validated environment schema and the single source of every tunable. Adding a setting starts here; the schema is what fails loudly on a bad deploy.
- `src/context/` — The community-context learning loop: nightly digest builder, knowledge refresh, docs ingest, link-rot check, and the PII-scrubbed export that is the DB-to-repo privacy boundary.
- `src/crashHandlers.ts` — Installs handlers for unhandled rejections and uncaught exceptions, so a process death always leaves a logged reason.
- `src/dailyBudgetNotice.ts` — Static text for the daily reply-budget notice; the 24h debounce window itself is tracked inline by the router.
- `src/dailyReplyBudgetWarning.ts` — The short warning line appended to a real reply as a member approaches their daily budget, so the cutoff is not the first sign a limit exists.
- `src/departedAdminAlert.ts` — Watches the admin roster and alerts super admins when someone holding admin has left the server, so stale privilege is noticed.
- `src/devTeam/` — Typed HTTP client for the remote dev-team dispatch service behind the super-admin `dev_team_*` tools. Codes to a frozen contract — do not drift it casually.
- `src/engagementAlert.ts` — Threshold alerting on community engagement statistics, reusing the usage-alert debounce shape.
- `src/gatedNotice.ts` — The message shown to a guest whose request needs a tier they do not have, including who to ask for access.
- `src/github/` — 🔒 GitHub issue creation for the super-admin `suggest_issue` tool. The bot's only GitHub egress and its only write credential; the token is fine-grained and issues-scoped.
- `src/health.ts` — The HTTP health server (`/healthz`) and the adapter/DB probes behind it.
- `src/healthState.ts` — Pure health logic (disconnect debounce, payload shape), kept import-free of config and HTTP so it is directly unit-testable.
- `src/index.ts` — Process entry point: loads config, wires adapters, storage, moderation and background jobs, and owns startup/shutdown ordering.
- `src/logger.ts` — The pino logger plus the hashing helper used to keep identifiers out of logs.
- `src/media/` — Local-only media handling: Whisper voice transcription for WhatsApp notes and the Grok image-generation client. Audio is transcribed on-host, never shipped to a third party.
- `src/memberDigest.ts` — The member-facing digest of recent community activity, built from PII-scrubbed aggregates rather than raw messages.
- `src/moderation/` — Two-stage moderation: a zero-cost wordlist pass, then a model pass, with admins and super admins exempt. The enforcer is injected so the platform side stays swappable.
- `src/mutedRoleAlertNotice.ts` — Pure debounce for the super-admin alert raised when Discord muted-role permission overwrites exhaust their retries.
- `src/notifications.ts` — The shared super-admin DM fan-out every alert producer delegates to (connected-adapters-only, window-reopen queueing, optional queue-on-outage), plus the rolling-hour alert-slot reserver factory behind the router's and moderator's guild-wide alert caps.
- `src/pauseNotice.ts` — Pure debounce for the "the bot is paused" reply, on a longer window than the rate-limit notice because a pause is longer-lived.
- `src/pendingAlertQueue.ts` — Best-effort queue for super-admin alerts raised while every adapter was disconnected, so an alert during an outage is not simply lost.
- `src/platforms/` — 🔒 The platform abstraction plus the Discord and WhatsApp (Baileys and Cloud API) adapters. Adapters own the send path, so outbound filtering and chunking live at their edges.
- `src/platforms/types.ts` — 🔒 The `IncomingMessage` / `PlatformAdapter` contract every adapter normalises into. Identity fields here are the only trusted source of who is speaking.
- `src/rateLimitNotice.ts` — Pure debounce for the per-user rate-limit notice, so a burst of over-limit messages yields exactly one notice.
- `src/replyRetraction.ts` — In-memory, TTL'd, size-capped map from an inbound message to the bot's reply, so a reply can be retracted when the prompt that caused it is deleted.
- `src/retention.ts` — All three age-based retention sweeps (interactions per SECURITY.md's promise, departed roster rows, stale pending access requests) as one parameterised daily job; each purge is gated only on its own days config, so disabling one never suppresses another.
- `src/router.ts` — 🔒 The hot path: every inbound message lands here. Rate limits, budgets, tier resolution, confirm handling, moderation and the agent call are all sequenced in this file.
- `src/status/` — Anthropic status-page check behind the "is it me or is Anthropic down?" answer, with its own cache so a common question costs nothing.
- `src/storage/` — 🔒 Postgres + pgvector: the pool, schema/migrations, local embeddings, runtime policies, and the repository that owns every query. Admin-facing reads are conversation-scoped in SQL here.
- `src/storage/repository.ts` — 🔒 The repository entry point every caller imports: still holds the not-yet-extracted queries, and re-exports the per-domain modules in `repository/`. Conversation scoping for admin reads is enforced in the queries themselves, not by callers.
- `src/storage/repository/` — 🔒 Per-domain query modules being carved out of `repository.ts` one domain at a time (audit L14). Add a new query to its domain module here, not to `repository.ts`; everything is re-exported so import sites never change.
- `src/storage/repository/projects.ts` — 🔒 Project shared memory (issue #927). `visibleProjectIds` is the one place the two access checks live — membership (expanded through linked `persons`) and surface (a bound conversation or a DM) — and every read/write here goes through it in SQL.
- `src/storage/repository/whatsappLidMap.ts` — 🔒 Durable WhatsApp LID -> phone mapping. A LID is a privacy id that looks like a number but matches no one; persisting what the adapter learns from real envelopes lets a LID be resolved rather than refused. PII — erased by `forget_me`/`purge_user_data`. See docs/SECURITY.md §6b.
- `src/usageAlert.ts` — Usage-threshold alerting to super admins with a debounce tracker shared by several other alert modules.
- `src/usageCostDigest.ts` — The periodic cost digest (spend, cache hit rate) sent to super admins.
- `src/util/` — Shared leaf helpers with no dependencies of their own: NZ-timezone rendering, the `shouldNotifyAfterWindow` notice debounce, the rate-reservation primitives, and the display-name sanitiser (see entries below).
- `src/util/rateReservation.ts` — 🔒 The three in-memory rate-cap primitives (sliding window, UTC calendar day, per-key cooldown) behind every tool/adapter reservation cap. Reservations are never refunded on failure, so induced-failure retries can't bypass a cap.
- `src/util/sanitizeName.ts` — 🔒 Neutralises attacker-controlled display names (bracket stripping, whitespace/NEL collapse, hard truncation) before they are interpolated anywhere the model or another member reads them. Every rendered name goes through here.
- `src/voiceLanguageCaveatNotice.ts` — Fixed caveat DM for a te reo Māori speaker sending a voice note, because the transcription model is English-only and would otherwise fail silently.

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
