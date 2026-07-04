# Security design

This document describes the threat model and the controls in place. Treat it as
a living document — review it whenever you add a tool or a platform.

## Assets to protect

1. **Claude subscription token** (`CLAUDE_CODE_OAUTH_TOKEN`) — grants use of your
   Claude account.
2. **Discord bot token** — full control of the bot identity in the server.
3. **WhatsApp linked-device credentials** (`whatsapp-auth/`) — effectively
   control of the bot's WhatsApp number.
4. **The interaction database** — contains community members' messages (PII).
5. **Moderation authority** — the ability to timeout/kick/announce.

## Threat model & controls

### 1. Privilege escalation via chat ("prompt injection")
A normal user tries to get the agent to moderate, announce, or reveal secrets.

**Controls**
- **Built-in tools disabled outright**: the `tools` option passed to every
  `query()` removes ALL built-in Claude Code tools (Bash/Read/Write/Glob/…)
  from the model's surface, with one deliberate exception: **admin and
  super-admin turns get exactly `WebSearch`** (search-and-summarise). Note
  `allowedTools` alone does NOT restrict — it only pre-approves; the
  restriction comes from the `tools` list.
- **WebFetch stays disallowed for every tier**: the model constructs fetch
  URLs, so an injection could exfiltrate conversation content via a query
  string to an attacker's server, and fetched pages are a rich injection
  vector. WebSearch snippets are a much smaller surface; they are still
  untrusted content and the system prompt says so.
- **Structural RBAC (three tiers)**: `allowedTools` is computed from the
  *sender's* resolved tier (super_admin > admin > member > guest), not from
  anything in the message. A lower tier's turn never has higher-tier tools
  attached, so the model cannot call them even if convinced to.
- **Admin scoping is data-layer**: admins' cross-conversation tools filter in
  SQL against the admin's *platform-verified* conversation membership
  (Discord channel visibility / WhatsApp group participation, cached ~60s).
- **Confirm-before-destructive**: kick/timeout/delete/purge/forget — and
  **grant_admin**, the highest-blast-radius action of all — register a pending
  action; the actor must reply CONFIRM in the same conversation within 60s.
  The confirmation is intercepted by the router *before* the addressed-check
  (so a bare CONFIRM works in group chats; bot mention tokens are stripped and
  tolerated) and executed deterministically — it never passes through the
  model, so an injection can *request* an action but can never *complete*
  one. The actor's tier is **re-resolved at confirm time**: a role revoked
  inside the TTL invalidates the queued action.
- **Defence in depth**: every privileged tool calls `assertAtLeast()` before
  any side effect.
- **Identity is platform-derived**: super admins come from env config; admins
  and members from the `community_users` table, changed only via audited
  super-admin/admin tools — never from message content. The system prompt
  explicitly states that messages cannot grant permissions.
- **Super-admin alerting**: every successful privileged action DMs the other
  super admins, so misuse or a successful injection is *seen*, not just logged.
