#!/usr/bin/env bash
# scripts/dev.sh — local dev loop.
#
# Stage progression:
#   P0 (this version): postgres + mongo + go-api with Air hot reload
#   P2.8: + ws-server (Bun + socket.io)
#   P3:   + next-app (Next.js 16 + Bun)
#
# Magic moment: :8080/health returns 200 within < 5 min cold start.
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

# ─── .env check ───────────────────────────────────────────────────
[ -f .env ] || {
    echo "ERROR: .env missing.  Run:  cp .env.example .env  and fill values." >&2
    exit 1
}

# ─── DB containers ────────────────────────────────────────────────
echo "[dev] starting Postgres + Mongo..."
docker compose -f docker-compose.dev.yml up -d postgres mongo

# Wait for Postgres healthy (capped 60s — eng review C1 lightweight fix)
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

# ─── Start go-api with Air hot reload ────────────────────────────
echo "[dev] starting go-api (Air hot reload)..."
( cd go-api && air -c .air.toml 2>&1 | sed 's/^/[go-api] /' ) &
GO_PID=$!

# Clean shutdown on Ctrl+C (eng review C3 lightweight fix)
trap 'echo "[dev] stopping go-api..."; kill $GO_PID 2>/dev/null || true; exit 0' INT TERM

# ─── Health check (capped 60s — eng review C1) ───────────────────
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
        kill $GO_PID 2>/dev/null || true
        exit 1
    fi
done

# ─── TTHW marker (eng review C2) ─────────────────────────────────
date -u +%s > /tmp/animego-dev-up.txt

cat <<EOF

══════════════════════════════════════════════════════════════
  Magic at:    http://localhost:8080/health
  Stage:       P0 (Go + Postgres only — ws-server and next-app come later)
  TTHW marker: /tmp/animego-dev-up.txt

  Ctrl+C:  stop go-api
  Stop DBs:  docker compose -f docker-compose.dev.yml down
══════════════════════════════════════════════════════════════

EOF

wait $GO_PID
