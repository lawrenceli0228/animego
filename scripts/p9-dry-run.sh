#!/usr/bin/env bash
# P9 dry-run — runbook §3 (T-3d gate) executed LOCALLY.
#
# Reproduces the dry-run pipeline so we can verify the migration story
# before T+0 cutover. Idempotent: re-running with --skip-restore reuses
# whatever data is already loaded into mongo.
#
# Usage:
#   ./scripts/p9-dry-run.sh --dump-source=/tmp/prod-mongo.gz
#   ./scripts/p9-dry-run.sh --dump-source=/tmp/prod-mongo.gz --skip-restore
#
# Env:
#   CI_AUTO=1  — skip interactive confirmations (for cron / CI)
#
# Exit codes:
#   0  — full pipeline OK, failures.jsonl == 0 lines (gate passes)
#   1  — any step failed, or failures.jsonl > 0 (gate fails)
#   2  — bad arguments / preflight failure

set -euo pipefail

# --- repo root (script lives in scripts/) ------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- log file ----------------------------------------------------------
TS="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="/tmp/p9-dry-run-${TS}.log"

# --- color helpers (TTY-aware) ----------------------------------------
if [ -t 1 ] && command -v tput >/dev/null 2>&1 && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
    C_GREEN="$(tput setaf 2)"
    C_RED="$(tput setaf 1)"
    C_YELLOW="$(tput setaf 3)"
    C_BOLD="$(tput bold)"
    C_RESET="$(tput sgr0)"
else
    C_GREEN=""; C_RED=""; C_YELLOW=""; C_BOLD=""; C_RESET=""
fi

ok()   { printf "%s[OK]%s   %s\n"   "$C_GREEN"  "$C_RESET" "$1"; }
warn() { printf "%s[WARN]%s %s\n"   "$C_YELLOW" "$C_RESET" "$1"; }
fail() { printf "%s[FAIL]%s %s\n"   "$C_RED"    "$C_RESET" "$1"; }
info() { printf "%s[..]%s   %s\n"   "$C_BOLD"   "$C_RESET" "$1"; }

# --- redirect everything through tee ----------------------------------
# Must run AFTER color helpers so the log file gets ANSI-free text via
# `tee` — but our color codes only fire on TTY, so the log will be clean
# when this script is invoked via cron.
exec > >(tee -a "$LOG_FILE") 2>&1
info "logging to $LOG_FILE"

# --- args --------------------------------------------------------------
DUMP_SOURCE=""
SKIP_RESTORE=0

for arg in "$@"; do
    case "$arg" in
        --dump-source=*)  DUMP_SOURCE="${arg#--dump-source=}" ;;
        --skip-restore)   SKIP_RESTORE=1 ;;
        --help|-h)
            printf "usage: %s --dump-source=<path-to-mongodump.gz> [--skip-restore]\n" "$0"
            exit 0
            ;;
        *) fail "unknown arg: $arg"; exit 2 ;;
    esac
done

if [ "$SKIP_RESTORE" -eq 0 ] && [ -z "$DUMP_SOURCE" ]; then
    fail "--dump-source=<path> is required unless --skip-restore is set"
    exit 2
fi
if [ "$SKIP_RESTORE" -eq 0 ] && [ ! -f "$DUMP_SOURCE" ]; then
    fail "dump source not found: $DUMP_SOURCE"
    exit 2
fi

# --- confirm helper ---------------------------------------------------
confirm() {
    local action="$1"
    printf "%s[ABOUT TO]%s %s\n" "$C_YELLOW" "$C_RESET" "$action"
    if [ "${CI_AUTO:-0}" = "1" ]; then
        info "CI_AUTO=1 — auto-continuing"
        return 0
    fi
    sleep 3
    local reply
    read -p "Continue? (y/N) " -r reply
    if [[ ! "$reply" =~ ^[Yy]$ ]]; then
        fail "user aborted"
        exit 1
    fi
}

