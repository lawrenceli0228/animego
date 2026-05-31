#!/usr/bin/env bash
# scripts/p0-bootstrap.sh — initialize Go module + dependencies for go-api/.
#
# Run AFTER you have installed:
#   brew install go sqlc rclone golang-migrate
#   go install github.com/cosmtrek/air@latest
#
# Idempotent: safe to re-run.  Skips `go mod init` if go.mod exists; `go get`
# is naturally idempotent.

set -euo pipefail
cd "$(dirname "$0")/.."

# Ensure $GOPATH/bin on PATH (air lives here after `go install`).
export PATH="${PATH}:${GOPATH:-$HOME/go}/bin"

MODULE="github.com/lawrenceli0228/animego/go-api"

echo "[1/5] Verifying toolchain..."
for tool in go sqlc rclone migrate air; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "ERROR: '$tool' not on PATH." >&2
        echo "       See docs/migration/P0-PROGRESS.md § 0 (Local toolchain)." >&2
        exit 1
    fi
done
echo "  ✓ go $(go version | awk '{print $3}')"
echo "  ✓ sqlc $(sqlc version)"
echo "  ✓ rclone $(rclone version | head -1 | awk '{print $2}')"
echo "  ✓ migrate $(migrate -version 2>&1 | head -1)"
echo "  ✓ air"

echo ""
echo "[2/5] Initializing Go module at $MODULE..."
cd go-api
if [ -f go.mod ]; then
    echo "  · go.mod already exists, skipping init"
else
    go mod init "$MODULE"
    echo "  ✓ go mod init"
fi

echo ""
echo "[3/5] Installing dependencies..."
go get github.com/go-chi/chi/v5
go get github.com/go-chi/chi/v5/middleware
go get github.com/jackc/pgx/v5
go get github.com/jackc/pgx/v5/pgxpool
go get github.com/golang-jwt/jwt/v5
go get github.com/riverqueue/river
go get github.com/riverqueue/river/riverdriver/riverpgxv5
go get github.com/google/uuid                       # sqlc.yaml overrides map PG uuid → google/uuid
echo "  ✓ deps installed"

echo ""
echo "[4/5] Tidying go.mod..."
go mod tidy
echo "  ✓ go mod tidy"

echo ""
echo "[5/5] Running smoke test..."
go test ./... 2>&1 | tail -5
echo "  ✓ go test (empty suites pass)"

cat <<EOF

══════════════════════════════════════════════════
  Bootstrap complete.

  Next steps (manual):
    1. cp .env.example .env  and edit JWT_SECRET + POSTGRES_PASSWORD
    2. docker compose -f docker-compose.dev.yml up -d postgres mongo
    3. bash scripts/dev.sh  →  curl http://localhost:8080/health
    4. bash scripts/measure-tthw.sh  →  TTHW report
    5. Configure rclone: rclone config new (provider Cloudflare R2)
    6. bash scripts/backup-pg.sh --env=dev  →  verify R2 upload
    7. bash scripts/restore-pg-drill.sh  →  P0 → P1 critical gate
══════════════════════════════════════════════════

EOF
