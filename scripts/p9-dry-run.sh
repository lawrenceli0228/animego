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
#
# Schema note (P9 cutover blocker fix):
#   The Postgres volume is wiped+recreated in STEP 2, so it boots with NO
#   schema. Nothing in the codebase auto-applies migrations on server boot
#   (cmd/migrate is an empty stub; dev.sh's `go run ./cmd/migrate up` was
#   never wired). go-api's River queue (river_job/river_leader/river_queue)
#   crash-loops on an empty DB. So STEP 4 below applies the FULL schema with
#   golang-migrate BEFORE the go-api stack-up in STEP 8. River is NOT a
#   separate migrator — its tables are bundled into go-api/migrations/0007+
#   0008, so one `migrate ... up` creates app schema AND River schema.

set -euo pipefail

# --- repo root (script lives in scripts/) ------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- compose files -----------------------------------------------------
# Step 5 runs `go run migrate-mongo` on the HOST against localhost:27017 /
# localhost:5432. The base docker-compose.yml deliberately does NOT publish
# mongo/postgres ports (prod safety); docker-compose.ci.yml does. So a local
# dry-run MUST layer in the ci overlay or the migrate step can't connect.
# COMPOSE_FILE makes every `docker compose` call in this script use both.
# Absolute paths so it holds regardless of CWD (the script cd's around).
export COMPOSE_FILE="${COMPOSE_FILE:-$REPO_ROOT/docker-compose.yml:$REPO_ROOT/docker-compose.ci.yml}"

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
    local start end elapsed rc
    start="$(date +%s)"
    # Preserve the wrapped command's exit code. Without this, a failing
    # step (e.g. smoke returning 1) was masked because the function's
    # last command (printf) returned 0, so the caller's `|| RC=$?` never
    # fired and the gate falsely reported PASS.
    "$@" && rc=0 || rc=$?
    end="$(date +%s)"
    elapsed=$((end - start))
    ok "$label finished in ${elapsed}s"
    printf "%s\t%ds\n" "$label" "$elapsed" >> "/tmp/p9-dry-run-timing-${TS}.txt"
    return "$rc"
}

# ======================================================================
# STEP 1 — preflight
# ======================================================================
info "STEP 1/9 — preflight"

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

# golang-migrate is required for STEP 4 (apply Postgres schema). It is a
# host tool (installed via scripts/p0-bootstrap.sh — `brew install
# golang-migrate`), NOT bundled into the go-api runtime image. Fail fast
# here rather than 3 steps in.
if ! command -v migrate >/dev/null 2>&1; then
    fail "golang-migrate ('migrate') not on PATH — install it: brew install golang-migrate"
    exit 2
fi
ok "golang-migrate present: $(migrate -version 2>&1 | head -1)"

cd "$REPO_ROOT"

# ======================================================================
# STEP 2 — reset mongo + postgres
# ======================================================================
if [ "$SKIP_RESTORE" -eq 0 ]; then
    info "STEP 2/9 — reset mongodb + postgres volumes"
    confirm "docker compose down mongodb postgres + volume rm (DESTROYS local data)"

    run docker compose down mongodb postgres || warn "down had non-zero exit (probably not running yet, ok)"
    # Volume names follow the standard compose convention <project>_<volname>.
    # If the operator overrode COMPOSE_PROJECT_NAME the rm will say "no such
    # volume" — harmless; the next `up` will recreate clean volumes.
    run docker volume rm animego_mongo-data 2>/dev/null || warn "animego_mongo-data already gone"
    run docker volume rm animego_postgres-data 2>/dev/null || warn "animego_postgres-data already gone"
    ok "volumes wiped"
else
    info "STEP 2/9 — skipped (--skip-restore)"
fi