# --- runner that prints command before running ------------------------
run() {
    info "\$ $*"
    "$@"
}

# --- timer helper -----------------------------------------------------
time_step() {
    local label="$1"; shift
    local start end elapsed
    start="$(date +%s)"
    "$@"
    end="$(date +%s)"
    elapsed=$((end - start))
    ok "$label finished in ${elapsed}s"
    printf "%s\t%ds\n" "$label" "$elapsed" >> "/tmp/p9-dry-run-timing-${TS}.txt"
}

# ======================================================================
# STEP 1 — preflight
# ======================================================================
info "STEP 1/8 — preflight"

ENV_FILE="$REPO_ROOT/.env.production"
if [ ! -f "$ENV_FILE" ]; then
    fail "$ENV_FILE not found — runbook §3 step 1 requires it"
    exit 2
fi
ok "$ENV_FILE exists"

# pull POSTGRES_PASSWORD out of .env.production WITHOUT sourcing the
# whole file (avoid leaking secrets into env if something else is set).
PG_PASS="$(grep -E '^POSTGRES_PASSWORD=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
if [ -z "$PG_PASS" ]; then
    fail "POSTGRES_PASSWORD missing or empty in $ENV_FILE"
    exit 2
fi
ok "POSTGRES_PASSWORD is set in .env.production"

cd "$REPO_ROOT"

# ======================================================================
# STEP 2 — reset mongo + postgres
# ======================================================================
if [ "$SKIP_RESTORE" -eq 0 ]; then
    info "STEP 2/8 — reset mongodb + postgres volumes"
    confirm "docker compose down mongodb postgres + volume rm (DESTROYS local data)"

    run docker compose down mongodb postgres || warn "down had non-zero exit (probably not running yet, ok)"
    # Volume names follow the standard compose convention <project>_<volname>.
    # If the operator overrode COMPOSE_PROJECT_NAME the rm will say "no such
    # volume" — harmless; the next `up` will recreate clean volumes.
    run docker volume rm animego_mongo-data 2>/dev/null || warn "animego_mongo-data already gone"
    run docker volume rm animego_postgres-data 2>/dev/null || warn "animego_postgres-data already gone"
    ok "volumes wiped"
else
    info "STEP 2/8 — skipped (--skip-restore)"
fi

# ======================================================================
# STEP 3 — bring up mongo + postgres, wait healthy
# ======================================================================
info "STEP 3/8 — start mongodb + postgres"
run docker compose --env-file=.env.production up -d mongodb postgres

info "waiting up to 60s for mongo + postgres to become healthy..."
HEALTHY=0
for i in $(seq 1 60); do
    # `docker compose ps --format json` is one row per service; grep for
    # both being healthy or running-without-healthcheck.
    M_STATE="$(docker compose ps --format '{{.Service}}={{.Status}}' 2>/dev/null | grep '^mongodb=' || true)"
    P_STATE="$(docker compose ps --format '{{.Service}}={{.Status}}' 2>/dev/null | grep '^postgres=' || true)"
    if echo "$M_STATE" | grep -qiE "(healthy|up)" && echo "$P_STATE" | grep -qiE "(healthy|up)"; then
        HEALTHY=1
        break
    fi
    sleep 1
done
if [ "$HEALTHY" -ne 1 ]; then
    fail "mongo + postgres did not come healthy in 60s"
    info "current state:"
    docker compose ps mongodb postgres || true
    exit 1
fi
ok "mongo + postgres up"

# ======================================================================
# STEP 4 — mongorestore from dump
# ======================================================================
if [ "$SKIP_RESTORE" -eq 0 ]; then
    info "STEP 4/8 — mongorestore from $DUMP_SOURCE"
    confirm "stream $DUMP_SOURCE into docker compose exec mongodb mongorestore (will overwrite collections)"

    time_step "restore" bash -c "docker compose exec -T mongodb mongorestore --gzip --archive --drop < '$DUMP_SOURCE'"
    ok "mongorestore done"
