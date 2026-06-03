#!/usr/bin/env bash
# scripts/backup-avatars.sh — nightly member-pass avatar volume → Cloudflare R2.
#
# Member-pass photos are files on the `avatars` Docker named volume (served at
# /api/avatars/*), NOT rows in Postgres, so backup-pg.sh does not cover them.
# This tars the volume read-only and streams it to the same R2 bucket. Run it
# right after backup-pg.sh in the nightly cron.
#
# Restore (manual — newest object):
#   OBJ=$(rclone lsf r2:animego-backup/ | grep '^avatars-' | sort | tail -1)
#   rclone cat "r2:animego-backup/$OBJ" \
#     | docker run --rm -i -v animego_avatars:/data alpine:3 tar -xzf - -C /data
#
# Refs:
#   tar -C: change dir so archived paths are relative (clean restore)
#     https://www.gnu.org/software/tar/manual/html_node/directory.html
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

log() { printf '[backup-avatars] %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }

# Concurrency lock — prevents overlapping cron runs.
LOCK_FILE="/tmp/animego-backup-avatars.lock"
exec 9>"$LOCK_FILE"
flock -n 9 || die "another backup-avatars.sh is already running (lock=$LOCK_FILE)"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Compose project prefixes the volume name (<project>_avatars). Defaults to the
# repo dir name (animego) unless COMPOSE_PROJECT_NAME / AVATARS_VOLUME override.
# (dev compose runs under its own project name, so COMPOSE_PROJECT_NAME is the
# knob for --env=dev rather than a separate hardcoded name here.)
PROJECT="${COMPOSE_PROJECT_NAME:-$(basename "$REPO_ROOT")}"
VOLUME="${AVATARS_VOLUME:-${PROJECT}_avatars}"

HELPER_IMAGE="${BACKUP_HELPER_IMAGE:-alpine:3}"
R2_REMOTE="${R2_REMOTE:-r2}"
R2_BUCKET="${R2_BUCKET:-animego-backup}"
DATE_UTC="$(date -u +%Y-%m-%d)"
OBJECT="avatars-${DATE_UTC}.tar.gz"
DEST="${R2_REMOTE}:${R2_BUCKET}/${OBJECT}"

log "env=$ENV_MODE volume=$VOLUME helper=$HELPER_IMAGE"
log "destination=$DEST (re-run today overwrites — rclone rcat is idempotent per object)"

command -v rclone >/dev/null || die "rclone not installed"
command -v docker >/dev/null || die "docker not installed"
docker volume inspect "$VOLUME" >/dev/null 2>&1 \
  || die "avatars volume '$VOLUME' not found (set AVATARS_VOLUME?)"

START_TS="$(date +%s)"
# Mount the volume read-only into a throwaway helper so the backup never
# touches the running go-api. tar -C /data . archives the volume contents with
# relative paths; an empty volume produces a valid (tiny) archive.
log "starting tar (read-only volume) → rclone rcat"
docker run --rm -v "${VOLUME}:/data:ro" "$HELPER_IMAGE" \
  tar -czf - -C /data . \
  | rclone rcat --s3-no-check-bucket "$DEST" \
  || die "tar|rclone rcat pipeline failed"

DURATION=$(( $(date +%s) - START_TS ))
log "upload complete in ${DURATION}s — verifying size"

SIZE_OUT="$(rclone size "$DEST" 2>&1)" || die "rclone size failed: $SIZE_OUT"
log "size: $(echo "$SIZE_OUT" | tr '\n' ' ')"
log "SUCCESS object=$OBJECT duration=${DURATION}s"