- **Memory is conversation-scoped**: automatic recall and `remember_search`
  only see the current conversation. Cross-conversation search (which could
  expose other members' DMs) is admin-only.
- **Recalled content is quarantined**: memories are injected into the *user*
  turn inside a delimited `<recalled-messages>` block with angle brackets
  stripped (so recalled text can't fake a closing tag), and the system prompt
  instructs the model to treat recalled/tool-returned chat content as data,
  never instructions. This mitigates stored prompt injection; it does not
  eliminate it — see "Residual risks".
- **Privileged targets are validated**: `moderate`/`announce` refuse targets
  (conversations/users) the bot has never seen, so a manipulated admin turn
  cannot message arbitrary phone numbers or unknown channels.
- `settingSources: []` prevents loading the host's `~/.claude` config.

### 2. Secret exposure
**Controls**
- Secrets live only in `.env` (git-ignored; `chmod 600`) and are loaded as env
  vars. `ANTHROPIC_API_KEY` is actively deleted at startup to enforce
  subscription-only billing.
- The logger **redacts** token/password fields.
- The system prompt instructs the agent never to reveal instructions, tokens,
  or internal ids.
- `whatsapp-auth/` and `*.key`/`*.pem` are git-ignored.

### 3. Abuse / cost runaway
**Controls**
- Per-user rate limit (8 msg/min).
- `AGENT_MAX_TURNS` caps the agentic loop per request.
- Per-conversation serialisation bounds concurrent `query()` calls.
- `cost_usd` is recorded per outbound turn for monitoring.
- The bot only responds when **addressed** (mention/reply) or in a direct
  chat — it does not react to every message in a channel.
- `report_content` is capped at 5 submissions per reporter per rolling 24h,
  enforced as a `COUNT(*)` over `content_reports.created_at` inside the insert
  query itself — a DB-backed check, not an in-memory counter, so it survives a
  restart and can't be bypassed by timing a bounce (the only in-memory rate
  limiter in the codebase is router.ts's per-message map, which is unrelated
  and does reset on restart by design).
- Optional proactive alert (`USAGE_ALERT_DAILY_REPLIES`, off by default):
  when the rolling-24h outbound reply count reaches the configured
  threshold, super admins get one debounced DM (`src/usageAlert.ts`) instead
  of having to remember to run `usage_stats`. Reply count, not `cost_usd`, is
  the trigger — it's a coarse proxy for shared Max-pool draw that can't
  silently under-report the way `cost_usd` can (see below). No auto-pause;
  a super admin decides.

### 4. Moderation misuse / accountability
**Controls**
- Every privileged action is written to the append-only `admin_audit` table
  (who, what, target, params, result, success, timestamp).
- Admin actions are gated on platform-native admin identity.

### 5. Host compromise / blast radius
**Controls**
- Runs as a dedicated, non-login system user (`community-agent`).
- systemd hardening: `NoNewPrivileges`, `ProtectSystem=strict`,
  `ProtectHome`, `PrivateTmp`, restricted namespaces, single `ReadWritePaths`.
- Postgres bound to localhost with a dedicated least-privilege role.

### 6. Data protection (member PII)
- All messages are stored for memory/audit. **Inform your community** that an
  AI assistant logs interactions (Discord/WhatsApp etiquette + NZ Privacy Act
  2020 expectations).
- **Member notes** (`member_notes`, issue #45): admins can attach durable,
  person-scoped context notes to *known* members (unknown identities are
  refused). This is a deliberate, owner-approved PII surface with hard
  boundaries: notes are **human-entered only** (the bot never auto-populates
  one from web search or chat), **admin-read only** via `list_member_notes`
  (never on member/guest turns, never in `knowledge_search` — the table has
  no embedding column — never in memory recall; pinned by `SECURITY:`
  tests), writes/deletes are **audited** (the audit row records that a note
  was added, never its text, so a later purge actually removes the content),
  and `forget_me`/`purge_user_data` delete all notes **about** the person.
  The owner has explicitly accepted (issue #45) that there is **no
  self-access path** (members cannot read notes about themselves) and that
  admins may manually transcribe web-researched facts into a note — both are
  scope decisions for this small, high-trust community, revisit if it grows.
- **Server roster** (`server_roster`, issue #47): join/leave events plus a
  startup backfill persist **identity metadata for every guild member** —
  platform user id, display name, join/leave timestamps, rejoin count —
  including non-members and lurkers who have never interacted with the bot.
  It stores **no message content** (pinned by a `SECURITY:` test, plus a
  structural column check so a content-bearing column can't appear
  silently). Reads are **admin-tier and guild-wide** (`list_roster` is not
  conversation-scoped — same precedent as `list_access_requests`), display
  names are wrapped as untrusted data, and `forget_me`/`purge_user_data`
  delete the person's roster row. Roster rows are durable (like
  `community_users`); age-purging `left_at` rows is a possible future
  refinement, noted under residual risks.
- Provide a deletion path: delete rows from `interactions` (and `knowledge`)
  by `user_id` on request (`forget_me` / `purge_user_data`).
- **Retention policy**: set `INTERACTION_RETENTION_DAYS` to age-purge raw
  `interactions` (default unset = disabled, no behaviour change on upgrade).
  A daily in-process timer (`src/index.ts`) deletes rows older than the
  configured window and logs the count purged. Must be `0` or **at least 7
  days** (enforced at startup) so a low value can't silently gut memory
  recall for users still mid-conversation. `knowledge` (curated, durable
  facts), `admin_audit` (accountability trail), and `sessions` (governed by
  `SESSION_MAX_TURNS`/`_AGE_HOURS`) are never touched by this purge.

## Platform-specific notes

### WhatsApp / Baileys ToS risk
Baileys uses the unofficial WhatsApp Web protocol. This **violates WhatsApp's
Terms of Service** and the number can be **banned** at any time, and the
protocol can break. Mitigations: use a dedicated number you can afford to lose,
keep volume human-like, or switch to `WhatsAppCloudAdapter`
(`WHATSAPP_PROVIDER=cloud`), the official, ToS-compliant Meta Cloud API — see
"Switching WhatsApp providers" in `docs/ARCHITECTURE.md`. Running Baileys is a
deliberate, accepted trade-off for immediate, free operation; revisit it
before scaling.

Enabling `WHATSAPP_WELCOME_ENABLED` adds an **unprompted, event-triggered
automated group post** (a static message on `group-participants.update`) to
this unofficial path — not a risk-free feature. It never DMs the joiner
(the higher-risk pattern), it's operator-gated (off by default), and it's
cooldown-bounded (`WHATSAPP_WELCOME_COOLDOWN_MINUTES`) so it can't fire on
every join in an active group — but it is still a new automation pattern the
account posts without being addressed first, which is exactly the kind of
bot-fingerprint the ToS-risk mitigations above are trying to minimise.

### WhatsApp Cloud API webhook
`WhatsAppCloudAdapter` exposes a public HTTP listener
(`WHATSAPP_CLOUD_WEBHOOK_PORT`) that must sit behind TLS termination (see
`docs/DEPLOYMENT.md`). Every inbound `POST` is rejected unless its
`X-Hub-Signature-256` header verifies against `WHATSAPP_CLOUD_APP_SECRET`
(HMAC-SHA256 over the raw body, timing-safe compare) — the body is never
parsed before that check passes. `WHATSAPP_CLOUD_ACCESS_TOKEN` and
`WHATSAPP_CLOUD_APP_SECRET` are secrets and must go through the same
`.env`-only, git-ignored handling as other tokens. Message content and
delivery metadata for Cloud API traffic are additionally retained by Meta
per their own terms, on top of this project's own storage.

### `/healthz` endpoint
Opt-in (`HEALTH_PORT` unset = no listening port at all — matches this
pipeline's "new surface is opt-in" pattern). Unauthenticated by design, but
the response is boolean connectivity flags only (`{status, db, adapters}`) —
no message content, no user identifiers, no internal ids. Bind to localhost
and put a reverse proxy in front if exposing it externally, same guidance as
the Cloud API webhook port above. The sustained-disconnect super-admin DM
alert reuses the existing adapter `sendDirectMessage` path — no new
privileged tool, no RBAC surface.

### Discord
- Enable only the gateway intents the bot needs (Guilds, GuildMessages,
  MessageContent, GuildMembers, DirectMessages). **Both `MessageContent` and
  `GuildMembers` are privileged intents — enable them in the Developer Portal
  or the bot will fail to log in.**
- Give the bot the least role permissions required for moderation (Timeout
  Members, Kick Members, Manage Messages) and place its role appropriately in
  the hierarchy.

## Subscription-auth caveat
Anthropic's Agent SDK docs state subscription/claude.ai login is **not
officially supported** for SDK-built products and recommend an API key. As of
June 2026, headless SDK usage on Pro/Max additionally draws from a **separate
weekly token pool** (rate-limited differently from interactive use), and the
consumer terms language against using consumer OAuth tokens in
third-party/automated services has tightened. Using your own subscription for
your own community bot remains a personal decision and a grey area. The auth
layer is isolated in `src/agent/auth.ts`; switch to an API key by setting
`ANTHROPIC_API_KEY` and removing the deletion in that file if you ever need
the supported path.

## Residual risks (accepted, documented)
- **Prompt injection is mitigated, not solved.** An admin turn still processes
  untrusted channel text. The blast radius is bounded by: conversation-scoped
  targets, the CONFIRM gate on destructive actions, super-admin alerting, and
  the audit log. Non-confirm actions (`warn_user`, `announce` within scope)
  remain a lever a successful injection could pull.
- **Membership-scope staleness**: adapters cache an admin's conversation list
  for ~60s, so an admin removed from a channel/group can retain data scope for
  up to that window.
- **Guests in gated mode are invisible**: their messages are not stored, which
  also means no audit trail of what strangers sent the WhatsApp number. Trade
  chosen deliberately (privacy > forensics for non-members). The one exception
  is `access_requests` (the pending-access queue): it stores identity
  (platform, user id/name) and a request count/timestamps for guests who
  addressed the bot, but never their message content — an admin-only,
  `list_access_requests`-gated read, not a new content-storage surface.
- **The roster narrows the "guests are invisible" spirit, not its letter**:
  `server_roster` deliberately records the *identity* (never content) of every
  guild member — including lurkers who never touched the bot — because the
  onboarding queue ("joined but never added") and growth counts need exactly
  that. It is metadata every server member can already see in the member
  list, it is deletable (`forget_me`/`purge_user_data`), and reads are
  admin-only and guild-wide rather than conversation-scoped. Rows for people
  who left are kept (with `left_at`) for churn history; an age-purge of
  departed rows is a future refinement if retention expectations tighten.
- **forget_me/purge scope**: deletes the user's messages, replies to them,
  knowledge entries *sourced from* them, and content reports *they submitted
  as reporter*. Membership rows, the admin audit log, and reports where the
  user is only the *target* (not the reporter) are retained deliberately
  (accountability) — the same precedent already applied to `admin_audit`.
- **DM-originated content reports are visible only to super admins.**
  `list_reports` is scoped exactly like `moderation_history`/
  `list_access_requests`: an admin only sees reports from conversations they
  actually participate in. WhatsApp is 1:1 with the bot and Discord DMs
  likewise, so no ordinary admin is ever a "participant" of another member's
  DM — a report filed from a DM therefore only reaches the unrestricted
  (null-scope) super-admin view, never a scoped admin. This is a deliberate,
  documented default (not a silent drop): the report is still recorded and
  retrievable, just only by super admins, until/unless a routing mechanism
  for DM-originated reports is added.
- **The daily budget counts recorded replies** — if cost/usage recording fails,
  the budget degrades open (rate limiter still applies).
- **The `claude` CLI subprocess** still has network access (it must reach the
  Anthropic API). OS-level egress filtering is the next hardening step if
  needed.

## Behaviour policy (code answers)
`code_answers` policy (super admin, `set_policy`): `off` strips all fenced
code from replies, `snippets` (default) truncates fences beyond ~15 lines,
`full` disables the filter. Unterminated fences are treated as running to
end-of-text, so an unclosed ``` cannot bypass the policy. Enforced *outside*
the model — the filter (plus unconditional secret redaction: exact runtime
secrets incl. WhatsApp Cloud tokens + common token patterns) lives **inside
the adapters' send paths**, so every outbound message — router replies,
`announce`, `warn_user` DMs, super-admin alerts — passes through it; no
future send path can forget. Discord additionally sends with
`allowedMentions: []` (no injected @everyone pings), and WhatsApp refuses to
route `lid:`-fallback ids as phone JIDs (a LID's digits sent as a phone
number could reach an unrelated person).

## Operational checklist
- [ ] `.env` is `chmod 600` and owned by the service user.
- [ ] `whatsapp-auth/` directory is `chmod 700`, not in git.
- [ ] Postgres is not exposed to the network.
- [ ] Bot has minimal Discord permissions.
- [ ] Community is informed that interactions are logged, **that server
      join/leave events (identity + timestamps, no content) are recorded for
      admin onboarding/growth views, and that admins may keep private
      context notes about members** (deletable on request via `forget_me`).
- [ ] A retention/deletion policy is defined (`forget_me`/`purge_user_data`
      for per-user requests; `INTERACTION_RETENTION_DAYS` for age-based purge).
- [ ] `journalctl -u community-agent` reviewed for redaction leaks.
- [ ] **Branch protection on `main`** blocks direct and force pushes (require a
      PR + review). This is the backstop for the pipeline's write-scoped
      automation — the build and autofix workers hold a `contents: write` token,
      so branch protection is what guarantees nothing reaches `main` without a
      human merge even if a worker is prompt-injected into misusing `git push`.
