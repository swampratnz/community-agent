# Changelog

All notable changes to the NZ Claude Community Agent, newest first. The format
loosely follows [Keep a Changelog](https://keepachangelog.com/). The agent's
`whats_new` tool reads this file, so keep entries user-legible and add a new
`##` dated section (or version) as part of each release.

## 2026-07-05

### Changed
- Docs ingest now **scopes out low-value sections** (`DOCS_INGEST_EXCLUDE_PATHS`): the default drops the auto-generated per-language SDK/CLI reference (`api/go`, `api/python`, `api/typescript`, …), which was ~90% of the corpus by volume (~24k of ~29k chunks) and near-useless for a chat bot, while keeping the conceptual guides + core API. Excluded pages are neither fetched nor counted as in-index, so their previously-ingested chunks are pruned on the next run. Result: a focused few-thousand-chunk KB of the docs people actually ask about, instead of drowning them in SDK method reference. Tune via the env var (empty = ingest everything).
- Docs ingest chunks **coarser** (splits at H2 only, folding `###` subheadings inline) so API-reference pages no longer explode into thousands of one-parameter fragments — the full corpus now fits well under the (raised) chunk cap instead of truncating to the first ~16%. Pruning is now **index-based**: a `docs` chunk is removed only when its page drops out of the upstream index, not when a fetch fails — so the ~157 habitually-404 URLs in the index no longer disable cleanup. (Changing the chunking means a one-time `docs` wipe + re-ingest on the deploy that enables this.)

### Added
- Docs ingest (opt-in, `DOCS_INGEST_ENABLED`, off by default): backfills Anthropic's official developer docs into the knowledge base as RAG chunks so Dave answers API/Claude Code questions from the current documentation instead of just its training cutoff. Reads one fixed official source over HTTPS (the `llms.txt` index → each page's `.md`), chunks by heading, embeds, and diff-upserts under a `'docs'` provenance; refreshed **~weekly with a content diff** so only genuinely changed sections re-embed — and the created/updated/removed counts are the "what changed" view. Entries are **trusted** (served verbatim, shortcut-eligible), unlike the quarantined open-web `'auto'` refresh, because the source is Anthropic's own first-party docs with no model in the loop. Bounded by page/chunk caps + polite fetch concurrency; never overwrites or prunes a human-authored entry sharing a title; redeploy-safe freshness guard. See docs/SECURITY.md.
- Daily knowledge refresh (opt-in, `KNOWLEDGE_REFRESH_ENABLED`, off by default): a scheduled job web-researches a small **fixed** set of fast-moving Claude/Anthropic topics (Claude Code updates, Anthropic API/model changes) and writes each briefing straight into the knowledge base as one upserted, clearly-labelled *auto-researched* entry per topic. Deliberately the one knowledge path with **no human review gate** — so its blast radius is bounded by design: the topics are hard-coded (chat/injection can't steer them), each upserts a single entry (the base is refreshed, never grown unbounded), every entry is stamped machine-generated/unverified, search results are treated as untrusted, the run defers to a busy bot and is turn-capped, and a ~daily freshness guard makes it redeploy-safe. See docs/SECURITY.md.
- Members can now retract their own content report with `withdraw_report` — if you filed one by mistake or as a joke, you can withdraw it yourself instead of having to ask an admin (which was especially awkward when the report was *about* an admin). It only ever touches reports **you** filed (scoped in SQL to your reporter id — it can never affect anyone else's), marks them `withdrawn` and **keeps them on record** rather than deleting (so a withdrawn serious complaint stays accountable, not erased), and notifies super admins of the withdrawal so a retraction is never silent.
- Image generation (opt-in, `IMAGE_GEN_ENABLED`, off by default): an admin/super-admin `generate_image` tool creates an image from a text prompt and posts it into the conversation, on both Discord and WhatsApp. It shells out to the host's **Grok Build CLI** signed in with a SuperGrok subscription (device-code login, no API key, no per-call billing). The CLI is **locked to a single built-in tool** (`--tools GenerateImage`, no Bash/file/exec), so its unattended `--always-approve` mode has nothing dangerous to approve — it can only produce an image; the subprocess gets a **minimal scoped env** (no bot secrets — never `CLAUDE_CODE_OAUTH_TOKEN`/`DISCORD_BOT_TOKEN`/`DATABASE_URL`); the prompt is an argv element (no shell injection); never members; one-in-flight-per-user plus a per-user **daily cap** (`IMAGE_GEN_DAILY_LIMIT`); a hard timeout; and the real image format is sniffed from magic bytes rather than trusted from a filename. See docs/SECURITY.md §8.
- Knowledge-candidate review queue (opt-in, `CONTEXT_CANDIDATES_ENABLED`, off by default and a no-op while the builder itself is off): the offline context builder can now draft a Q&A candidate from a recurring, answerable question cluster — the same summarisation call that writes the digest, never a second model call. Candidates land in a `pending` queue admins browse with `list_knowledge_candidates` and turn into durable knowledge with `accept_knowledge_candidate` (which publishes via the existing `save_knowledge` path) or reject with `decline_knowledge_candidate` (non-destructive, no CONFIRM). Nothing reaches `knowledge`/`knowledge_search` without that explicit accept — the human-curation invariant this repo keeps for knowledge generally is unchanged. Closes the deferred half of #51 (#102).
- Members can now rate the bot's last answer with `rate_answer` (helpful/unhelpful, no free text, rate-capped) so admins finally get a calibrated signal on answer quality — the deferred half of #60. Admins read the aggregate, scoped to their own conversations, with the new `list_answer_feedback` tool (#118).

### Changed
- Discord replies and DMs now send with `SuppressEmbeds`, so links the bot posts no longer expand into large preview cards — the message text is unchanged, just no auto-embed.
- Auto-moderation warnings are now **public and minimal**: the warning is posted in the channel the offending message was posted in (not only the private admin channel), and names **only the member** — no user id, matched word, or message excerpt. The detailed record (id + matched term, needed for `clear_warnings`) still goes to the private admin channel, and the member still gets a DM. Follow-up to the auto-moderation feature (#141).

### Fixed
- A role change now takes effect on the target's **very next message**. Previously `grant_admin`/`revoke_admin` updated the role in the DB, but the target's live conversation session still carried the old-role framing in its history, so the bot would keep treating a freshly-promoted admin as a member (refusing admin actions) — or, worse, keep treating a freshly-*revoked* admin as an admin — until the session rolled over (30 turns / 24h). Both tools now reset the target's active-conversation session(s) on success (`clearUserSessions`, non-destructive — only session continuity is cleared, stored memory is untouched), so the new tier applies immediately.
- Membership tool replies (`add_member`, `remove_member`, `grant_admin`, `revoke_admin`, `unlink_member`) now name the member (from the membership row or the server roster) instead of echoing a raw platform id — e.g. "Granted admin to **Adam H** on discord" rather than "…to 310697646731952132". Falls back to the id only when no name is known.

## 2026-07-04

### Added
- Global crash handlers: an unhandled promise rejection is now logged at ERROR level (visible in `journalctl -u community-agent`) instead of slipping by silently, and an uncaught exception is logged and exits non-zero so systemd restarts the bot cleanly rather than leaving it in an undefined state. No more silent crashes to diagnose after the fact.
- Discord auto-moderation (opt-in, `DISCORD_MODERATION_ENABLED`, off by default): the bot scans every message for bad language / abuse, warns the member, and after `MODERATION_STRIKE_LIMIT` active warnings (default 3) assigns a "Muted" Discord role that blocks them from posting until an admin clears their warnings. Warnings and blocks post to an auto-created private `mod-alerts` channel; admins clear anyone's warnings (and lift the mute) with the new admin-tier `clear_warnings` tool. Two-stage detection keeps it cheap — a free wordlist runs on every message and an optional LLM abuse check (`MODERATION_LLM_ABUSE_ENABLED`) only escalates wordlist-clean messages. Admins and super admins are never warned or muted. Enabling it is a privacy-posture change and needs the bot to hold Manage Roles + Manage Channels — see SECURITY.md.
- Filing a `report_content` submission now proactively DMs every super admin the moment it's created, instead of relying on someone remembering to poll `list_reports` — reuses the same alert mechanism every other privileged action already triggers. No new tool, RBAC surface, or stored data; narrows (does not eliminate) the documented residual risk that DM-originated reports were only reachable by super admins (#90).
- Resolving a member's `report_content` submission now sends them a best-effort DM naming the outcome (resolved/dismissed) — closes the same "shout into the void" gap #116 fixed for suggestions, applied to safety reports. Same-platform only for now: a resolution on a different platform than the report was filed on sends no DM (#120).
- Resolving a member's `suggest_improvement` submission now sends them a best-effort DM naming the outcome (reviewed/declined/done) — closes the "suggestion box into the void" gap. Same-platform only for now: a resolution on a different platform than the suggestion was filed on sends no DM (#116).
- Chat-triggered redeploy: a super admin can now say "deploy the latest code" instead of waiting for the nightly timer or reaching for SSH. `redeploy_bot` takes no arguments, is CONFIRM-gated and router-executed like `grant_admin`/`purge_user_data`, and starts the same flock-guarded `community-agent-redeploy.service` unit the 1am timer uses — requires an opt-in, exact-match sudoers grant documented in DEPLOYMENT.md (#101).
- Weekly proactive admin digest (opt-in, `ADMIN_DIGEST_ENABLED`): DMs each admin at most once a week with their own scoped recurring-question clusters — the same signal `question_digest` already computes on demand, now pushed instead of pull-only. Restart-safe freshness guard, no DM on a quiet week (#97).
- Anonymised community-context export (opt-in, `CONTEXT_EXPORT_ENABLED`): context digests render into `docs/COMMUNITY-CONTEXT.md` (aggregate-only, k-floored, PII-scrubbed) so the research loop can ground proposals in real community need; committing the file stays a human step (#53).
- Offline context builder (opt-in, `CONTEXT_BUILDER_ENABLED`): a ~daily job distills stored interactions into durable topic digests admins read with `list_context_digests` — hard-capped model spend, a distinct-author floor, and purge-coherent by construction (#51).
- Ambient message archiving (opt-in, `DISCORD_ARCHIVE_ALL_MESSAGES`): every message in allowed guild channels is stored for community memory, Discord deletes/edits are honoured against the stored copy, and the bot still only replies when addressed. Requires posting the community notice from SECURITY.md first (#48).
- WhatsApp group ambient archiving parity (opt-in, per-group `WHATSAPP_ARCHIVE_GROUP_JIDS` allowlist): extends the above to WhatsApp groups — the community's largest venue — with the same posture, delete-honouring (best-effort edit-tracking), and notice precondition. Receive-side only, no new send behaviour (#103).
- In-chat suggestion capture: members can file bot-improvement ideas with `suggest_improvement` (rate-capped); admins triage the queue with `list_suggestions`/`resolve_suggestion`. The bridge to GitHub stays human (#46).
- Admin-curated member context notes: `add_member_note` / `list_member_notes` / `delete_member_note` give person-scoped facts a home outside the global FAQ — admin-only, audited, deleted by `forget_me` (#45).
- Discord server roster: join/leave events and a startup backfill persist identity metadata (never content) so admins can ask who joined, who left, and who joined but was never added as a member, via the new `list_roster` tool (#47).
- Automated nightly redeploy: `scripts/redeploy.sh` + a systemd timer fast-forward the server to `origin/main` at 1am NZ time, with build/migrate-before-restart, health-checked rollback, and a no-op fast path (#50).

- `link_member`/`unlink_member` admin tools to link a member's Discord and WhatsApp identities as one person, so `forget_me`/`purge_user_data` and the daily reply budget follow the person instead of the platform row (#44).
- `community_info` now names concrete member capabilities — `report_content`, `forget_me`, `suggest_improvement`, `remember_search`, `knowledge_search` — instead of a vague static blurb, and the one-time approval DM signposts this self-serve rundown (#92).

### Fixed
- A database hiccup during memory recall or session lookup no longer makes the bot go silent — the turn degrades (answers without memory context / starts a fresh session) and a router backstop guarantees the member always gets a reply (#52).
- `knowledge_search` now enforces the `scope` an entry was saved with: an admin's channel- or platform-scoped FAQ no longer surfaces to every member, everywhere — previously `scope` was write-only metadata, decorative at read time (#106).
- Review polish: the WhatsApp Cloud app secret is redacted from logs, dead `recentTurns` code removed, and the `usage_stats` window clamped to a sane range (#110).

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
