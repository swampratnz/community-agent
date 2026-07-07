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

# Run a git/build step as the service user when root, directly otherwise.
# EVERY git and npm invocation must go through this: git as root against the
# community-agent-owned checkout would both trip git's dubious-ownership
# refusal and parse network-supplied pack data (git fetch) with root
# privileges. Root is kept exclusively for systemctl.
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
  # A single "good" poll is not enough: under Restart=always a crash-looping
  # service cycles activating -> active -> (crash) -> activating, so one
  # is-active poll (or one lucky curl) can land in a momentary 'active' window
  # and pronounce a flapping service healthy (issue #215). Require several
  # consecutive good polls before returning healthy, and — for the systemctl
  # path — also require that systemd has not auto-restarted the unit since we
  # started watching (NRestarts climbing = it crashed and came back).
  local need_ok=3 ok_streak=0 baseline_restarts cur_restarts
  baseline_restarts="$(systemctl show -p NRestarts --value "$SERVICE_NAME" 2>/dev/null || echo 0)"
  [ -n "$baseline_restarts" ] || baseline_restarts=0
  while [ "$(date +%s)" -lt "$deadline" ]; do
    sleep 5
    if [ -n "$HEALTH_URL" ]; then
      if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
        ok_streak=$((ok_streak + 1))
      else
        ok_streak=0 # a crash loop can't answer curl for need_ok polls straight
      fi
    else
      # No health endpoint: "active AND NRestarts hasn't climbed since we
      # started watching" is the best crash-loop-aware signal available.
      cur_restarts="$(systemctl show -p NRestarts --value "$SERVICE_NAME" 2>/dev/null || echo "$baseline_restarts")"
      [ -n "$cur_restarts" ] || cur_restarts="$baseline_restarts"
      if systemctl is-active --quiet "$SERVICE_NAME" && [ "$cur_restarts" -le "$baseline_restarts" ]; then
        ok_streak=$((ok_streak + 1))
      else
        ok_streak=0
      fi
    fi
    [ "$ok_streak" -ge "$need_ok" ] && return 0
  done
  return 1
}

main() {
  # Overlap guard: a slow build racing the next timer tick (or a manual run)
  # must queue behind flock's non-blocking failure, not run concurrently.
  exec 9>"$LOCK_FILE"
  flock -n 9 || die "another redeploy is already running (lock: $LOCK_FILE)"

  cd "$APP_DIR" || die "APP_DIR $APP_DIR does not exist"
  run_as_app git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "$APP_DIR is not a git checkout"

  # Never deploy over local state: a dirty tree means a human is mid-change.
  # Untracked files are expected (.env, dist/, node_modules/, whatsapp-auth/)
  # — only modifications to TRACKED files block the deploy. Name the
  # offending paths in the abort so any future same-class wedge (some
  # process writing tracked files on the server, e.g. issue #108) is
  # diagnosable straight from the journal instead of requiring an SSH
  # session to reproduce.
  local dirty
  dirty="$(run_as_app git status --porcelain --untracked-files=no)"
  [ -z "$dirty" ] ||
    die "working tree has local modifications, not touching anything: $(printf '%s' "$dirty" | tr '\n' ';')"

  run_as_app git fetch origin "$BRANCH" || die "git fetch failed"

  local old_sha new_sha
  old_sha="$(run_as_app git rev-parse HEAD)"
  new_sha="$(run_as_app git rev-parse "origin/$BRANCH")"

  if [ "$old_sha" = "$new_sha" ]; then
    log "up to date at $old_sha; nothing to deploy"
    exit 0
  fi

  # Fast-forward only: origin/$BRANCH must contain HEAD. Anything else means
  # history was rewritten or the checkout diverged — a human call, not ours.
  run_as_app git merge-base --is-ancestor "$old_sha" "$new_sha" ||
    die "origin/$BRANCH ($new_sha) is not a fast-forward of HEAD ($old_sha)"

  log "deploying $old_sha -> $new_sha"
  run_as_app git merge --ff-only "origin/$BRANCH" >/dev/null || die "fast-forward merge failed"

  if ! build_and_migrate; then
    # Restore the old code so the on-disk dist/ matches the still-running
    # service (Restart=always must not boot a half-built tree). CODE ONLY:
    # any migration that already applied stays applied — migrations must be
    # backward-compatible within a deploy (docs/DEPLOYMENT.md).
    log "build/migrate FAILED for $new_sha; restoring $old_sha, service NOT restarted"
    run_as_app git reset --hard "$old_sha" >/dev/null
    # The rebuild of the restored tree must not fail silently: if it does, the
    # on-disk dist/ is left inconsistent with the still-running (or
    # Restart=always-rebooting) service, and swallowing it with `|| true`
    # hid exactly that (issue #215). Make it a loud, greppable journal marker.
    if run_as_app npm ci --no-audit --no-fund >/dev/null 2>&1 &&
      run_as_app npm run build >/dev/null 2>&1; then
      log "restored and rebuilt $old_sha; service left on the old code"
    else
      log "RESTORE FAILED: could not rebuild $old_sha after the failed deploy — on-disk dist/ may be inconsistent with the running service; MANUAL INTERVENTION REQUIRED"
    fi
    exit 1
  fi

  # Roll back CODE ONLY (the migration stays — see the note above), rebuild
  # the old tree, and restart onto it. Used both when the restart itself
  # fails and when the restarted service never becomes healthy — either way
  # the box must not be left down on the new code with no recovery attempt.
  roll_back() {
    run_as_app git reset --hard "$old_sha" >/dev/null
    if build_and_migrate && restart_service && wait_healthy; then
      log "rolled back to $old_sha and healthy — investigate $new_sha before the next deploy"
    else
      log "ROLLBACK DID NOT COME UP HEALTHY — manual intervention required"
    fi
    exit 1
  }

  if ! restart_service; then
    log "systemctl restart FAILED on $new_sha; rolling back to $old_sha"
    roll_back
  fi

  if wait_healthy; then
    log "deployed $new_sha and healthy"
    exit 0
  fi

  log "service unhealthy after ${HEALTH_TIMEOUT_SECS}s on $new_sha; rolling back to $old_sha"
  roll_back
}

main "$@"
