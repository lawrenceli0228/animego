# go-api

The Go HTTP backend for AnimeGo, part of the `feat/go-backend` rewrite
(see [`../docs/migration/MIGRATION_PLAN.md`](../docs/migration/MIGRATION_PLAN.md)).

**Status:** P1 complete — schema migrated end-to-end, prod data verified
100% field parity, pg_cron danmaku TTL in place. P2 (HTTP endpoints) next.

## Quick Start

```bash
# One-time, from repo root:
bash scripts/p0-bootstrap.sh             # go mod init + deps + smoke test

# Every dev session:
bash scripts/dev.sh                      # starts Postgres + Mongo + go-api with Air
curl http://localhost:8080/health        # → {"ok":true,...}

# Apply migrations to dev DB:
set -a; source .env; set +a
migrate -path go-api/migrations -database "$DATABASE_URL" up

# Migrate Mongo → Postgres (one-shot, used during P9 cutover):
( cd go-api && go run ./cmd/migrate-mongo --dry-run --pg-uri="$DATABASE_URL" )
( cd go-api && go run ./cmd/migrate-mongo --commit  --pg-uri="$DATABASE_URL" )

# Verify migration parity (10 fields × N random samples):
( cd go-api && go run ./cmd/parity-check --sample=1000 --pg-uri="$DATABASE_URL" )

# Re-run migration on same dump (must wipe child tables first):
bash scripts/migrate-mongo-truncate-and-retry.sh
```

## Layout

```
go-api/
├── cmd/
│   ├── server/                 # chi HTTP entry — :8080/health  (P0)
│   ├── migrate-mongo/          # Mongo → Postgres one-shot      (P1)
│   ├── parity-check/           # 10×N field parity diff         (P1.E)
│   ├── migrate/.gitkeep        # golang-migrate wrapper         (future)
│   └── seed/.gitkeep           # dev fixture loader             (future)
├── internal/
│   ├── config/                 # env loader (PORT_GO, DATABASE_URL, …)
│   ├── migrate/                # migration orchestration package
│   │   ├── orchestrator.go     #   topo-sort + batch UPSERT + JSONL fail log
│   │   ├── transform.go        #   Transform interface + registry
│   │   ├── mongo_conn.go       #   mongo-driver/v2 client helper
│   │   ├── pg_conn.go          #   pgx/v5 pool helper
│   │   └── transforms/         #   per-collection mappers (P1.C)
│   │       ├── util.go         #     MongoIDToUUID (deterministic v5)
│   │       ├── users.go        #     5 simple + 1 complex transform each
│   │       ├── anime_cache.go  #     fan-out to 7 child tables
│   │       └── *_test.go       #     testify, 91.2% coverage
│   ├── db/queries/, db/gen/    # sqlc input/output (P2)
│   ├── middleware/, routes/, services/  # (P2)
├── migrations/                 # golang-migrate input
│   ├── 0001_init.up.sql            # 14 tables, FK CASCADE
│   ├── 0002_indexes.up.sql         # 19 secondary indexes
│   ├── 0003_defer_comment_self_fk  # episode_comments.parent_id DEFERRED
│   ├── 0004_relax_bangumi_version  # CHECK 0-2 → ≥0 (prod has 3)
│   ├── 0005_pg_cron_extension      # CREATE EXTENSION pg_cron
│   └── 0006_danmaku_ttl_schedule   # 04:00 UTC daily TTL job
├── docker/postgres/Dockerfile  # postgres:16-alpine + pg_cron 1.6.5
├── test/integration/           # testcontainers-go (build tag: integration)
├── .air.toml                   # hot reload config
├── sqlc.yaml                   # SQL → Go codegen config
└── go.mod
```

## Schema overview

See [`../docs/migration/ERD.md`](../docs/migration/ERD.md) for the full
ASCII ERD.  TL;DR:

- 14 tables, 2 roots (`users`, `anime_cache`)
- Every FK is `ON DELETE CASCADE` (admin-delete propagation; UI shows
  count-confirm before action — plan 二轮 review 1C)
- `anime_cache.search_vec` is a `tsvector GENERATED ALWAYS AS` column
  built from 4 title columns, GIN-indexed
- `pg_trgm` indexes on 4 title columns (dandanplay AnimeCache regex
  replacement)
- `pg_cron` `danmaku-ttl` job scheduled `0 4 * * *`
- `episode_comments.parent_id` self-FK is `DEFERRABLE INITIALLY DEFERRED`
  so batched inserts work regardless of parent/child order within a tx

## Test commands

