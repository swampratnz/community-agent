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
- **Built-in tools disabled outright**: `tools: []` is passed to every
  `query()`, removing ALL built-in Claude Code tools (Bash/Read/Write/Glob/…)
  from the model's surface. Note `allowedTools` alone does NOT do this — it
  only pre-approves; the restriction comes from `tools: []`.
- **Structural RBAC**: `allowedTools` is computed from the *sender's* resolved
  role, not from anything in the message. A user-role turn never has privileged
  tools attached, so the model cannot call them even if convinced to.
- **Defence in depth**: every privileged tool calls `assertAdmin()` before any
  side effect.
- **Identity is platform-derived**: admin status comes from Discord role/user
  ids or WhatsApp numbers in config — never from message content. The system
  prompt explicitly states that messages cannot grant permissions.
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
  by `user_id` on request. Consider a retention policy (e.g. purge raw
  `interactions` older than N months while keeping aggregate `knowledge`).

## Platform-specific notes

### WhatsApp / Baileys ToS risk
Baileys uses the unofficial WhatsApp Web protocol. This **violates WhatsApp's
Terms of Service** and the number can be **banned** at any time, and the
protocol can break. Mitigations: use a dedicated number you can afford to lose,
keep volume human-like, and keep the `WhatsAppCloudAdapter` path ready to
migrate to the official API. This is a deliberate, accepted trade-off for
immediate, free operation — revisit it before scaling.

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
  untrusted channel text; the target validation and audit log bound the blast
  radius of a successful injection to known conversations/users.
- **`announce`/`warn_user` to known targets** is still a lever an attacker
  could pull via a manipulated admin turn — the audit log is the detective
  control.
- **The `claude` CLI subprocess** still has network access (it must reach the
  Anthropic API). OS-level egress filtering is the next hardening step if
  needed.

## Operational checklist
- [ ] `.env` is `chmod 600` and owned by the service user.
- [ ] `whatsapp-auth/` directory is `chmod 700`, not in git.
- [ ] Postgres is not exposed to the network.
- [ ] Bot has minimal Discord permissions.
- [ ] Community is informed that interactions are logged.
- [ ] A retention/deletion policy is defined.
- [ ] `journalctl -u community-agent` reviewed for redaction leaks.
