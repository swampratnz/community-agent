# Deployment (Ubuntu)

End-to-end setup on a fresh Ubuntu host.

## 0. Prerequisites
- Ubuntu 22.04+ with sudo.
- A Discord application + bot (token, `MessageContent` intent enabled).
- A dedicated phone number with WhatsApp installed (for Baileys linking).
- A machine where you're logged into Claude Code to mint the OAuth token.

## 1. Provision the host
```bash
git clone <your-repo> community-agent && cd community-agent
sudo bash deploy/setup-ubuntu.sh
```
This installs Node 20, PostgreSQL + pgvector, creates the `community_agent`
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
`DISCORD_GUILD_ID`, `DISCORD_ADMIN_USER_IDS`, `WHATSAPP_ADMIN_NUMBERS`,
`DATABASE_URL` (with the password from step 1).

## 5. Run migrations
```bash
cd /opt/community-agent
sudo -u community-agent --preserve-env=PATH bash -lc 'set -a; . ./.env; set +a; npm run migrate'
```

## 6. Link the WhatsApp number (one-time, interactive)
```bash
sudo -u community-agent bash -lc 'set -a; . ./.env; set +a; npm run whatsapp:link'
```
A QR code prints in the terminal. On the dedicated phone:
**WhatsApp → Settings → Linked Devices → Link a device → scan**.
Wait for `WhatsApp connected`, then Ctrl-C. Credentials are saved in
`whatsapp-auth/` and reused by the service.

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
sudo -u community-agent --preserve-env=PATH bash -lc 'set -a; . ./.env; set +a; npm run migrate'
sudo systemctl restart community-agent
```

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
- **Discord bot silent** — check the `MessageContent` privileged intent is on,
  the bot can see the channel, and (if set) `DISCORD_ALLOWED_CHANNEL_IDS`
  includes it. The bot only replies when @mentioned, replied to, or DM'd.
- **`embedding dimension mismatch`** — `EMBEDDING_DIM` must match the model
  (`all-MiniLM-L6-v2` = 384). Changing models requires re-embedding existing
  rows.
- **First reply is slow** — the embedding model downloads once on first use.
