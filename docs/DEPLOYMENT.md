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

Sustained platform-disconnect alerting to super admins is always on
(`HEALTH_ALERT_AFTER_MINUTES`, default 5 minutes). Optionally set
`HEALTH_PORT` to expose an unauthenticated `GET /healthz` for an external
uptime monitor — bind it to localhost and reverse-proxy it if you expose it
publicly, same as the WhatsApp Cloud API webhook.

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
Moderate Members (timeout), Kick Members, Manage Messages*. Open it and add the
bot to your server.

## 8. Install the service
```bash
sudo cp deploy/community-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now community-agent
sudo journalctl -u community-agent -f
```

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
abort) → `git fetch` → **fast-forward-only** update to `origin/main` (a
diverged or rewritten history aborts; nothing is ever force-reset over local
commits) → `npm ci` → `npm run build` → `npm run migrate:prod` → `systemctl
restart` → health poll (`HEALTH_URL` if set, else `systemctl is-active`).
If nothing was merged since the last run it exits 0 at the fetch step
("up to date") — the nightly tick is effectively free.

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
- Triggering a redeploy from chat is **out of scope** for this mechanism —
  if ever built, it must be super-admin + CONFIRM-gated, router-executed,
  and take no model-supplied arguments (see issue #50's review).
- Non-systemd alternative: a root crontab entry
  `0 1 * * * TZ=Pacific/Auckland /opt/community-agent/scripts/redeploy.sh`
  (note: plain cron evaluates the schedule in the *system* timezone; the
  `TZ=` prefix only affects the job, so prefer the systemd timer, which
  handles the NZST/NZDT shift correctly).

To exercise it manually: `sudo systemctl start community-agent-redeploy.service`
(one run, same logs), or run the script directly with `SERVICE_NAME=""` to
test the git/build/migrate flow without touching the running service.

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
