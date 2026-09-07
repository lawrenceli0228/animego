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


## 预告片元数据（迁移 0032）

先执行数据库迁移 0032，再部署读取新字段的 Go API。季度、完结精选、年度榜单返回可空的 trailerId / trailerSite；详情返回 trailer `{id, site}`，无有效 YouTube 预告片时省略 trailer。只存 ID 与站点，不接收任意嵌入 URL。

trailer_checked_at 是缓存内部状态，不出现在任何响应里。NULL 表示从没问过 AniList，访问详情时补齐；完整详情或季度查询明确返回 null 时记为「问过了，确实没有」并写入当时的时间。搜索等未选 trailer 的简化查询既不会清空已保存的值，也不会重新盖时间戳。用时间戳而不是布尔，是因为「哪些行该重新问一遍」（开播前没有 PV、或者当时的站点还不支持）只有时间戳能回答。

部署完成后跑一次 `POST /api/admin/warm-all?startYear=1940` 回填存量：warm-all 按季度向 AniList 取数，缺省 startYear 是 2014，不带这个参数会漏掉 2014 年之前的行。没有季度的条目（剧场版/OVA/特典）warm-all 取不到，它们在详情页第一次被访问时补齐。

验证：`CGO_ENABLED=0 go test ./internal/anime ./internal/anilist ./internal/db/...`。
真实 SQL 往返：准备 Docker 和 `animego-postgres:dev` 后，执行 `CGO_ENABLED=0 go test -tags=integration ./internal/anime -run TestTrailerPostgresRoundTrip`；测试使用新建容器并自动销毁。本机 Docker 当前未启动，此项尚未执行。


## 评分人数与评分刷新（迁移 0033）

先执行数据库迁移 0033，再部署 Go API。新增三列，都在 `anime_cache` 上：`anilist_score_votes`（AniList 的评分人数）、`anilist_rating_checked_at`、`bangumi_rating_checked_at`。

AniList 的 GraphQL 里**没有**评分人数这个标量。它有的是 `stats.scoreDistribution`——按十分档的直方图——各档 `amount` 相加才是打过分的人数，也就是 Bangumi 主题页印的「N 人评分」那个数。`popularity` 不是它：那是把作品加进列表的人数，其中大部分人没有打分，写进这一列等于用同一个字段回答另一个问题。

两个时间戳是两条独立的 sweep 各自的读取记录，不能合并成一个。AniList 那条一次请求 50 个 id（`MediaRatingsQuery` 用 `id_in`），全目录约 370 次请求；Bangumi 那条一行一次 subject 请求，走的是 `/match` 和弹幕查询共用的那个 800ms 令牌桶。两者速率预算、批量上限、失败方式都不同，任何一条都可能在另一条正常时坏掉——共用一个戳会让便宜的那条替贵的那条盖章。

节奏由 `ratingsStaleAfter`（90 天）和候选查询的 WHERE 决定：**当年及以后**的行每季度重读一次，**其余的行读一次就不再读**。后半句是有意的，也正是时间戳买来的东西——以后想给存量行也排一个更慢的周期，改的是那条 WHERE，行里已经记着各自最后一次读的时间。

两条 sweep 每小时各触发一次（`RunOnStart`）。间隔管的是**积压的排空速度**而不是刷新频率：一次 pass 只取到期的行，存量补完之后每小时那次会发现没有行可取。AniList 每次上限 2000 行（约 28 秒上游时间），Bangumi 每次上限 300 行（约 4 分钟令牌桶时间，约占该桶 7%）。共用 `ratings` 队列，`MaxWorkers` 是 2——这是队列表里唯一不是 1 的一个，理由是两个 kind 各自被自己的上游限速，谁也帮不了谁快，单槽只会让 4 分钟的 Bangumi pass 每小时挡在 30 秒的 AniList pass 前面。要临时停掉，暂停 `ratings` 队列即可，不需要发版。

⚠️ **2026-09-07 起 AniList 的公开 API 整体返回 403**（`The AniList API has been temporarily disabled due to severe stability issues.`，本机与生产源站均复现）。迁移和部署不受影响：AniList 那条 sweep 每次 pass 会把整批标记为失败并**不盖戳**，行仍留在候选集里，等 API 恢复后自动补上；Bangumi 那条不受影响，照常排空。

验证：`go test ./internal/anilist ./internal/queue`。真实 SQL 往返：`go test -tags=integration -timeout=300s ./test/integration/ -run 'Rating'`，覆盖候选 WHERE 的两种人群、`average_score` 的 COALESCE 保护、`updated_at` 的条件推进，以及 `anime_anilist_rating_pair` 约束的接受/拒绝表。
