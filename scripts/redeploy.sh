#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Unattended redeploy-from-main (issue #50).
#
# Pull-based and fail-safe: fast-forwards the checkout to origin/main, then
# npm ci -> build -> migrate BEFORE restarting, so a broken build or migration
# leaves the currently-running service untouched. Installed via the systemd
# timer in deploy/community-agent-redeploy.timer (nightly, 1am
# Pacific/Auckland) — see docs/DEPLOYMENT.md.
#
# Outcomes:
#   - already at origin/main            -> "up to date", exit 0 (cheap no-op)
#   - dirty tree / non-fast-forward     -> abort, running service untouched
#   - ci/build/migrate failure          -> restore old code (rebuild), do NOT
#                                          restart, exit non-zero
#   - restarted but never healthy       -> roll back code, rebuild, restart
#                                          old build, exit non-zero
#
# Rollback restores CODE ONLY — an already-applied migration is never rolled
# back, so schema migrations must stay backward-compatible within a deploy
# (see docs/DEPLOYMENT.md). Failures land in the journal:
#   journalctl -u community-agent-redeploy
#
# Secret hygiene: .env is sourced only inside the migrate subshell, never
# echoed; do not add `set -x` (it would trace secret-bearing lines).
# ---------------------------------------------------------------------------
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/community-agent}"
# Service user that owns the checkout. When the script runs as root (the
# systemd unit does, so it can systemctl restart), build steps drop to this
# user; when run unprivileged (testing), steps run as the invoker. Set to the
# empty string to force running as the invoker even as root ("${VAR-…}", not
# ":-": explicitly-empty must not fall back to the default).
APP_USER="${APP_USER-community-agent}"
# systemd unit to restart. Set to the empty string to skip restart + health
# check entirely (lets the git/build/migrate flow be exercised outside systemd).
SERVICE_NAME="${SERVICE_NAME-community-agent}"
BRANCH="${BRANCH:-main}"
# Optional /healthz to poll after restart (e.g. http://127.0.0.1:8081/healthz
# when HEALTH_PORT is set). Empty = fall back to `systemctl is-active`.
HEALTH_URL="${HEALTH_URL:-}"
HEALTH_TIMEOUT_SECS="${HEALTH_TIMEOUT_SECS:-90}"
LOCK_FILE="${LOCK_FILE:-/var/lock/community-agent-redeploy.lock}"

log() { echo "[redeploy $(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }
die() {
  log "ABORT: $*"
  exit 1
}

# Run a build step as the service user when root, directly otherwise.
run_as_app() {
  if [ "$(id -u)" = "0" ] && [ -n "$APP_USER" ]; then
    runuser -u "$APP_USER" -- "$@"
  else
    "$@"
  fi
}

# npm ci + build never need .env; migrate does. The .env values stay inside
# the subshell's environment — nothing here prints them.
build_and_migrate() {
  run_as_app npm ci --no-audit --no-fund &&
    run_as_app npm run build &&
    run_as_app bash -c 'set -a; . ./.env; set +a; npm run migrate:prod'
}

restart_service() {
  [ -z "$SERVICE_NAME" ] && return 0
  systemctl restart "$SERVICE_NAME"
}

wait_healthy() {
  [ -z "$SERVICE_NAME" ] && return 0
  local deadline=$(($(date +%s) + HEALTH_TIMEOUT_SECS))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    sleep 5
    if [ -n "$HEALTH_URL" ]; then
      if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then return 0; fi
    else
      # No health endpoint configured: "active and not flapping" is the best
      # signal available (Restart=always means a crash loop stays 'activating').
      if systemctl is-active --quiet "$SERVICE_NAME"; then return 0; fi
    fi
  done
  return 1
}

main() {
  # Overlap guard: a slow build racing the next timer tick (or a manual run)
  # must queue behind flock's non-blocking failure, not run concurrently.
  exec 9>"$LOCK_FILE"
  flock -n 9 || die "another redeploy is already running (lock: $LOCK_FILE)"

  cd "$APP_DIR" || die "APP_DIR $APP_DIR does not exist"
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "$APP_DIR is not a git checkout"

  # Never deploy over local state: a dirty tree means a human is mid-change.
  # Untracked files are expected (.env, dist/, node_modules/, whatsapp-auth/)
  # — only modifications to TRACKED files block the deploy.
  [ -z "$(git status --porcelain --untracked-files=no)" ] ||
    die "working tree has local modifications; not touching anything"

  git fetch origin "$BRANCH" || die "git fetch failed"

  local old_sha new_sha
  old_sha="$(git rev-parse HEAD)"
  new_sha="$(git rev-parse "origin/$BRANCH")"

  if [ "$old_sha" = "$new_sha" ]; then
    log "up to date at $old_sha; nothing to deploy"
    exit 0
  fi

  # Fast-forward only: origin/$BRANCH must contain HEAD. Anything else means
  # history was rewritten or the checkout diverged — a human call, not ours.
  git merge-base --is-ancestor "$old_sha" "$new_sha" ||
    die "origin/$BRANCH ($new_sha) is not a fast-forward of HEAD ($old_sha)"

  log "deploying $old_sha -> $new_sha"
  git merge --ff-only "origin/$BRANCH" >/dev/null || die "fast-forward merge failed"

  if ! build_and_migrate; then
    # Restore the old code so the on-disk dist/ matches the still-running
    # service (Restart=always must not boot a half-built tree). CODE ONLY:
    # any migration that already applied stays applied — migrations must be
    # backward-compatible within a deploy (docs/DEPLOYMENT.md).
    log "build/migrate FAILED for $new_sha; restoring $old_sha, service NOT restarted"
    git reset --hard "$old_sha" >/dev/null
    run_as_app npm ci --no-audit --no-fund >/dev/null 2>&1 || true
    run_as_app npm run build >/dev/null 2>&1 || true
    exit 1
  fi

  restart_service || die "systemctl restart $SERVICE_NAME failed"

  if wait_healthy; then
    log "deployed $new_sha and healthy"
    exit 0
  fi

  # Roll back CODE ONLY (see note above — the migration stays), rebuild the
  # old tree, and restart onto it.
  log "service unhealthy after ${HEALTH_TIMEOUT_SECS}s on $new_sha; rolling back to $old_sha"
  git reset --hard "$old_sha" >/dev/null
  if build_and_migrate && restart_service && wait_healthy; then
    log "rolled back to $old_sha and healthy — investigate $new_sha before the next deploy"
  else
    log "ROLLBACK DID NOT COME UP HEALTHY — manual intervention required"
  fi
  exit 1
}

main "$@"
