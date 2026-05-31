#!/usr/bin/env bash
# scripts/restore-pg-drill.sh — restore drill (P0 → P1 critical gate).
#
# Fetches newest R2 backup, restores into a throwaway DB on dev compose,
# runs sanity checks, then drops the temp DB.  Exit 0=PASS, 1=FAIL.
#
# Refs:
#   pg_restore: https://www.postgresql.org/docs/16/app-pgrestore.html
#   rclone lsjson + jq: deterministic "newest object" pick
#     https://rclone.org/commands/rclone_lsjson/

set -euo pipefail

log()  { printf '[restore-drill] %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
fail() { log "FAIL: $*"; exit 1; }

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
COMPOSE_FILE="docker-compose.dev.yml"
PG_SERVICE="postgres"
[[ -f "$COMPOSE_FILE" ]] || fail "compose file not found: $COMPOSE_FILE"

DB_USER="${POSTGRES_USER:-animego}"
DRILL_DB="animego_restore_drill"
R2_REMOTE="${R2_REMOTE:-r2}"
R2_BUCKET="${R2_BUCKET:-animego-backup}"
WORK_DIR="$(mktemp -d -t animego-restore-XXXXXX)"
LOCAL_DUMP="$WORK_DIR/latest.dump"

cleanup() {
  log "cleanup: dropping $DRILL_DB and removing $WORK_DIR"
  docker compose -f "$COMPOSE_FILE" exec -T "$PG_SERVICE" \
    psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=0 \
    -c "DROP DATABASE IF EXISTS $DRILL_DB;" >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

command -v rclone >/dev/null || fail "rclone not installed"
command -v jq >/dev/null     || fail "jq not installed (apt install jq | brew install jq)"
docker compose -f "$COMPOSE_FILE" ps "$PG_SERVICE" >/dev/null 2>&1 \
  || fail "dev postgres not running — start with: docker compose -f $COMPOSE_FILE up -d postgres"

# 1) Find newest backup within last 30 days using lsjson + jq (deterministic).
log "scanning ${R2_REMOTE}:${R2_BUCKET} for newest pg-*.dump (<=30d)"
NEWEST="$(rclone lsjson "$R2_REMOTE:$R2_BUCKET" --include "pg-*.dump" --max-age 30d \
  | jq -r 'sort_by(.ModTime) | reverse | .[0].Name // empty')"
[[ -n "$NEWEST" ]] || fail "no pg-*.dump found in last 30d"
log "newest=$NEWEST"

# 2) Download via rclone copy (resumable, integrity-checked).
DL_START="$(date +%s)"
rclone copy "$R2_REMOTE:$R2_BUCKET/$NEWEST" "$WORK_DIR/" --progress >&2 \
  || fail "rclone copy failed"
mv "$WORK_DIR/$NEWEST" "$LOCAL_DUMP"
DL_BYTES="$(stat -c%s "$LOCAL_DUMP" 2>/dev/null || stat -f%z "$LOCAL_DUMP")"
DL_SEC=$(( $(date +%s) - DL_START ))
log "downloaded ${DL_BYTES} bytes in ${DL_SEC}s"

# 3) Create throwaway DB and pg_restore into it.
log "creating throwaway DB: $DRILL_DB"
docker compose -f "$COMPOSE_FILE" exec -T "$PG_SERVICE" \
  psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS $DRILL_DB;" \
  -c "CREATE DATABASE $DRILL_DB OWNER $DB_USER;" >/dev/null \
  || fail "could not create $DRILL_DB"

RESTORE_START="$(date +%s)"
log "pg_restore → $DRILL_DB (streaming dump via stdin)"
# --no-owner --no-acl: tolerate role differences between prod and dev.
# Exit nonzero on hard errors; warnings (e.g. extension missing) are OK.
docker compose -f "$COMPOSE_FILE" exec -T "$PG_SERVICE" \
  pg_restore -U "$DB_USER" -d "$DRILL_DB" --no-owner --no-acl \
  < "$LOCAL_DUMP" \
  || fail "pg_restore failed"
RESTORE_SEC=$(( $(date +%s) - RESTORE_START ))
log "pg_restore completed in ${RESTORE_SEC}s"

# 4) Sanity checks.
psql_drill() {
  docker compose -f "$COMPOSE_FILE" exec -T "$PG_SERVICE" \
    psql -U "$DB_USER" -d "$DRILL_DB" -At -v ON_ERROR_STOP=1 -c "$1"
}

PG_VERSION="$(psql_drill "SELECT version();")" || fail "SELECT version() failed"
log "version: $PG_VERSION"

TABLE_COUNT="$(psql_drill "SELECT COUNT(*) FROM pg_tables WHERE schemaname='public';")"
log "public table count: $TABLE_COUNT"
[[ "$TABLE_COUNT" -gt 0 ]] || fail "no tables in restored public schema"

# Robust per-table row counts: skip tables that don't exist (schema is P1 — TBD).
KNOWN_TABLES=(anime_cache users subscriptions)
declare -a ROW_REPORTS=()
for t in "${KNOWN_TABLES[@]}"; do
  EXISTS="$(psql_drill "SELECT to_regclass('public.${t}') IS NOT NULL;")"
  if [[ "$EXISTS" == "t" ]]; then
    RC="$(psql_drill "SELECT COUNT(*) FROM public.${t};")"
    ROW_REPORTS+=("${t}=${RC}")
  else
    ROW_REPORTS+=("${t}=ABSENT")
  fi
done

# Also list ALL public tables with row counts for completeness.
log "discovered tables:"
psql_drill "SELECT format('  %s (%s rows)', tablename,
    (xpath('/row/c/text()',
       query_to_xml(format('SELECT COUNT(*) AS c FROM public.%I', tablename), true, true, '')))[1]::text)
  FROM pg_tables WHERE schemaname='public' ORDER BY tablename;" \
  | while IFS= read -r line; do log "$line"; done

log "PASS download=${DL_BYTES}B dl=${DL_SEC}s restore=${RESTORE_SEC}s tables=${TABLE_COUNT} known=[${ROW_REPORTS[*]}]"
exit 0
