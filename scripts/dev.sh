#!/usr/bin/env bash
# scripts/dev.sh — local dev loop.
#
# Stage progression:
#   P0:   postgres + mongo + go-api
#   P2.8: + ws-server (Node + socket.io on :3001)
#   P3:   + next-app (Bun + Next.js 16 on :3000)   ← current
#
# Magic moment: http://localhost:3000 serves a Next page that pulls data
# from go-api via /api/* rewrite, within < 5 min cold start.
# TTHW marker (eng review C2): /tmp/animego-dev-up.txt is written when ready;
# measure with scripts/measure-tthw.sh.

set -euo pipefail
cd "$(dirname "$0")/.."

# `go install` puts binaries in $GOPATH/bin (default $HOME/go/bin).  Ensure
# that directory is on PATH so air / sqlc-built tools are found regardless
# of whether the user has it in their shell profile yet.
export PATH="${PATH}:${GOPATH:-$HOME/go}/bin"

# ─── Prerequisites ────────────────────────────────────────────────
need() {
    command -v "$1" >/dev/null 2>&1 || {
        echo "ERROR: '$1' not installed. $2" >&2
        exit 1
    }
}
need docker "Install Docker Desktop: https://docs.docker.com/get-docker/"
need go     "Install Go 1.23+: brew install go"
need air    "Install Air: go install github.com/cosmtrek/air@latest (after Go is on PATH)"
need node   "Install Node 20+: brew install node  (ws-server runtime)"
need bun    "Install Bun: curl -fsSL https://bun.sh/install | bash  (next-app runtime)"

# ─── .env check ───────────────────────────────────────────────────
[ -f .env ] || {
    echo "ERROR: .env missing.  Run:  cp .env.example .env  and fill values." >&2
    exit 1
}

# ─── PID tracking + shutdown trap ─────────────────────────────────
GO_PID=""
WS_PID=""
NEXT_PID=""

cleanup() {
    echo ""
    echo "[dev] stopping services..."
    [ -n "$NEXT_PID" ] && kill "$NEXT_PID" 2>/dev/null || true
    [ -n "$WS_PID" ]   && kill "$WS_PID"   2>/dev/null || true
    [ -n "$GO_PID" ]   && kill "$GO_PID"   2>/dev/null || true
    # Give children a moment to exit cleanly before we return
    sleep 1
    exit 0
}
trap cleanup INT TERM

# ─── DB containers ────────────────────────────────────────────────
echo "[dev] starting Postgres + Mongo..."
docker compose -f docker-compose.dev.yml up -d postgres mongo

# Wait for Postgres healthy (capped 60s — eng review C1)
echo "[dev] waiting for Postgres..."
for i in $(seq 1 60); do
    if docker compose -f docker-compose.dev.yml exec -T postgres pg_isready -U animego >/dev/null 2>&1; then
        echo "  ✓ Postgres ready"
        break
    fi
    sleep 1
    if [ "$i" -eq 60 ]; then
        echo "ERROR: Postgres did not become ready in 60s." >&2
        echo "       Check: docker compose -f docker-compose.dev.yml logs postgres" >&2
        exit 1
    fi
done

# ─── Migrations stub (P1 will fill this in) ──────────────────────
# When P1 lands the migrate command, uncomment:
# ( cd go-api && go run ./cmd/migrate up )

# ─── go-api (Air hot reload, :8080) ──────────────────────────────
echo "[dev] starting go-api (Air hot reload)..."
( cd go-api && air -c .air.toml 2>&1 | sed 's/^/[go-api] /' ) &
GO_PID=$!

echo "[dev] waiting for :8080/health..."
for i in $(seq 1 60); do
    if curl -sf http://localhost:8080/health >/dev/null 2>&1; then
        echo "  ✓ :8080/health"
        break
    fi
    sleep 1
    if [ "$i" -eq 60 ]; then
        echo "ERROR: go-api did not respond on :8080/health in 60s." >&2
        echo "       Check [go-api] log above for build errors." >&2
        cleanup
    fi
done

# ─── ws-server (Node + socket.io, :3001) ─────────────────────────
# ws-server is plain Node + commonjs; we run via node directly to avoid
# nodemon's restart noise and to keep the dependency surface minimal.
if [ -d ws-server/node_modules ]; then
    echo "[dev] starting ws-server..."
else
    echo "[dev] ws-server/node_modules missing — running 'npm install' there first..."
    ( cd ws-server && npm install --silent )
    echo "[dev] starting ws-server..."
fi
( cd ws-server && node src/index.js 2>&1 | sed 's/^/[ws-server] /' ) &
WS_PID=$!

echo "[dev] waiting for :3001/healthz..."
for i in $(seq 1 30); do
    if curl -sf http://localhost:3001/healthz >/dev/null 2>&1; then
        echo "  ✓ :3001/healthz"
        break
    fi
    sleep 1
    if [ "$i" -eq 30 ]; then
        echo "ERROR: ws-server did not respond on :3001/healthz in 30s." >&2
        echo "       Check [ws-server] log above." >&2
        cleanup
    fi
done

# ─── next-app (Bun + Next.js 16 + Turbopack, :3000) ──────────────
# Turbopack first compile is ~3-10s, allow 90s wall-clock for cold start
# including dependency resolution and on-demand RSC compilation.
if [ -d next-app/node_modules ]; then
    echo "[dev] starting next-app..."
else
    echo "[dev] next-app/node_modules missing — running 'bun install' there first..."
    ( cd next-app && bun install --silent )
    echo "[dev] starting next-app..."
fi
( cd next-app && bun --bun next dev 2>&1 | sed 's/^/[next-app]  /' ) &
NEXT_PID=$!

echo "[dev] waiting for :3000/api/healthz..."
for i in $(seq 1 90); do
    if curl -sf http://localhost:3000/api/healthz >/dev/null 2>&1; then
        echo "  ✓ :3000/api/healthz"
        break
    fi
    sleep 1
    if [ "$i" -eq 90 ]; then
        echo "ERROR: next-app did not respond on :3000/api/healthz in 90s." >&2
        echo "       Check [next-app] log above (Turbopack first compile can be slow)." >&2
        cleanup
    fi
done

# ─── TTHW marker (eng review C2) ─────────────────────────────────
date -u +%s > /tmp/animego-dev-up.txt

cat <<'EOF'

══════════════════════════════════════════════════════════════
  Magic at:    http://localhost:3000
  Stage:       P3 (next-app + ws-server + go-api + Postgres)

  Ports:
    :3000  next-app   (Next.js 16 + Bun + Turbopack)
    :3001  ws-server  (Node + socket.io)
    :8080  go-api     (Go + chi + pgx)
    :5432  postgres   (docker)
    :27017 mongo      (docker, legacy)

  TTHW marker: /tmp/animego-dev-up.txt

  Ctrl+C: stop all three services (DB containers left running)
  Stop DBs: docker compose -f docker-compose.dev.yml down
══════════════════════════════════════════════════════════════

EOF

# Portable child-death detector (bash 3.2 on macOS lacks `wait -n`).
# Poll every 5s; if any tracked PID has exited, surface it and clean up.
while true; do
    for pid_name in GO_PID WS_PID NEXT_PID; do
        pid_val=$(eval echo \$$pid_name)
        if [ -n "$pid_val" ] && ! kill -0 "$pid_val" 2>/dev/null; then
            echo "[dev] $pid_name ($pid_val) exited; shutting down the rest..."
            cleanup
        fi
    done
    sleep 5
done