| Goal | Command |
|------|---------|
| Unit tests | `go test -race ./internal/migrate/transforms/...` |
| Coverage report | `go test -race -cover ./internal/migrate/transforms/...` |
| Integration (testcontainers) | `go test -race -tags=integration -timeout=300s ./test/integration/...` |
| Migrate-mongo dry-run | `go run ./cmd/migrate-mongo --dry-run --pg-uri="$DATABASE_URL"` |
| Migrate-mongo commit | `go run ./cmd/migrate-mongo --commit  --pg-uri="$DATABASE_URL"` |
| Parity check | `go run ./cmd/parity-check  --sample=1000 --pg-uri="$DATABASE_URL"` |
| Truncate + retry | `bash scripts/migrate-mongo-truncate-and-retry.sh` |
| Regenerate sqlc (P2+) | `cd go-api && sqlc generate` |

## Toolchain

| Tool | Version | Install |
|------|---------|---------|
| Go | 1.23+ (tested on 1.26) | `brew install go` |
| sqlc | 1.31+ | `brew install sqlc` |
| golang-migrate | v4 | `brew install golang-migrate` |
| Air | v1.65 | `go install github.com/air-verse/air@latest` ¹ |
| rclone | 1.74+ | `brew install rclone` (for R2 backup) |
| jq | any | `brew install jq` (for restore-pg-drill) |
| flock | any | `brew install flock` (for backup-pg lock) |
| Docker Compose | v2 | bundled with Docker Desktop |

¹ `github.com/cosmtrek/air` was the historical path; the project has moved to
`github.com/air-verse/air`.  Either works (the old path redirects), but
fresh installs should use air-verse.

## Migration gotchas (carried lessons from P1)

These are the non-obvious traps surfaced during P1.C-P1.F.  Future
transform work should respect them or surface them in code review.

### Mongoose collection naming
Mongoose pluralizes model class names lowercased without underscores —
`AnimeCache` → `animecaches`, `EpisodeComment` → `episodecomments`,
`EpisodeWindow` → `episodewindows`.  `MongoCollection()` on any transform
MUST return the Mongoose-pluralized name, NOT the snake_case PG table
name.  The unit tests assert this explicitly.

### mongo-driver/v2 embedded-doc decoding
When `cursor.Decode(&doc)` lands a Mongo document into a Go `bson.M`,
ONLY the outer document is `bson.M`.  Nested subdocuments and array
elements come back as `bson.D` (ordered slice of key/value pairs).  Any
`case bson.M:` switch that doesn't ALSO `case bson.D:` will silently miss
those values.  Use `transforms.GetSubdoc()` (util.go) or `toSubdoc()`
inside `anime_cache.go` — both handle all three: `bson.M`, `bson.D`,
`map[string]any`.

### GOOS filename suffix trap
Go's build constraint system treats filenames ending in `_<goos>.go` as
implicit OS-specific.  A file called `episode_windows.go` is silently
EXCLUDED on every non-Windows host.  Renamed to
`episode_windows_transform.go` (the trailing `_transform` is not a GOOS).
`zzz_registered_test.go` is a regression guard that fails loudly if any
of the 7 expected transforms drops out of the registry.

### ConflictTarget per-Transform vs per-Table
The `Transform.ConflictTarget()` method returns one string per
transform, but `TransformRow` may emit rows into multiple tables (e.g.,
`anime_cache` fans out to 8 tables).  The orchestrator now applies the
ConflictTarget ONLY when writing to the transform's `PGTable()`; rows
destined for child tables use plain INSERT (no `ON CONFLICT` clause).
Consequence: re-running the migration raises PK conflicts on child
tables.  Use `scripts/migrate-mongo-truncate-and-retry.sh` for re-runs.

### FK ordering during fan-out batching
When a child-table buffer fills before the parent-table buffer, the
orchestrator now flushes the parent first to avoid `SQLSTATE 23503`
(FK violation).  This is in `orchestrator.go`'s `flush` closure and the
final-flush block.  Don't undo it unless you also defer all FK
constraints on every child table.

### bangumi_version not 0-2
The original Mongoose schema documented `0=unenriched / 1=phase 1-3 /
2=phase 4 full`, but production traffic has filled the field with `3`
for the bulk of rows (a phase-5 enrichment that was never documented in
v1 of the plan).  The CHECK constraint in 0001 was `BETWEEN 0 AND 2`,
which would block 99.95% of the prod migration.  0004 relaxes to `≥ 0`.

### episodeTitles dedup
~17 anime in production have duplicate `episodeTitles` entries for the
same `episode` number (the Bangumi enrichment pipeline appended new
versions instead of replacing).  The PG composite PK `(anime_id,
episode)` rejects these.  The transform now dedups in-memory, **keeping
the LAST occurrence** so the most recent enrichment wins.
