#!/usr/bin/env bash
# scripts/backup-pg.sh — nightly Postgres → Cloudflare R2 backup.
#
# Refs:
#   pg_dump -Fc: custom binary format, compressed, parallel-restore-capable
#     https://www.postgresql.org/docs/16/app-pgdump.html
#   rclone rcat: stream stdin → remote object (no temp file on disk)
#     https://rclone.org/commands/rclone_rcat/

set -euo pipefail

ENV_MODE="prod"
for arg in "$@"; do
  case "$arg" in
    --env=dev)  ENV_MODE="dev" ;;
    --env=prod) ENV_MODE="prod" ;;
    -h|--help)
      echo "Usage: $0 [--env=dev|prod]"; exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '[backup-pg] %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }

# Concurrency lock — prevents overlapping cron runs.
LOCK_FILE="/tmp/animego-backup-pg.lock"
exec 9>"$LOCK_FILE"
flock -n 9 || die "another backup-pg.sh is already running (lock=$LOCK_FILE)"

# Resolve compose file + container by env.
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
if [[ "$ENV_MODE" == "dev" ]]; then
  COMPOSE_FILE="docker-compose.dev.yml"
  PG_SERVICE="postgres"
  CONTAINER_HINT="animego-postgres-dev"
else
  COMPOSE_FILE="docker-compose.yml"
  PG_SERVICE="postgres"
  CONTAINER_HINT="animego-postgres"
fi
[[ -f "$COMPOSE_FILE" ]] || die "compose file not found: $REPO_ROOT/$COMPOSE_FILE"

DB_NAME="${POSTGRES_DB:-animego}"
DB_USER="${POSTGRES_USER:-animego}"
R2_REMOTE="${R2_REMOTE:-r2}"
R2_BUCKET="${R2_BUCKET:-animego-backup}"
DATE_UTC="$(date -u +%Y-%m-%d)"
OBJECT="pg-${DATE_UTC}.dump"
DEST="${R2_REMOTE}:${R2_BUCKET}/${OBJECT}"

log "env=$ENV_MODE compose=$COMPOSE_FILE container=$CONTAINER_HINT db=$DB_NAME"
log "destination=$DEST (re-run today overwrites — rclone rcat is idempotent per object)"

command -v rclone >/dev/null || die "rclone not installed"
command -v docker >/dev/null || die "docker not installed"
docker compose -f "$COMPOSE_FILE" ps "$PG_SERVICE" >/dev/null 2>&1 \
  || die "postgres service '$PG_SERVICE' not running in $COMPOSE_FILE"

START_TS="$(date +%s)"
# -Fc: custom format, internally zlib-compressed; -Z 6 picks compression level.
# Stream pg_dump stdout → rclone stdin → R2 object (no local temp file).
# pipefail ensures either side failing aborts the chain.
log "starting pg_dump → rclone rcat"
docker compose -f "$COMPOSE_FILE" exec -T "$PG_SERVICE" \
  pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc -Z 6 \
  | rclone rcat --s3-no-check-bucket "$DEST" \
  || die "pg_dump|rclone rcat pipeline failed"

DURATION=$(( $(date +%s) - START_TS ))
log "upload complete in ${DURATION}s — verifying size"

# rclone size: confirms object exists and reports bytes.
# https://rclone.org/commands/rclone_size/
SIZE_OUT="$(rclone size "$DEST" 2>&1)" || die "rclone size failed: $SIZE_OUT"
log "size: $(echo "$SIZE_OUT" | tr '\n' ' ')"
log "SUCCESS object=$OBJECT duration=${DURATION}s"