# ======================================================================
# STEP 3 — bring up mongo + postgres, wait healthy
# ======================================================================
info "STEP 3/9 — start mongodb + postgres"
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
# STEP 4 — apply Postgres schema (app migrations + River)  [P9 fix]
# ======================================================================
# CRITICAL for cutover: STEP 2 wiped the postgres volume, so it has NO
# schema. The go-api server does NOT migrate on boot — its River queue
# (river_job/river_leader/river_queue) crash-loops against an empty DB
# ("relation \"river_queue\" does not exist"). We must apply the schema
# here, BEFORE the go-api stack-up in STEP 8, or step 8's smoke fails.
#
# River is NOT a separate migrator: river v0.37 internal migrations are
# baked into go-api/migrations/0007_river_initial + 0008_river_pending_use,
# so a SINGLE golang-migrate `up` creates BOTH the app tables (anime_cache,
# users, subscriptions, danmakus, episode_windows, ...) AND the River
# tables. Order within that one command is fixed by file numbering 0001..N.
#
# DATA NOTE: this dry-run keeps STEP 6 as migrate-mongo --dry-run (gate
# semantics unchanged — it counts/validates but does NOT write PG). So
# go-api in STEP 8 boots against schema-only, EMPTY tables. That is fine:
# the smoke checks go-api /health (DB connectivity + River boot), which
# only needs the schema to exist, not rows. To also exercise a real data
# endpoint here you would flip STEP 6 to --commit — deliberately NOT done,
# to preserve the T-3d "no writes" gate.
info "STEP 4/9 — apply Postgres schema (golang-migrate: app + River)"

# pg is published on 127.0.0.1:5432 by the ci overlay (see COMPOSE_FILE
# header). Pin 127.0.0.1, NOT localhost: localhost resolves to ::1 first, and
# golang-migrate fails fast when the freshly-booted postgres resets that IPv6
# connection during its pg_cron first-init restart. Mirror STEP 6's wiring.
# golang-migrate is idempotent: re-running with --skip-restore on an
# already-migrated DB is a no-op.
PG_URI_LOCAL="postgres://animego:${PG_PASS}@127.0.0.1:5432/animego?sslmode=disable"
MIGRATE_SCHEMA_CMD=(migrate -path "$REPO_ROOT/go-api/migrations" -database "$PG_URI_LOCAL" up)
# Mask POSTGRES_PASSWORD in the echoed command (see STEP 6 for rationale).
MIGRATE_SCHEMA_DISPLAY="${MIGRATE_SCHEMA_CMD[*]}"
info "\$ ${MIGRATE_SCHEMA_DISPLAY//$PG_PASS/***}"
# `migrate ... up` prints "no change" + exits 0 when already at head, so
# this is safe under --skip-restore. Any real failure (bad SQL, dirty
# state) is fatal — the cutover must not proceed on a half-applied schema.
# Retry the schema migrate: postgres can report container-healthy (STEP 3)
# while the host-published :5432 still resets connections during first-boot
# init (pg_cron shared_preload restart). This IS the exact host->:5432 path
# STEP 6's migrate-mongo uses, so a green here also proves STEP 6 can connect.
schema_ok=0
for attempt in $(seq 1 15); do
    if time_step "schema" "${MIGRATE_SCHEMA_CMD[@]}"; then
        schema_ok=1
        break
    fi
    warn "schema migrate attempt ${attempt}/15 failed (postgres host-TCP not ready yet) — retrying in 2s"
    sleep 2
done
[ "$schema_ok" -eq 1 ] || { fail "Postgres schema migrate failed after 15 attempts (~30s)"; exit 1; }
ok "Postgres schema applied (app tables + River queue tables)"

# ======================================================================
# STEP 5 — mongorestore from dump
# ======================================================================
if [ "$SKIP_RESTORE" -eq 0 ]; then
    info "STEP 5/9 — mongorestore from $DUMP_SOURCE"
    confirm "stream $DUMP_SOURCE into docker compose exec mongodb mongorestore (will overwrite collections)"

    time_step "restore" bash -c "docker compose exec -T mongodb mongorestore --gzip --archive --drop < '$DUMP_SOURCE'"
    ok "mongorestore done"
else
    info "STEP 5/9 — skipped (--skip-restore)"
