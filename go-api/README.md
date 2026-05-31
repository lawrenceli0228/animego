# go-api

The Go HTTP backend for AnimeGo, part of the `feat/go-backend` rewrite
(see [`../docs/migration/MIGRATION_PLAN.md`](../docs/migration/MIGRATION_PLAN.md)).

**Status:** P2.0 complete — chi HTTP skeleton ships envelope-aware
middleware stack against pgxpool. `/health` does live DB ping. P1
(Mongo→PG migrate) and P0 (Go scaffold + R2 backup) before that.
P2.1 (`/api/anime/*` + enrichment queue) up next — see
[`../docs/migration/P2-PROGRESS.md`](../docs/migration/P2-PROGRESS.md).

## Quick Start

```bash
# One-time, from repo root:
bash scripts/p0-bootstrap.sh             # go mod init + deps + smoke test

# Every dev session:
bash scripts/dev.sh                      # starts Postgres + Mongo + go-api with Air
curl http://localhost:8080/health        # → {"data":{"ok":true,"service":"go-api","stage":"P2.0","db":"up"}}

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
│   ├── config/                 # env loader (PORT_GO, DATABASE_URL, CLIENT_ORIGIN, …)
│   ├── db/
│   │   ├── pool.go             # web-tier pgxpool, MaxConns=20  (P2.0.A)
│   │   ├── pool_test.go        #   bad URL / unreachable host  (P2.0.A)
│   │   ├── queries/            # sqlc input (P2.1 first query lands here)
│   │   └── gen/                # sqlc output (P2.1 first generate)
│   ├── httpx/                  # envelope + APIError + 14 codes  (P2.0.C)
│   │   ├── codes.go            #   const list grep'd from Express
│   │   ├── error.go            #   APIError + WithCause Option
│   │   ├── envelope.go         #   Data + Page[T] + Fail (no HTML-escape, no trailing \n)
│   │   ├── error_test.go       #   16+ case
│   │   ├── envelope_test.go    #   15 case incl. 14 codes round-trip
│   │   └── express_fixture_test.go #   6 byte-exact case
│   ├── httpmw/                 # middleware (P2.0.D) — name avoids chi/v5/middleware collision
│   │   ├── logger.go           #   RequestLog, /health verbatim skip
│   │   ├── cors.go             #   go-chi/cors wrapper, AllowCredentials=true
│   │   ├── recoverer.go        #   envelope-aware, honours http.ErrAbortHandler
│   │   └── *_test.go           #   14+ case
│   ├── migrate/                # migration orchestration package
│   │   ├── orchestrator.go     #   topo-sort + batch UPSERT + JSONL fail log
│   │   ├── transform.go        #   Transform interface + registry
│   │   ├── mongo_conn.go       #   mongo-driver/v2 client helper
│   │   ├── pg_conn.go          #   batch-tier pgxpool (MaxConns=10)
│   │   └── transforms/         #   per-collection mappers (P1.C)
│   │       ├── util.go         #     MongoIDToUUID (deterministic v5)
│   │       ├── users.go        #     5 simple + 1 complex transform each
│   │       ├── anime_cache.go  #     fan-out to 7 child tables
│   │       └── *_test.go       #     testify, 91.2% coverage
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
| All unit tests | `go test -race ./...` |
| httpx coverage (97.9% target) | `go test -race -cover ./internal/httpx/...` |
| httpmw coverage (97.4% target) | `go test -race -cover ./internal/httpmw/...` |
| Transforms coverage (91.2% target) | `go test -race -cover ./internal/migrate/transforms/...` |
| Integration (testcontainers, 11 case) | `go test -race -tags=integration -timeout=300s ./test/integration/...` |
| Live curl smoke | `curl -i http://localhost:8080/health` |
| Migrate-mongo dry-run | `go run ./cmd/migrate-mongo --dry-run --pg-uri="$DATABASE_URL"` |
| Migrate-mongo commit | `go run ./cmd/migrate-mongo --commit  --pg-uri="$DATABASE_URL"` |
| Parity check | `go run ./cmd/parity-check  --sample=1000 --pg-uri="$DATABASE_URL"` |
| Truncate + retry | `bash scripts/migrate-mongo-truncate-and-retry.sh` |
| Regenerate sqlc (P2.1+) | `cd go-api && sqlc generate` |

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

## P2.0 chi skeleton — quick reference

### Envelope (`internal/httpx`)

Every handler emits one of three shapes that match Express byte-for-byte
(see [`../docs/migration/P2.0-DESIGN.md`](../docs/migration/P2.0-DESIGN.md) § 1):

```go
import "github.com/lawrenceli0228/animego/go-api/internal/httpx"

// Single resource — {"data":{...}}
httpx.Data(w, http.StatusOK, anime)

// Paginated list — {"data":[...], "total":N, "page":P, "hasMore":B, "nextPage":N|null}
httpx.Page(w, http.StatusOK, items, httpx.Pagination{
    Total: 100, Page: 1, HasMore: true, NextPage: intPtr(2),
})

// Error — {"error":{"code":"NOT_FOUND","message":"用户不存在"}}
httpx.Fail(w, httpx.NewError(http.StatusNotFound, httpx.CodeNotFound, "用户不存在"))

// Attach cause for slog without leaking to client:
httpx.Fail(w, httpx.NewError(503, httpx.CodeServerError, "database unreachable",
    httpx.WithCause(pingErr)))

// Or wrap an existing error:
httpx.Fail(w, httpx.WrapError(err, 500, httpx.CodeServerError, "query failed"))
```

