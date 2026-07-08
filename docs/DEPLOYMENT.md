# Deployment (Ubuntu)

End-to-end setup on a fresh Ubuntu host.

## 0. Prerequisites
- Ubuntu 22.04+ with sudo.
- A Discord application + bot token, with the **`MessageContent` and
  `GuildMembers` privileged intents enabled** in the Developer Portal.
- A dedicated phone number with WhatsApp installed (for Baileys linking).
- A machine where you're logged into Claude Code to mint the OAuth token.

## 1. Provision the host
```bash
git clone <your-repo> community-agent && cd community-agent
sudo bash deploy/setup-ubuntu.sh
```
This installs Node 24 LTS, PostgreSQL + pgvector (0.8.4+), creates the `community_agent`
database/role and a dedicated `community-agent` service user. **Save the printed
DB password.**

## 2. Deploy the code
```bash
sudo rsync -a --exclude node_modules --exclude .git ./ /opt/community-agent/
sudo chown -R community-agent:community-agent /opt/community-agent
cd /opt/community-agent
sudo -u community-agent npm ci
sudo -u community-agent npm run build
```

## 3. Mint the Claude subscription token
On a machine where you're logged into Claude Code:
```bash
claude setup-token        # prints a CLAUDE_CODE_OAUTH_TOKEN
```
Copy the token into `.env` (next step).

## 4. Configure `.env`
```bash
sudo -u community-agent cp .env.example .env
sudo -u community-agent chmod 600 .env
sudo -u community-agent nano .env      # fill in all values
```
Set at least: `CLAUDE_CODE_OAUTH_TOKEN`, `DISCORD_BOT_TOKEN`,
`DISCORD_GUILD_ID`, `SUPER_ADMIN_DISCORD_IDS`, `SUPER_ADMIN_WHATSAPP_NUMBERS`,
`DATABASE_URL` (with the password from step 1). Access is **gated** by
default — after startup, message the bot as a super admin and use
`add_member` / `grant_admin` to onboard people.

Consider also setting `INTERACTION_RETENTION_DAYS` (e.g. `90`) to
automatically age-purge raw message content per your privacy policy — it's
disabled by default so existing deployments see no behaviour change.
Similarly, `ROSTER_DEPARTED_RETENTION_DAYS` (e.g. `90`, minimum `30`)
age-purges `server_roster` rows for members who have left; also disabled by
default and independent of the interactions purge above.

Sustained platform-disconnect alerting to super admins is always on
(`HEALTH_ALERT_AFTER_MINUTES`, default 5 minutes). Optionally set
`HEALTH_PORT` to expose two unauthenticated endpoints for an external uptime
monitor:

- `GET /healthz` — `{status, db, adapters}`; reports `degraded` (503) if any
  chat adapter is disconnected. Use this for monitoring/alerting.
- `GET /readyz` — `{status, db}`; liveness + DB reachability only,
  independent of adapter connectivity. **The redeploy `HEALTH_URL` should
  point here** so a WhatsApp/Discord socket still reconnecting after a
  restart doesn't look unhealthy and trigger a rollback of a good build.

The server binds to `HEALTH_HOST` (default `127.0.0.1`), so it is not
reachable off-box unless you deliberately set a routable interface or
reverse-proxy it, same as the WhatsApp Cloud API webhook.

## 5. Run migrations
```bash
cd /opt/community-agent
sudo -u community-agent bash -lc 'set -a; . ./.env; set +a; npm run migrate:prod'
```

## 6. Link the WhatsApp number (one-time, interactive)
```bash
sudo -u community-agent bash -lc 'set -a; . ./.env; set +a; npm run whatsapp:link'
```
A QR code prints in the terminal. On the dedicated phone:
**WhatsApp → Settings → Linked Devices → Link a device → scan**.
Wait for `WhatsApp connected`, then Ctrl-C. Credentials are saved in
`whatsapp-auth/` and reused by the service.

## 6b. (Alternative) Configure the WhatsApp Cloud API instead of Baileys
Skip step 6 and use the official, ToS-compliant Meta Cloud API instead:

1. In [Meta for Developers](https://developers.facebook.com/), create an app
   with the **WhatsApp** product added, and note the **Phone number ID**,
   a **temporary or permanent access token**, and the app's **App secret**
   (App settings → Basic).
2. In `.env`, set `WHATSAPP_PROVIDER=cloud` and fill in
   `WHATSAPP_CLOUD_PHONE_NUMBER_ID`, `WHATSAPP_CLOUD_ACCESS_TOKEN`,
   `WHATSAPP_CLOUD_APP_SECRET`, and a `WHATSAPP_CLOUD_VERIFY_TOKEN` of your
   choosing (any random string — you'll enter the same value in Meta's
   dashboard). `WHATSAPP_CLOUD_WEBHOOK_PORT` defaults to `8080`.
3. Expose that port over HTTPS — Meta requires TLS for webhooks and will not
   deliver to plain HTTP. Put a reverse proxy (nginx/Caddy) in front with a
   real certificate, forwarding to `127.0.0.1:$WHATSAPP_CLOUD_WEBHOOK_PORT`.
4. In the Meta app's WhatsApp → Configuration page, set the **Callback URL**
   to your public HTTPS URL and the **Verify token** to the same
   `WHATSAPP_CLOUD_VERIFY_TOKEN` value, then subscribe to the `messages`
   webhook field. Meta will GET the URL to verify it — the service must
   already be running (start it, or run step 8 first, then return here).
5. No `whatsapp:link` step, no QR code, and no `whatsapp-auth/` directory —
   the Cloud API is stateless on this side.

Note: the Cloud API only allows free-form replies within the 24h window after
a user messages the bot; outside that window only pre-approved message
templates can be sent (not implemented here — the adapter fails clearly
instead of attempting an unsupported send).

## 7. Invite the Discord bot
In the Developer Portal, generate an OAuth2 URL with the `bot` scope and
permissions: *Read Messages/View Channels, Send Messages, Read Message History,
Moderate Members (timeout), Kick Members, Manage Messages, Manage Events*. Open
it and add the bot to your server. (Manage Events is required for the admin
`create_event` tool, issue #230 — without it, `create_event` fails with a
permission error.)

## 8. Install the service
```bash
sudo cp deploy/community-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now community-agent
sudo journalctl -u community-agent -f
```

## 9. (Optional) Enable chat-to-GitHub issue filing (`suggest_issue`)
Lets a super admin file a repo issue straight from Discord/WhatsApp. Off unless
configured. Mint a **fine-grained PAT** (GitHub → Settings → Developer settings →
Fine-grained tokens): **Resource owner** = the repo owner, **Repository access** =
only `GITHUB_ISSUE_REPO`, **Permissions → Repository → Issues: Read and write**
(nothing else). Then in `.env`:
```bash
GITHUB_ISSUE_ENABLED=true
GITHUB_ISSUE_TOKEN=github_pat_...        # the fine-grained PAT above — NOT the OAuth token
# GITHUB_ISSUE_REPO defaults to swampratnz/community-agent
```
Restart the service. Verify by DMing the bot as a super admin ("file an issue:
…") and confirming with CONFIRM. Revoke the PAT to disable instantly. See
docs/SECURITY.md §12 for why the token is scoped this narrowly.

## Upgrades
```bash
cd /opt/community-agent
sudo -u community-agent git pull           # or rsync new code
sudo -u community-agent npm ci && sudo -u community-agent npm run build
sudo -u community-agent bash -lc 'set -a; . ./.env; set +a; npm run migrate:prod'
sudo systemctl restart community-agent
```

## Automated nightly redeploy (1am NZ time)

`scripts/redeploy.sh` + the systemd timer automate the upgrade steps above,
unattended, every night at **1am Pacific/Auckland** (DST-correct — the
timezone lives in `OnCalendar`, not a hard-coded UTC hour):

```bash
sudo cp deploy/community-agent-redeploy.service /etc/systemd/system/
sudo cp deploy/community-agent-redeploy.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now community-agent-redeploy.timer
systemctl list-timers community-agent-redeploy.timer   # shows the next 1am run
```

What a run does, in order: `flock` (no overlapping runs) → clean-tree check
(untracked files like `.env`/`dist/` are fine; *modified tracked* files
abort, and the abort line names the offending paths so a wedge is
diagnosable straight from `journalctl` — see issue #108) → `git fetch` →
**fast-forward-only** update to `origin/main` (a diverged or rewritten
history aborts; nothing is ever force-reset over local commits) →
`npm ci` → `npm run build` → `npm run migrate:prod` → `systemctl
restart` → health poll (`HEALTH_URL` — point it at `/readyz` — if set, else
`systemctl is-active`). The health poll now requires several *consecutive*
good polls (and, on the `systemctl is-active` path, that systemd hasn't
auto-restarted the unit while watching), so a crash loop under
`Restart=always` can't briefly look healthy and be accepted (issue #215).
If nothing was merged since the last run it exits 0 at the fetch step
("up to date") — the nightly tick is effectively free.

`systemctl restart` sends `SIGTERM` first; on receipt the process waits up to
`SHUTDOWN_DRAIN_TIMEOUT_MS` (default 20s) for any in-flight per-conversation
turn to finish and send its reply before closing adapter connections and the
DB (issue #210) — this covers exactly the "a member is mid-turn at 1am"
window. `deploy/community-agent.service` sets no `TimeoutStopSec`, so
systemd's default (90s) governs how long the graceful stop has before
`SIGKILL`; if you ever override it, keep it comfortably above
`SHUTDOWN_DRAIN_TIMEOUT_MS` or systemd will `SIGKILL` the process before the
drain finishes.

Note: any in-process job that writes files inside `APP_DIR` (e.g. the
community-context exporter, issue #53) must write to an **untracked**
path — `CONTEXT_EXPORT_PATH` defaults to a git-ignored `var/` file for
exactly this reason (issue #108). Writing to a tracked path there would
permanently trip the clean-tree check above.

Fail-safe behaviour:

- A **build/migrate failure** restores the old code (and its `dist/`) and
  does **not** restart — the running service stays on the old build.
- A **restart that never becomes healthy** rolls back to the old commit,
  rebuilds, and restarts onto it.
- **Rollback restores code only.** An already-applied migration is never
  rolled back, so **schema migrations must stay backward-compatible within a
  deploy** — the old binary must be able to run against the new schema. This
  repo's additive `IF NOT EXISTS` migration style already satisfies that;
  keep it that way.

Preconditions and caveats:

- This deploys whatever is at `origin/main` as the service user. **Branch
  protection on `main` (require PR + review) and CODEOWNERS are the controls
  that make pull-deploy safe** — they're what guarantees `origin/main` only
  ever contains human-merged code (see `docs/SECURITY.md`'s operational
  checklist). Do not enable the timer without them.
- Failures are visible via `journalctl -u community-agent-redeploy` and the
  unit's failed state (`systemctl status community-agent-redeploy`). For
  push-style alerting, attach an `OnFailure=` unit of your choosing — the
  running bot's super-admin DM path lives inside the bot process and is not
  callable from this standalone script (deliberately small scope).
- Non-systemd alternative: a root crontab entry
  `0 1 * * * TZ=Pacific/Auckland /opt/community-agent/scripts/redeploy.sh`
  (note: plain cron evaluates the schedule in the *system* timezone; the
  `TZ=` prefix only affects the job, so prefer the systemd timer, which
  handles the NZST/NZDT shift correctly).

To exercise it manually: `sudo systemctl start community-agent-redeploy.service`
(one run, same logs), or run the script directly with `SERVICE_NAME=""` to
test the git/build/migrate flow without touching the running service.

### Chat-triggered redeploy (opt-in, issue #101)

A super admin can also say something like "deploy the latest code" instead of
waiting for the 1am timer or reaching for SSH. This is the `redeploy_bot` tool
— super-admin only, CONFIRM-gated (the actor must reply `CONFIRM` within 60s;
`CANCEL` or a timeout starts nothing), and **router-executed with a `{}` input
schema**: the model cannot supply a ref, branch, or any argument, so an
injected turn can at most *request* a deploy of whatever is already at
`origin/main` — the same fast-forward-only, human-merged code the nightly
timer would have deployed anyway — and still can't complete it without the
super admin's own CONFIRM reply. It starts the identical
`community-agent-redeploy.service` oneshot unit the timer uses (via
`sudo -n systemctl start --no-block …`, no shell, fixed argv), so the
`flock` in `scripts/redeploy.sh` rules out overlap between the two triggers.
Like every privileged action it writes an `admin_audit` row and DMs the other
super admins.

This requires one **opt-in, deploy-time** sudoers grant so the bot's
unprivileged service user can start (only start — not stop, restart, or any
other unit) exactly this one unit, non-interactively:

```
community-agent ALL=(root) NOPASSWD: /usr/bin/systemctl start community-agent-redeploy.service
```

Add it via `sudo visudo -f /etc/sudoers.d/community-agent-redeploy` (exact
command match, no wildcard — `systemctl` is not granted generally). Without
this line the tool fails immediately with a clear error (`sudo -n` never
prompts or hangs waiting for a password) — it does not silently do nothing
and does not wedge the CONFIRM flow.

## Image generation via Grok CLI (opt-in, off by default)

The admin/super-admin `generate_image` tool shells out to the **Grok Build CLI**
on the host. It's off unless `IMAGE_GEN_ENABLED=true`. To enable it:

1. **Install the CLI** as the service user (or globally) and **log in once**
   with a SuperGrok subscription — device-code flow, no API key:
   ```bash
   sudo -u community-agent -H bash -lc 'grok login --device-auth'
   ```
   This writes `~/.grok/auth.json` under the service user's `HOME`
   (`/opt/community-agent/home/.grok/`). Treat that file as a credential — it is
   the subscription login, and it lives on the host, outside the repo.
2. **Set the env** in `/opt/community-agent/.env`:
   ```
   IMAGE_GEN_ENABLED=true
   GROK_BIN=/opt/community-agent/home/.grok/bin/grok
   # optional: IMAGE_GEN_TIMEOUT_MS=180000  IMAGE_GEN_DAILY_LIMIT=25
   ```
   **Set `GROK_BIN` to an absolute path**, not a bare `grok`. With a bare name
   the binary is resolved via `PATH`, so any directory earlier in the service's
   `PATH` that an attacker (or a careless deploy) can write to could shadow the
   real CLI with a hostile one that then runs as the service user. An absolute
   path removes that PATH-hijack surface. The systemd unit runs with a fixed
   `Environment=PATH`, so keep the binary outside any writable path.
3. **Restart**: `sudo systemctl restart community-agent`.

Security posture (scoped subprocess env, single-tool lockdown so
`--always-approve` can't execute host code, RBAC, daily cap) is documented in
docs/SECURITY.md §8. The CLI runs under the same sandboxed unit as the bot
(`ProtectHome`, `ProtectSystem=strict`, `PrivateTmp`), which bounds it further.

## Cosmetic community roles (opt-in, off by default, issue #232)
The admin `assign_community_role`/`remove_community_role` tools let an admin
grant/revoke purely cosmetic Discord roles (regional tags, "verified
builder", interest groups) — strictly separate from the bot's own RBAC. Off
unless `DISCORD_ASSIGNABLE_ROLES` is set. To enable it:

1. **Pre-create each role in Discord** with **no permissions** (leave every
   permission toggle off — `@everyone`-level). The bot's assign-time check
   (docs/SECURITY.md §10) will refuse to grant any role that carries a
   permission, even one listed below, so a permission-bearing role just
   fails loudly rather than being silently handed out.
2. **Position the bot's own role above** every role you list, in the
   server's Role list (drag it higher). Discord refuses a role
   grant/removal from any actor — including a bot — positioned at or below
   the target role, so this is required for the tools to work at all, not
   just a hardening step.
3. **Set the env** in `/opt/community-agent/.env` with the roles' ids
   (right-click a role → Copy Role ID, with Developer Mode on):
   ```
   DISCORD_ASSIGNABLE_ROLES=1111111111111111,2222222222222222
   ```
4. **Restart**: `sudo systemctl restart community-agent`.

Use the read-only `list_assignable_roles` tool afterwards to confirm each
configured role resolved correctly and none is flagged as carrying
permissions.

## Backups
Back up the database (memory + audit) and the WhatsApp auth dir:
```bash
pg_dump community_agent | gzip > backup-$(date +%F).sql.gz
tar czf whatsapp-auth-$(date +%F).tgz -C /opt/community-agent whatsapp-auth
```

## Troubleshooting
- **`Invalid environment configuration`** — a required env var is missing; the
  log lists which.
- **WhatsApp keeps showing a QR / `logged out`** — re-run step 6.
- **Meta webhook verification fails (Cloud API)** — confirm the service is
  reachable over HTTPS at the exact Callback URL configured, and that
  `WHATSAPP_CLOUD_VERIFY_TOKEN` matches the "Verify token" field in the Meta
  dashboard exactly.
- **Cloud API messages silently do nothing / 401 in logs** — the webhook's
  `X-Hub-Signature-256` didn't match `WHATSAPP_CLOUD_APP_SECRET`; double-check
  you copied the App secret (not the access token) from Meta's Basic settings.
- **Discord bot silent or login fails** — check the `MessageContent` **and**
  `GuildMembers` privileged intents are on,
  the bot can see the channel, and (if set) `DISCORD_ALLOWED_CHANNEL_IDS`
  includes it. The bot only replies when @mentioned, replied to, or DM'd.
- **`embedding dimension mismatch`** — `EMBEDDING_DIM` must match the model
  (`all-MiniLM-L6-v2` = 384). Changing models requires re-embedding existing
  rows.
- **First reply is slow** — the embedding model downloads once on first use.
