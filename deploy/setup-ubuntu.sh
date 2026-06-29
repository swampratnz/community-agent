#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Provision an Ubuntu host to run the Community Agent.
# Installs Node 20, PostgreSQL + pgvector, creates a dedicated service user,
# and sets up the database. Run as root (or with sudo).
#
#   sudo bash deploy/setup-ubuntu.sh
#
# Idempotent-ish: safe to re-run. Review before running in production.
# ---------------------------------------------------------------------------
set -euo pipefail

APP_USER="${APP_USER:-community-agent}"
APP_DIR="${APP_DIR:-/opt/community-agent}"
DB_NAME="${DB_NAME:-community_agent}"
DB_USER="${DB_USER:-community_agent}"
DB_PASS="${DB_PASS:-$(openssl rand -hex 16)}"

echo "==> Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl ca-certificates gnupg postgresql postgresql-contrib build-essential git

echo "==> Installing Node.js 20 LTS"
if ! command -v node >/dev/null || [[ "$(node -v)" != v20* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> Installing pgvector"
# postgresql-NN-pgvector matches the installed server major version.
PG_MAJOR="$(psql -V | grep -oE '[0-9]+' | head -1)"
apt-get install -y "postgresql-${PG_MAJOR}-pgvector" || {
  echo "Package postgresql-${PG_MAJOR}-pgvector unavailable; building pgvector from source"
  apt-get install -y postgresql-server-dev-"${PG_MAJOR}"
  tmp="$(mktemp -d)"; git clone --depth 1 https://github.com/pgvector/pgvector.git "$tmp"
  make -C "$tmp"; make -C "$tmp" install
}

echo "==> Creating database and role"
sudo -u postgres psql <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}';
  END IF;
END \$\$;
SELECT 'CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${DB_NAME}')\gexec
SQL
sudo -u postgres psql -d "${DB_NAME}" -c "CREATE EXTENSION IF NOT EXISTS vector;"

echo "==> Creating service user '${APP_USER}'"
id -u "${APP_USER}" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "${APP_USER}"
mkdir -p "${APP_DIR}"
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"

cat <<NOTE

============================================================================
Provisioning complete.

  App dir:      ${APP_DIR}
  DB name:      ${DB_NAME}
  DB user:      ${DB_USER}
  DB password:  ${DB_PASS}   <-- save this; put it in DATABASE_URL

Next steps:
  1. Deploy code:   rsync your repo into ${APP_DIR} (as ${APP_USER})
  2. cd ${APP_DIR} && sudo -u ${APP_USER} npm ci && sudo -u ${APP_USER} npm run build
  3. Create ${APP_DIR}/.env from .env.example (chmod 600), set:
       DATABASE_URL=postgres://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}
  4. sudo -u ${APP_USER} CLAUDE_CODE_OAUTH_TOKEN=... npm run migrate
  5. Link WhatsApp:  sudo -u ${APP_USER} npm run whatsapp:link   (scan QR)
  6. Install service: cp deploy/community-agent.service /etc/systemd/system/
                      systemctl daemon-reload && systemctl enable --now community-agent
============================================================================
NOTE
