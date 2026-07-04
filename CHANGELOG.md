# Changelog

All notable changes to the NZ Claude Community Agent, newest first. The format
loosely follows [Keep a Changelog](https://keepachangelog.com/). The agent's
`whats_new` tool reads this file, so keep entries user-legible and add a new
`##` dated section (or version) as part of each release.

## 2026-07-04

### Added
- Chat-triggered redeploy: a super admin can now say "deploy the latest code" instead of waiting for the nightly timer or reaching for SSH. `redeploy_bot` takes no arguments, is CONFIRM-gated and router-executed like `grant_admin`/`purge_user_data`, and starts the same flock-guarded `community-agent-redeploy.service` unit the 1am timer uses — requires an opt-in, exact-match sudoers grant documented in DEPLOYMENT.md (#101).
- Weekly proactive admin digest (opt-in, `ADMIN_DIGEST_ENABLED`): DMs each admin at most once a week with their own scoped recurring-question clusters — the same signal `question_digest` already computes on demand, now pushed instead of pull-only. Restart-safe freshness guard, no DM on a quiet week (#97).
- Anonymised community-context export (opt-in, `CONTEXT_EXPORT_ENABLED`): context digests render into `docs/COMMUNITY-CONTEXT.md` (aggregate-only, k-floored, PII-scrubbed) so the research loop can ground proposals in real community need; committing the file stays a human step (#53).
- Offline context builder (opt-in, `CONTEXT_BUILDER_ENABLED`): a ~daily job distills stored interactions into durable topic digests admins read with `list_context_digests` — hard-capped model spend, a distinct-author floor, and purge-coherent by construction (#51).
- Ambient message archiving (opt-in, `DISCORD_ARCHIVE_ALL_MESSAGES`): every message in allowed guild channels is stored for community memory, Discord deletes/edits are honoured against the stored copy, and the bot still only replies when addressed. Requires posting the community notice from SECURITY.md first (#48).
- In-chat suggestion capture: members can file bot-improvement ideas with `suggest_improvement` (rate-capped); admins triage the queue with `list_suggestions`/`resolve_suggestion`. The bridge to GitHub stays human (#46).
- Admin-curated member context notes: `add_member_note` / `list_member_notes` / `delete_member_note` give person-scoped facts a home outside the global FAQ — admin-only, audited, deleted by `forget_me` (#45).
- Discord server roster: join/leave events and a startup backfill persist identity metadata (never content) so admins can ask who joined, who left, and who joined but was never added as a member, via the new `list_roster` tool (#47).
- Automated nightly redeploy: `scripts/redeploy.sh` + a systemd timer fast-forward the server to `origin/main` at 1am NZ time, with build/migrate-before-restart, health-checked rollback, and a no-op fast path (#50).

- `link_member`/`unlink_member` admin tools to link a member's Discord and WhatsApp identities as one person, so `forget_me`/`purge_user_data` and the daily reply budget follow the person instead of the platform row (#44).

### Fixed
- A database hiccup during memory recall or session lookup no longer makes the bot go silent — the turn degrades (answers without memory context / starts a fresh session) and a router backstop guarantees the member always gets a reply (#52).

## 2026-07-03

### Added
- `report_content` member tool plus `list_reports`/`resolve_report` admin tools for flagging harassment/spam/rule violations to a conversation's admins (#70).
- `moderation_history` admin tool, scoped to the admin's own conversations (#34).
- `question_digest` admin tool to surface recurring questions (#23).
- Proactive super-admin alert when the shared Max-pool usage budget runs high (#25).
- `/healthz` endpoint and sustained-disconnect super-admin alerting (#14).
- Age-based retention purge for raw interactions, for privacy (#12).
- Persona registry with "Kaha" as the default voice (#19).
- Shared VISION.md rubric; richer research and adversarial prompts (#18).
- Postgres + pgvector CI service and repository integration tests (#15).
- Build + PR-review GitHub Actions using Claude Max subscription auth (#20).

### Changed
- The bot now briefly attributes answers backed by community knowledge, and
  flags community-specific answers with no knowledge-base match as general
  knowledge rather than a confirmed fact (#60).
- Outbound replies now convert Discord-style markdown to WhatsApp-readable formatting (#38).
- Long WhatsApp Cloud API replies are chunked under Meta's 4096-character limit (#36).
- `knowledge_search` surfaces how recent each knowledge entry is (#32).
- Build-worker turn cap raised to 300 with a matching 60-minute timeout (#49; earlier 40 → 80 in #31).
- PR-review worker can now review build-worker PRs (#33).
- Pipeline loops documented as cloud Routines (#16).

### Fixed
- Membership tools (`add_member`, `grant_admin`, `remove_member`, `revoke_admin`) can now target either platform via an optional `platform` argument instead of always assuming the caller's; ids are shape-validated so a WhatsApp number can no longer be filed as a Discord user (#78).
- Blank optional numeric env vars (e.g. `HEALTH_PORT=`) no longer fail config validation (#40).
- Build-worker verify step hardened against spoofed or stale PRs (#30).
- Build worker uses an explicit allowedTools list and deterministic PR verification (#29).
- PR-review worker does read-only reviews and always posts a deterministic verdict (#26, #24).

## 2026-07-02

### Added
- Three-tier RBAC (super_admin / admin / member) with gated access, plus security and correctness fixes and dependency upgrades (#1).
- WhatsApp Cloud adapter against the official Meta Cloud API (#6).
- Knowledge curation tools: list, update, delete (#8).
- Proactive onboarding: a Discord welcome message and an access-request queue (#10).
- Multi-loop pipeline scaffolding: labels, docs, conventions (#2).

### Fixed
- `setup-labels` workflow: restored `contents:read` so checkout works (#3).
