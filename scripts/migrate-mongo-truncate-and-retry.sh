#!/usr/bin/env bash
# scripts/migrate-mongo-truncate-and-retry.sh
#
# Re-run migrate-mongo against the same Mongo dump after wiping PG state.
# Necessary because:
#   - `danmakus` PK is bigint IDENTITY, so re-running on the same dump
#     would duplicate every row (ConflictTarget="" for that transform).
#   - `anime_cache` child tables (genres / studios / relations / characters
#     / staff / recommendations / episode_titles) are inserted via plain
#     INSERT without ON CONFLICT, so re-running raises PK / UNIQUE
#     violations on the children even though the parent rows UPSERT
#     cleanly.
#
# This script is the official "do-over" path during cutover rehearsal
# (P8.5 Day-6) and any debugging where the operator wants to re-load the
# whole dataset from Mongo.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

ENV_MODE="${ENV_MODE:-dev}"           # dev (default) or prod
MONGO_URI="${MONGO_URI:-mongodb://localhost:27017/animego_prod_copy}"
BATCH_SIZE="${BATCH_SIZE:-500}"
FAIL_LOG="${FAIL_LOG:-/tmp/animego-migrate-failed.jsonl}"

if [[ "$ENV_MODE" == "dev" ]]; then
    COMPOSE_FILE="docker-compose.dev.yml"
    PG_SERVICE="postgres"
    DB_USER="animego"
    DB_NAME="animego"
else
    COMPOSE_FILE="docker-compose.yml"
    PG_SERVICE="postgres"
    DB_USER="animego"
    DB_NAME="animego"
fi

# Pull DATABASE_URL from the project .env so we don't echo passwords.
if [ -f .env ]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
fi
DATABASE_URL="${DATABASE_URL:?DATABASE_URL not set; cp .env.example .env first}"

log() { printf '[migrate-retry] %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

# All 14 migration-target tables + schema_migrations is untouched.
PG_TABLES=(
    users
    anime_cache
    anime_genres
    anime_studios
    anime_relations
    anime_characters
    anime_staff
    anime_recommendations
    anime_episode_titles
    subscriptions
    follows
    episode_comments
    danmakus
    episode_windows
)

log "env=$ENV_MODE compose=$COMPOSE_FILE db=$DB_NAME"
log "mongo source: $MONGO_URI"

log "TRUNCATE 14 tables with RESTART IDENTITY CASCADE"
PGTABLES_CSV="$(IFS=,; echo "${PG_TABLES[*]}")"
docker compose -f "$COMPOSE_FILE" exec -T "$PG_SERVICE" \
    psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -c \
    "TRUNCATE ${PGTABLES_CSV} RESTART IDENTITY CASCADE;"

log "rerun migrate-mongo --commit"
START="$(date +%s)"
(
    cd go-api
    go run ./cmd/migrate-mongo \
        --commit \
        --mongo-uri="$MONGO_URI" \
        --pg-uri="$DATABASE_URL" \
        --batch-size="$BATCH_SIZE" \
        --log-failed="$FAIL_LOG"
)
DUR=$(( $(date +%s) - START ))
log "migrate-mongo completed in ${DUR}s"

# Quick sanity assert — every table should have at least one row if Mongo
# dump was non-empty.  Adjust if a particular table is genuinely empty in
# the source.
log "PG row counts:"
docker compose -f "$COMPOSE_FILE" exec -T "$PG_SERVICE" \
    psql -U "$DB_USER" -d "$DB_NAME" -At -c \
    "SELECT '  ' || relname || ': ' || n_live_tup FROM pg_stat_user_tables WHERE relname != 'schema_migrations' ORDER BY relname;" >&2

log "SUCCESS"