`Page` is generic — `Page[T any](..., items []T, ...)` catches non-slice
values at compile time.  Nil slices coerce to `[]T{}` so empty pages emit
`"data":[]` not `"data":null`.

### 14 error codes

| Code constant | Code string | Typical HTTP |
|---|---|---|
| `CodeBadRequest` | `BAD_REQUEST` | 400 |
| `CodeValidationError` | `VALIDATION_ERROR` | 400 |
| `CodeInvalidAction` | `INVALID_ACTION` | 400 |
| `CodeInvalidCredentials` | `INVALID_CREDENTIALS` | 401 |
| `CodeNoToken` | `NO_TOKEN` | 401 |
| `CodeInvalidToken` | `INVALID_TOKEN` | 401 |
| `CodeTokenExpired` | `TOKEN_EXPIRED` | 401 |
| `CodeUnauthorized` | `UNAUTHORIZED` | 401 |
| `CodeForbidden` | `FORBIDDEN` | 403 |
| `CodeNotFound` | `NOT_FOUND` | 404 |
| `CodeConflict` | `CONFLICT` | 409 |
| `CodeDuplicate` | `DUPLICATE_ERROR` | 409 |
| `CodeTooManyRequests` | `TOO_MANY_REQUESTS` | 429 |
| `CodeServerError` | `SERVER_ERROR` | 500 |

P2.x handlers **must not** invent new codes — update `internal/httpx/codes.go`
+ design doc first if a new code is genuinely needed.

### Middleware chain (locked by `/plan-eng-review`)

```
CORS  →  RequestID  →  RealIP  →  RequestLog  →  Recoverer  →  Timeout
```

Order rationale:

- **CORS outermost** — OPTIONS preflight returns immediately, doesn't waste cycles on the inner chain.
- **RequestID before RequestLog** — log records carry a stable id.
- **Recoverer after RequestLog** — panic still produces a log line with the wrapped 500 status.
- **Timeout innermost** — only bounds business handlers; preflight + panic recovery don't get a 60s ceiling.

`/health` is verbatim-skipped inside `RequestLog` (docker probe = 2880 log lines/day/pod otherwise).

### Adding a new endpoint

```go
import (
    "github.com/lawrenceli0228/animego/go-api/internal/httpx"
)

func GetAnime(pool *pgxpool.Pool) http.HandlerFunc {
    return func(w http.ResponseWriter, req *http.Request) {
        // 1. Always start with a query-level timeout (P2.0 → P2.1 handoff).
        ctx, cancel := context.WithTimeout(req.Context(), 5*time.Second)
        defer cancel()

        // 2. Resolve params, validate.
        anilistID, err := strconv.Atoi(chi.URLParam(req, "anilistId"))
        if err != nil {
            httpx.Fail(w, httpx.NewError(400, httpx.CodeValidationError, "invalid anilist id"))
            return
        }

        // 3. Hit the DB (sqlc-generated method in P2.1+).
        row, err := dbgen.New(pool).GetAnime(ctx, int32(anilistID))
        if err != nil {
            if errors.Is(err, pgx.ErrNoRows) {
                httpx.Fail(w, httpx.NewError(404, httpx.CodeNotFound, "番剧不存在"))
                return
            }
            httpx.Fail(w, httpx.WrapError(err, 500, httpx.CodeServerError, "query failed"))
            return
        }

        // 4. Emit envelope.
        httpx.Data(w, http.StatusOK, row)
    }
}
```

### Package naming convention

| Avoid | Use | Why |
|---|---|---|
| `internal/middleware/` | `internal/httpmw/` | Collides with `github.com/go-chi/chi/v5/middleware`; every file using both would need an alias. |
| `internal/http/` | `internal/httpx/` | Collides with stdlib `net/http`. |
| `internal/log/` | `internal/logx/` | Collides with stdlib `log`. |

General rule: `internal/<short-prefix>` is safer than reusing a stdlib /
popular-third-party package name.

### Byte-level Express compatibility tests

`internal/httpx/express_fixture_test.go` has 6 byte-exact cases against
real Express controller output:

- `detail.controller.js:31` — `{"data":{...}}`
- `follow.controller.js:19` — `{"data":{"following":true}}` (201)
- `follow.controller.js:59` — list `hasMore=true` with `nextPage:2`
- `follow.controller.js:59` — list `hasMore=false` with `nextPage:null`
- `follow.controller.js:8` — NOT_FOUND 404
- `subscription.controller.js:49` — VALIDATION_ERROR 400

Every P2.x endpoint should add a matching fixture so Phase 8.5 shadow
traffic diff catches drift at code-review time, not after a week of
shadow run.

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
