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
- `src/agent/tools.ts` — 🔒 Every tool implementation plus its tier requirement. By far the largest file in the repo; find your tool by name before reading anything else.
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
- `src/interactionRetention.ts` — Scheduled purge of interaction rows past the retention window — the enforcement half of the retention promise in SECURITY.md.
- `src/logger.ts` — The pino logger plus the hashing helper used to keep identifiers out of logs.
- `src/media/` — Local-only media handling: Whisper voice transcription for WhatsApp notes and the Grok image-generation client. Audio is transcribed on-host, never shipped to a third party.
- `src/memberDigest.ts` — The member-facing digest of recent community activity, built from PII-scrubbed aggregates rather than raw messages.
- `src/moderation/` — Two-stage moderation: a zero-cost wordlist pass, then a model pass, with admins and super admins exempt. The enforcer is injected so the platform side stays swappable.
- `src/mutedRoleAlertNotice.ts` — Pure debounce for the super-admin alert raised when Discord muted-role permission overwrites exhaust their retries.
- `src/pauseNotice.ts` — Pure debounce for the "the bot is paused" reply, on a longer window than the rate-limit notice because a pause is longer-lived.
- `src/pendingAlertQueue.ts` — Best-effort queue for super-admin alerts raised while every adapter was disconnected, so an alert during an outage is not simply lost.
- `src/platforms/` — 🔒 The platform abstraction plus the Discord and WhatsApp (Baileys and Cloud API) adapters. Adapters own the send path, so outbound filtering and chunking live at their edges.
- `src/platforms/types.ts` — 🔒 The `IncomingMessage` / `PlatformAdapter` contract every adapter normalises into. Identity fields here are the only trusted source of who is speaking.
- `src/rateLimitNotice.ts` — Pure debounce for the per-user rate-limit notice, so a burst of over-limit messages yields exactly one notice.
- `src/replyRetraction.ts` — In-memory, TTL'd, size-capped map from an inbound message to the bot's reply, so a reply can be retracted when the prompt that caused it is deleted.
- `src/rosterRetention.ts` — Scheduled purge of departed-member roster rows, the roster counterpart to interaction retention.
- `src/router.ts` — 🔒 The hot path: every inbound message lands here. Rate limits, budgets, tier resolution, confirm handling, moderation and the agent call are all sequenced in this file.
- `src/status/` — Anthropic status-page check behind the "is it me or is Anthropic down?" answer, with its own cache so a common question costs nothing.
- `src/storage/` — 🔒 Postgres + pgvector: the pool, schema/migrations, local embeddings, runtime policies, and the repository that owns every query. Admin-facing reads are conversation-scoped in SQL here.
- `src/storage/repository.ts` — 🔒 The repository entry point every caller imports: still holds the not-yet-extracted queries, and re-exports the per-domain modules in `repository/`. Conversation scoping for admin reads is enforced in the queries themselves, not by callers.
- `src/storage/repository/` — 🔒 Per-domain query modules being carved out of `repository.ts` one domain at a time (audit L14). Add a new query to its domain module here, not to `repository.ts`; everything is re-exported so import sites never change.
- `src/usageAlert.ts` — Usage-threshold alerting to super admins with a debounce tracker shared by several other alert modules.
- `src/usageCostDigest.ts` — The periodic cost digest (spend, cache hit rate) sent to super admins.
- `src/util/` — Shared leaf helpers with no dependencies of their own; currently NZ-timezone rendering for member-facing times.
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