else
    info "STEP 4/8 — skipped (--skip-restore)"
fi

# ======================================================================
# STEP 5 — migrate-mongo --dry-run
# ======================================================================
info "STEP 5/8 — migrate-mongo dry-run"

# IMPORTANT: the runbook §3 step 3 snippet OMITS --dry-run/--commit but
# go-api/cmd/migrate-mongo/main.go REQUIRES exactly one of them
# (validateFlags). We use --dry-run here since this is the T-3d gate.
# Runbook ambiguity reported in the wrap-up.
MIGRATE_FAILURES="$REPO_ROOT/go-api/migrate-failures.jsonl"
rm -f "$MIGRATE_FAILURES"

# Run the migrator from inside go-api/ via `go run` so we don't need a
# pre-built binary. URI hostnames are `localhost` because mongo + pg are
# port-forwarded on the host by docker compose for local dev.
cd "$REPO_ROOT/go-api"
MIGRATE_CMD=(
    go run ./cmd/migrate-mongo
        --mongo-uri="mongodb://localhost:27017/animego"
        --pg-uri="postgres://animego:${PG_PASS}@localhost:5432/animego?sslmode=disable"
        --dry-run
        --log-failed="$MIGRATE_FAILURES"
)
info "\$ ${MIGRATE_CMD[*]}"
time_step "migrate" "${MIGRATE_CMD[@]}"
cd "$REPO_ROOT"

# ======================================================================
# STEP 6 — inspect failures.jsonl
# ======================================================================
info "STEP 6/8 — inspect failures.jsonl"
if [ -f "$MIGRATE_FAILURES" ]; then
    LINE_COUNT="$(wc -l < "$MIGRATE_FAILURES" | tr -d ' ')"
else
    LINE_COUNT=0
fi
info "failures.jsonl line count: $LINE_COUNT"
if [ "$LINE_COUNT" -gt 0 ]; then
    warn "first 5 failure lines:"
    head -5 "$MIGRATE_FAILURES"
    fail "gate: failures.jsonl must be 0 for T-3d gate to pass"
    GATE_PASS=0
else
    ok "gate: failures.jsonl is empty"
    GATE_PASS=1
fi

# ======================================================================
# STEP 7 — full Go stack + smoke
# ======================================================================
info "STEP 7/8 — bring up Go stack + smoke"
run docker compose --env-file=.env.production up -d postgres go-api ws-server next-app nginx

info "waiting 20s for stack to settle..."
sleep 20

SMOKE_SCRIPT="$REPO_ROOT/scripts/smoke-p8.1.sh"
if [ ! -x "$SMOKE_SCRIPT" ]; then
    chmod +x "$SMOKE_SCRIPT" || true
fi
SMOKE_RC=0
time_step "smoke" bash "$SMOKE_SCRIPT" "https://localhost" || SMOKE_RC=$?
if [ "$SMOKE_RC" -ne 0 ]; then
    fail "smoke had $SMOKE_RC failures"
else
    ok "smoke passed"
fi

# ======================================================================
# STEP 8 — timing summary
# ======================================================================
info "STEP 8/8 — timing summary"
if [ -f "/tmp/p9-dry-run-timing-${TS}.txt" ]; then
    printf "\n%s%-12s %s%s\n" "$C_BOLD" "STEP" "ELAPSED" "$C_RESET"
    cat "/tmp/p9-dry-run-timing-${TS}.txt"
fi

printf "\n"
if [ "$GATE_PASS" -eq 1 ] && [ "$SMOKE_RC" -eq 0 ]; then
    ok "DRY-RUN GATE: PASS — clear to schedule T+0"
    info "log: $LOG_FILE"
    exit 0
else
    fail "DRY-RUN GATE: FAIL — do NOT proceed to T+0 until failures resolved"
    info "log: $LOG_FILE"
    exit 1
fi