fi

# ======================================================================
# STEP 6 — migrate-mongo --dry-run
# ======================================================================
info "STEP 6/9 — migrate-mongo dry-run"

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
        --mongo-uri="mongodb://127.0.0.1:27017/animego"
        --pg-uri="postgres://animego:${PG_PASS}@127.0.0.1:5432/animego?sslmode=disable"
        --dry-run
        --log-failed="$MIGRATE_FAILURES"
)
# Mask POSTGRES_PASSWORD in the echoed command so it never lands in the
# tee'd log or CI output. The migrator's own structured log already masks
# it (pg_uri shows ***); only this command-echo leaked the cleartext.
MIGRATE_DISPLAY="${MIGRATE_CMD[*]}"
info "\$ ${MIGRATE_DISPLAY//$PG_PASS/***}"
time_step "migrate" "${MIGRATE_CMD[@]}"
cd "$REPO_ROOT"

# ======================================================================
# STEP 7 — inspect failures.jsonl
# ======================================================================
info "STEP 7/9 — inspect failures.jsonl"
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
# STEP 8 — full Go stack + smoke
# ======================================================================
info "STEP 8/9 — bring up Go stack + smoke"
run docker compose --env-file=.env.production up -d postgres go-api ws-server next-app nginx

info "waiting 20s for stack to settle..."
sleep 20

# go-api health gate (validates the STEP 4 schema fix): before the schema
# was applied, go-api crash-looped on River's missing tables. We poll its
# compose healthcheck (Up ... (healthy)) and hit /health directly. The ci
# overlay does NOT publish go-api's port, so probe via `compose exec`.
# Failure here means the schema/River boot is broken — fail the gate.
GO_API_RC=0
GO_API_HEALTHY=0
for i in $(seq 1 30); do
    GA_STATE="$(docker compose ps --format '{{.Service}}={{.Status}}' 2>/dev/null | grep '^go-api=' || true)"
    if echo "$GA_STATE" | grep -qi "healthy"; then
        GO_API_HEALTHY=1
        break
    fi
    sleep 2
done
if [ "$GO_API_HEALTHY" -eq 1 ] && \
   docker compose exec -T go-api wget -qO- http://localhost:8080/health 2>/dev/null | grep -q '"db":"up"'; then
    ok "go-api healthy + /health reports db:up (River boot OK on migrated schema)"
else
    fail "go-api did NOT come healthy — schema/River boot likely broken"
    info "go-api state: ${GA_STATE:-<none>}"
    docker compose logs go-api --tail 20 2>&1 | grep -iE "river|relation|error" || true
    GO_API_RC=1
fi

# nginx restart (NOT reload): STEP 8's `up -d` recreated go-api/next-app/
# ws-server/app with NEW container IPs, but left nginx Running on its OLD
# cached upstream IPs, so every proxied route 503s. nginx only re-resolves
# its upstreams on a full restart (reload keeps the stale resolver cache).
# This is the exact prod-cutover gotcha: after any force-recreate, restart
# nginx before trusting a smoke result.
run docker compose restart nginx
sleep 2

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
# STEP 9 — timing summary
# ======================================================================
info "STEP 9/9 — timing summary"
if [ -f "/tmp/p9-dry-run-timing-${TS}.txt" ]; then
    printf "\n%s%-12s %s%s\n" "$C_BOLD" "STEP" "ELAPSED" "$C_RESET"
    cat "/tmp/p9-dry-run-timing-${TS}.txt"
fi

printf "\n"
if [ "$GATE_PASS" -eq 1 ] && [ "$SMOKE_RC" -eq 0 ] && [ "$GO_API_RC" -eq 0 ]; then
    ok "DRY-RUN GATE: PASS — clear to schedule T+0"
    info "log: $LOG_FILE"
    exit 0
else
    fail "DRY-RUN GATE: FAIL — do NOT proceed to T+0 until failures resolved"
    info "log: $LOG_FILE"
    exit 1
fi
