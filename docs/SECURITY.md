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
- **forget_me/purge scope**: deletes the user's messages, replies to them, and
  knowledge entries *sourced from* them. Membership rows and the admin audit
  log are retained deliberately (accountability).
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
- [ ] Community is informed that interactions are logged.
- [ ] A retention/deletion policy is defined (`forget_me`/`purge_user_data`
      for per-user requests; `INTERACTION_RETENTION_DAYS` for age-based purge).
- [ ] `journalctl -u community-agent` reviewed for redaction leaks.
