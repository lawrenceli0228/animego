# go-api

The Go HTTP backend for AnimeGo, part of the `feat/go-backend` rewrite
(see [`docs/migration/MIGRATION_PLAN.md`](../docs/migration/MIGRATION_PLAN.md)).

**Status:** P0 — skeleton + `:8080/health` only. No DB access yet.

## Quick Start

```bash
# One-time, from repo root:
bash scripts/p0-bootstrap.sh         # go mod init + deps + smoke test

# Every dev session:
bash scripts/dev.sh                  # starts Postgres + Mongo + go-api with Air

# Measure Time-To-Hello-World:
bash scripts/measure-tthw.sh         # writes /tmp/animego-dev-up.txt marker
```

## Layout

```
go-api/
├── cmd/
│   ├── server/main.go         # chi HTTP entry (this PR)
│   ├── migrate/               # golang-migrate wrapper (P1)
│   ├── seed/                  # dev fixture loader (P0 magical moment)
│   └── migrate-mongo/         # Mongo → PG one-shot (P1, critical)
├── internal/
│   ├── config/                # env loader
│   ├── db/
│   │   ├── queries/*.sql      # sqlc input
│   │   └── gen/*.go           # sqlc output — DO NOT hand-edit
│   ├── middleware/
│   ├── routes/                # /api/anime, /api/auth, etc. (P2.x)
│   └── services/              # business logic (P2.x)
├── migrations/*.up.sql        # golang-migrate input (P1)
├── .air.toml                  # hot reload config
├── sqlc.yaml                  # SQL → Go codegen config
└── go.mod                     # populated by p0-bootstrap.sh
```

## Commands

| Goal | Command |
|------|---------|
| Bootstrap (once) | `bash scripts/p0-bootstrap.sh` |
| Dev server | `bash scripts/dev.sh` |
| Health check | `curl http://localhost:8080/health` |
| Regenerate sqlc | `cd go-api && sqlc generate` |
| Run migrations (P1+) | `cd go-api && go run ./cmd/migrate up` |
| Tests | `cd go-api && go test ./...` |
| Tests with race | `cd go-api && go test -race ./...` |

## Toolchain

| Tool | Version | Install |
|------|---------|---------|
| Go | 1.23+ | `brew install go` |
| sqlc | latest | `brew install sqlc` |
| golang-migrate | latest | `brew install golang-migrate` |
| Air | latest | `go install github.com/cosmtrek/air@latest` |
| rclone | latest | `brew install rclone` (for R2 backup) |
